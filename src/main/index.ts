import { app, BrowserWindow, ipcMain, nativeTheme, shell, protocol, session, clipboard } from 'electron'
import { join } from 'path'
import { START_PAGE_HTML, START_URL } from './startPage'
import {
  HISTORY_PAGE_HTML,
  SETTINGS_PAGE_HTML,
  DOWNLOADS_PAGE_HTML,
  HISTORY_URL,
  SETTINGS_URL,
  DOWNLOADS_URL
} from './internalPages'
import {
  windows,
  getState,
  getStateBySender,
  findTab,
  parentOfSenderView,
  NORMAL_PARTITION,
  INCOGNITO_PARTITION,
  type WindowState
} from './browserState'
import { applyThemeToViews } from './browserTheme'
import {
  ensureStripToken,
  removeStripToken,
  rebuildStripFromTabs,
  reorderStrip
} from './stripOrder'
import {
  createWindow as createWindowRaw,
  layoutView,
  layoutActiveView,
  toggleFullscreenMode,
  persistSessionTabs,
  snapshotSessionTabs,
  isDev,
  startWindowDrag,
  moveWindowDrag,
  endWindowDrag,
  type WindowDeps
} from './windowsManager'
import {
  createTab as createTabRaw,
  setActiveTab as setActiveTabRaw,
  closeTab as closeTabRaw,
  detachTabToNewWindow as detachTabRaw,
  cloneWindow,
  switchIncognito,
  pruneEmptyGroup,
  pushTabsState,
  type TabsDeps
} from './tabsManager'
import { openFindOverlay } from './findManager'
import { toggleDevTools, devToolsStateOf } from './devtools'
import { recordVisit, updateMetadata, getHistory, searchHistory, getTimeline, deleteVisit, deleteEntry, clearHistory } from './historyStore'
import {
  getDownloads,
  searchDownloads,
  removeDownload,
  clearDownloads,
  addDownload,
  updateDownload,
  newDownloadId,
  type DownloadEntry
} from './downloadsStore'
import { getSettings, getSettingsSync, saveSettings } from './settingsStore'
import { getShortcuts, addShortcut, removeShortcut } from './shortcutsStore'
import { createSavedGroup, getGroups } from './groupsStore'
import { registerGroupsIpc } from './groupsManager'
import { showWindowMenu } from './windowMenu'
import { registerInternalPreload } from './internalBridge'
import { dnsServersFor, applySecureDns } from './dnsConfig'
import {
  showOverlay,
  closeOverlay,
  closeOverlayIfMenu,
  closeOverlayOnTabChange,
  getActiveOverlay,
  type OverlayMenuItem
} from './overlay'
import { registerOverlayIpc } from './overlay/ipc'
import { watchPaintedOnce } from './overlay/service'
import { dumpStats as dumpOverlayStats, log } from './overlay/logger'

// Кастомная схема должна стать privileged ДО ready, иначе WebContentsView ее не отрендерит.
protocol.registerSchemesAsPrivileged([
  { scheme: 'konstruktor', privileges: { standard: true, secure: true } }
])

// Secure DNS применяется ДО ready через command-line switches.
// Читаем settings.json синхронно здесь нельзя (async store) —
// применяем сохраненное значение асинхронно при старте тоже нельзя:
// switches должны встать до инициализации net-стека. Поэтому:
// 1) при старте читаем файл напрямую синхронно, 2) UI правит через store.
import { readFileSync, existsSync } from 'fs'
try {
  const p = join(app.getPath('userData'), 'settings.json')
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { dnsMode?: string; dnsCustom?: string }
    applySecureDns(dnsServersFor(raw.dnsMode ?? 'off', raw.dnsCustom ?? ''))
  }
} catch {
  // Нет настроек — системный DNS.
}

// Связка окон и вкладок без циклов: windowsManager и tabsManager
// вызывают друг друга только через deps, index собирает их здесь.
const tabsDeps: TabsDeps = {
  layoutView,
  layoutActiveView,
  toggleFullscreenMode,
  persistSessionTabs,
  createWindow: (opts) => createWindow(opts),
  pruneEmptyGroup
}

function createTab(ws: WindowState, url = START_URL): number {
  return createTabRaw(ws, tabsDeps, url)
}

function setActiveTab(ws: WindowState, id: number): void {
  // Активный оверлей принадлежит ПРЕЖНЕЙ вкладке: его пункты (контекстное
  // меню вкладки, диалог иконки, панель поиска) рассчитаны на неё.
  // Раньше смена вкладки про оверлей ничего не знала, и меню висело уже
  // над другой страницей.
  //
  // Порядок: сначала закрыть, потом переключать. Обратный порядок отдавал
  // бы фокус не той вкладке: closeOverlay возвращает фокус ОКНУ (это его
  // работа после панели поиска и автофокуса поля), а setActiveTabRaw сразу
  // после этого отдаёт фокус VIEW новой вкладки — то есть последним
  // решением остаётся правильный. Наоборот, view не смог бы забрать
  // фокус: после closeOverlay он был бы перебит window.focus().
  if (ws.window) closeOverlayOnTabChange(ws.window, id)
  setActiveTabRaw(ws, tabsDeps, id)
}

function closeTab(ws: WindowState, id: number): void {
  closeTabRaw(ws, tabsDeps, id)
}

function detachTabToNewWindow(fromWs: WindowState, id: number, sx: number, sy: number): void {
  detachTabRaw(fromWs, tabsDeps, id, sx, sy)
}

// restoreSession пробрасывается в createWindow: «Open new window» открывает
// пустое окно и не должен подхватывать sessionTabs (общий слот на всё
// приложение) — иначе «новое» окно оказывалось бы копией чужого.
function createWindow(
  opts: { x?: number; y?: number; restoreSession?: boolean } = {}
): WindowState {
  const windowDeps: WindowDeps = { createTab, setActiveTab, pushTabsState }
  return createWindowRaw(opts, windowDeps)
}

// Загрузки: один обработчик на сессию. Файл качается через will-download,
// прогресс пишем в downloads.json — страница konstruktor://downloads
// читает через IPC и обновляется раз в секунду.
//
// Загрузки разрешены и в приватном окне: файл всё равно попадает на
// диск, и запрет был искусственным ограничением, а не требованием
// приватности. Приватность касается cookies, кэша и истории навигации.
//
// Поэтому флаг приватности ниже НЕ передаётся: setupDownloads работает
// одинаково для всех партиций, а скрытие следов загрузки — задача
// downloads:* (там приватное окно получает пустой список).
function setupDownloads(ses: Electron.Session, privateMode = false) {
  ses.on('will-download', (_e, item) => {
    // Окно-владелец загрузки — нужно, чтобы тост о загрузке всплыл
    // в том окне, где шла загрузка, а не во всех сразу.
    //
    // У will-download нет sender: событие сессионное, а не привязано к
    // webContents, и Session не сообщает свою партицию. Поэтому режим
    // передаётся флагом при регистрации обработчика, а окно ищется по
    // нему.
    //
    // Сверять окно с самой сессией обработчика нельзя: партиция ТАБКИ и
    // партиция окна-шелла разные (вкладки живут в NORMAL/INCOGNITO, окно
    // всегда в INCOGNITO — см. windowsManager), так что сравнение не
    // нашло бы ни одного окна.
    const ownerWindow = [...windows.values()].find(
      (ws) =>
        ws.incognito === privateMode &&
        ws.window &&
        !ws.window.isDestroyed()
    )?.window
    const filename = item.getFilename() || 'download'
    const id = newDownloadId()
    const savePath = join(app.getPath('downloads'), filename)
    try {
      item.setSavePath(savePath)
    } catch {
      // Путь занят — Electron сам предложит вариант.
    }
    const entry: DownloadEntry = {
      id,
      url: item.getURL(),
      filename,
      path: savePath,
      totalBytes: item.getTotalBytes(),
      receivedBytes: item.getReceivedBytes(),
      state: 'progressing',
      startedAt: Date.now(),
      endedAt: null
    }
    void addDownload(entry)
    item.on('updated', () => {
      void updateDownload(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: 'progressing'
      })
    })
    item.once('done', (_ev, state) => {
      const finalState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      void updateDownload(id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: finalState,
        endedAt: Date.now()
      }).then(() => {
        if (finalState !== 'completed') return
        // Тост шлём в то окно, где шла загрузка. Раньше он рассылался во
        // все окна, и скачивание в обычном окне всплывало тостом в
        // приватном — в другом окне и о другом действии.
        if (!ownerWindow || ownerWindow.isDestroyed()) return
        showOverlay(ownerWindow, {
          kind: 'toast',
          // anchor не задаётся: для тоста он игнорируется, положение
          // считает geometry.ts по углу рабочей области дисплея.
          anchor: { x: 0, y: 0 },
          toast: { title: 'Download complete', body: filename }
        })
      })
    })
  })
}

function registerIpc() {
  const wsOf = (e: { sender: Electron.WebContents }): WindowState => {
    const ws = getStateBySender(e.sender)
    if (!ws) throw new Error('No window for sender')
    return ws
  }

  ipcMain.handle('tabs:create', (e, url?: string) => createTab(wsOf(e), url ?? START_URL))
  ipcMain.handle('tabs:close', (e, id: number) => {
    closeTab(wsOf(e), id)
    return true
  })
  ipcMain.handle('tabs:activate', (e, id: number) => {
    setActiveTab(wsOf(e), id)
    return true
  })
  ipcMain.handle('tabs:list', (e) => {
    const ws = wsOf(e)
    return {
      tabs: ws.tabOrder.map((id) => {
        const t = ws.tabs.get(id)!
        return { id, url: t.url, title: t.customTitle ?? t.title, pinned: t.pinned, favicon: t.customFavicon ?? t.favicon, groupId: t.groupId, devToolsOpen: t.devTools?.open === true }
      }),
      activeTabId: ws.activeTabId,
      openGroups: ws.openGroups.map((g) => ({ ...g })),
      stripOrder: [...ws.stripOrder],
      pinnedStripOrder: [...ws.pinnedStripOrder]
    }
  })
  // Новый порядок вкладок после DnD в панели.
  // Старый формат (number[]) — только вкладки; новый (string[]) — токены
  // 't:<id>'/'g:<instanceId>' единого ряда. Группы того же ранга, что табы.
  ipcMain.handle('tabs:reorder', (e, order: (number | string)[]) => {
    const ws = wsOf(e)
    if (order.length > 0 && typeof order[0] === 'string') {
      reorderStrip(ws, order as string[])
    } else {
      const known = new Set(ws.tabs.keys())
      ws.tabOrder = (order as number[]).filter((id) => known.has(id))
      for (const id of known) {
        if (!ws.tabOrder.includes(id)) ws.tabOrder.push(id)
      }
      // Старый клиент без stripOrder: пересобрать ряд из tabOrder.
      rebuildStripFromTabs(ws)
    }
    pushTabsState(ws)
    return true
  })
  // Перестановка корневых групп в едином ряду панели.
  ipcMain.handle('tabs:reorder-groups', (e, order: string[]) => {
    const ws = wsOf(e)
    reorderStrip(ws, order)
    pushTabsState(ws)
    return true
  })
  ipcMain.handle('tabs:pin', (e, id: number, pinned: boolean) => {
    const ws = wsOf(e)
    const rec = ws.tabs.get(id)
    if (!rec) throw new Error(`Tab ${id} not found`)
    rec.pinned = pinned
    // Minimize не двигает вкладку между зонами — только флаг иконки.
    pushTabsState(ws)
    return true
  })
  // Дублирование вкладки: новая вкладка с тем же URL рядом с исходной.
  ipcMain.handle('tabs:duplicate', (e, id: number) => {
    const ws = wsOf(e)
    const rec = ws.tabs.get(id)
    if (!rec) throw new Error(`Tab ${id} not found`)
    const newId = createTab(ws, rec.url)
    // Ставим дубликат сразу после оригинала.
    ws.tabOrder = ws.tabOrder.filter((t) => t !== newId)
    const at = ws.tabOrder.indexOf(id)
    ws.tabOrder.splice(at + 1, 0, newId)
    // Дубликат без группы — токен рядом с оригиналом в том же ряду.
    if (!ws.tabs.get(newId)?.groupId) {
      const arr = rec.pinned ? ws.pinnedStripOrder : ws.stripOrder
      removeStripToken(ws, `t:${newId}`)
      const anchor = arr.indexOf(`t:${id}`)
      arr.splice(anchor < 0 ? arr.length : anchor + 1, 0, `t:${newId}`)
    }
    pushTabsState(ws)
    return newId
  })
  // Переименование вкладки: customTitle перекрывает page title.
  // Пустая строка сбрасывает к названию страницы.
  ipcMain.handle('tabs:rename', (e, id: number, title: string) => {
    const found = findTab(id)
    if (!found) throw new Error(`Tab ${id} not found`)
    const name = title.trim()
    found.rec.customTitle = name ? name : undefined
    pushTabsState(found.ws)
    return true
  })
  // Своя иконка вкладки: customFavicon перекрывает page favicon.
  // Принимаем URL картинки, dataURL или file:// от диалога выбора файла.
  // Пустая строка = сброс.
  ipcMain.handle('tabs:set-icon', (e, id: number, icon: string) => {
    const found = findTab(id)
    if (!found) throw new Error(`Tab ${id} not found`)
    const value = icon.trim()
    found.rec.customFavicon = value ? value : undefined
    pushTabsState(found.ws)
    return true
  })
  // DevTools веб-страницы: F12, пункт меню и хоткей из shell сюда сходятся.
  // Без id работаем с активной вкладкой — так его зовёт shell, у которого
  // активная вкладка одна. Возвращаем новое состояние: по нему меню рисует
  // галочку, а renderer знает, открылась панель или закрылась.
  ipcMain.handle('devtools:toggle', (e, id?: number) => {
    const ws = wsOf(e)
    const tabId = id ?? ws.activeTabId
    if (tabId === null) return { open: false, mode: 'right' as const }
    const state = toggleDevTools(ws, tabId)
    pushTabsState(ws)
    return state
  })
  // Состояние DevTools для отрисовки меню. Отдельный канал, а не чтение
  // tabs:list: пункт меню открывается на активной вкладке и не должен
  // перезапрашивать весь список вкладок.
  ipcMain.handle('devtools:state', (e, id?: number) => {
    const ws = wsOf(e)
    const tabId = id ?? ws.activeTabId
    if (tabId === null) return { open: false, mode: 'right' as const }
    return devToolsStateOf(ws, tabId)
  })
  // Контекстное меню вкладки: якорь — точка клика относительно окна.
  // Пункты зависят от состояния (закреплена/нет), действия — через onSelect.
  ipcMain.on('tabs:context-menu', (e, payload: { id: number; x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const rec = ws.tabs.get(payload.id)
    if (!rec) return
    const id = payload.id
    // Пункт добавления в группу — всегда: второй уровень показывает
    // открытые группы + шаблоны из закладок (закрытые откроются).
    // Remove — только для вкладки, которая реально в группе.
    const inGroup = !!rec.groupId && ws.openGroups.some((g) => g.instanceId === rec.groupId)
    const items: OverlayMenuItem[] = [
      rec.pinned
        ? { id: 'unpin', label: 'Unminimize', icon: '↔️' }
        : { id: 'pin', label: 'Minimize', icon: '🤏' },
      { id: 'duplicate', label: 'Duplicate tab', icon: '👥' },
      { id: 'add-to-group', label: 'Add to group', icon: '📁' },
      ...(inGroup ? [{ id: 'remove-from-group', label: 'Remove from group', icon: '📂' }] : []),
      { id: 'rename', label: 'Rename tab', icon: '✏️' },
      { id: 'set-icon', label: 'Change icon', icon: '🖼️' },
      { id: 'copy-url', label: 'Copy URL', icon: '🔗' },
      { id: 'reload', label: 'Reload', icon: '🔄' },
      { id: 'close', label: 'Close tab', icon: '✕' }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
      items,
      align: 'start',
      onSelect: (action) => {
        const target = findTab(id)
        if (!target) return
        const { ws: tws, rec: trec } = target
        if (action === 'pin' || action === 'unpin') {
          trec.pinned = action === 'pin'
          pushTabsState(tws)
        } else if (action === 'duplicate') {
          const newId = createTab(tws, trec.url)
          tws.tabOrder = tws.tabOrder.filter((t) => t !== newId)
          const at = tws.tabOrder.indexOf(id)
          tws.tabOrder.splice(at + 1, 0, newId)
          pushTabsState(tws)
        } else if (action === 'copy-url') {
          clipboard.writeText(trec.url)
        } else if (action === 'reload') {
          trec.view.webContents.reload()
        } else if (action === 'close') {
          closeTab(tws, id)
        } else if (action === 'add-to-group' || action === 'remove-from-group') {
          // Выбор группы — второй уровень меню: открытые экземпляры
          // + шаблоны из закладок (закрытый шаблон откроется и примет вкладку).
          const parent = tws.window
          if (!parent) return
          if (action === 'remove-from-group') {
            const old = trec.groupId
            trec.groupId = undefined
            if (old) {
              pruneEmptyGroup(tws, old)
              removeStripToken(tws, `t:${id}`)
              ensureStripToken(tws, `t:${id}`, trec.pinned)
            }
            pushTabsState(tws)
            return
          }
          void getGroups().then((saved) => {
            const live = findTab(id)
            if (!live) return
            // Все открытые корневые экземпляры (как на панели вкладок)
            // + закрепленные шаблоны из закладок, даже закрытые.
            // Иконка/название/цвет — как задано в шаблоне.
            const byId = new Map(saved.map((g) => [g.id, g]))
            const seen = new Set<string>()
            const targets: OverlayMenuItem[] = []
            for (const g of live.ws.openGroups) {
              if (g.parentInstanceId || seen.has(g.savedId)) continue
              const s = byId.get(g.savedId)
              if (!s) continue
              seen.add(g.savedId)
              targets.push({
                id: g.instanceId,
                label: s.name,
                icon: s.icon?.startsWith('emoji:') ? s.icon.replace(/^emoji:/, '') : s.icon || '📁',
                color: s.color
              })
            }
            for (const g of saved) {
              if (!g.pinned || seen.has(g.id)) continue
              seen.add(g.id)
              targets.push({
                id: `saved:${g.id}`,
                label: `${g.name} (closed)`,
                icon: g.icon?.startsWith('emoji:') ? g.icon.replace(/^emoji:/, '') : g.icon || '📁',
                color: g.color
              })
            }
            if (targets.length === 0) return
            showOverlay(parent, {
              kind: 'menu',
              anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
              items: targets,
              align: 'start',
              onSelect: (targetId) => {
                const cur = findTab(id)
                if (!cur) return
                // Закрытый шаблон: открываем экземпляр, вкладка — первой.
                if (targetId.startsWith('saved:')) {
                  const savedId = targetId.slice('saved:'.length)
                  void getGroups().then((fresh) => {
                    const s = fresh.find((g) => g.id === savedId)
                    const l2 = findTab(id)?.ws
                    if (!s || !l2) return
                    const nid = `i${Date.now()}${Math.floor(Math.random() * 1000)}`
                    l2.openGroups.push({ instanceId: nid, savedId: s.id, collapsed: false, pinned: false })
                    ensureStripToken(l2, `g:${nid}`, false)
                    const old = cur.rec.groupId
                    cur.rec.groupId = nid
                    removeStripToken(l2, `t:${id}`)
                    l2.tabOrder = l2.tabOrder.filter((t) => t !== id)
                    l2.tabOrder.push(id)
                    if (old) pruneEmptyGroup(l2, old)
                    pushTabsState(l2)
                  })
                  return
                }
                const old = cur.rec.groupId
                cur.rec.groupId = targetId
                removeStripToken(cur.ws, `t:${id}`)
                cur.ws.tabOrder = cur.ws.tabOrder.filter((t) => t !== id)
                let at = cur.ws.tabOrder.length
                for (let i = cur.ws.tabOrder.length - 1; i >= 0; i--) {
                  if (cur.ws.tabs.get(cur.ws.tabOrder[i])?.groupId === targetId) {
                    at = i + 1
                    break
                  }
                }
                cur.ws.tabOrder.splice(at, 0, id)
                if (old) pruneEmptyGroup(cur.ws, old)
                pushTabsState(cur.ws)
              }
            })
          })
        } else if (action === 'rename') {
          // Переименование — инлайн в самой вкладке (TabStrip),
          // без отдельных окон: шлем событие в renderer.
          tws.window?.webContents.send('tabs:tab-action', { id, action })
        } else if (action === 'set-icon') {
          // Общий диалог иконки: URL, файл, emoji + отмена, верификация в main.
          const parent = tws.window
          if (!parent) return
          showOverlay(parent, {
            kind: 'icon',
            anchor: { x: 0, y: 0 },
            icon: {
              title: 'Tab icon',
              placeholder: 'URL, file path or emoji (empty resets)',
              initial: trec.customFavicon ?? ''
            },
            onIconApply: (icon) => {
              const live = findTab(id)
              if (!live) return
              // Пустой ввод = сброс к иконке сайта.
              live.rec.customFavicon = icon ? icon : undefined
              pushTabsState(live.ws)
            }
          })
        }
      }
    })
  })
  // Контекстное меню самой панели вкладок (мимо вкладок):
  // создать вкладку, создать группу, закрыть все вкладки окна.
  ipcMain.on('tabs:strip-context-menu', (e, payload: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const items: OverlayMenuItem[] = [
      { id: 'new-tab', label: 'New tab', icon: '＋' },
      { id: 'new-group', label: 'New group', icon: '📁' },
      { id: 'close-all', label: 'Close group', icon: '✕' }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(payload.x), y: Math.round(payload.y) },
      items,
      align: 'start',
      onSelect: (action) => {
        const live = win && !win.isDestroyed() ? getState(win) : undefined
        if (!live) return
        if (action === 'new-tab') {
          createTab(live)
        } else if (action === 'new-group') {
          // Новая группа = шаблон + экземпляр с 1 вкладкой (минимум).
          // createTab кладет токен в ряд, но вкладка сразу уходит в группу —
          // чистим токен вкладки и кладем токен группы, иначе группа не видна.
          void createSavedGroup({ name: 'Group', urls: [START_URL] }).then((saved) => {
            const l2 = win && !win.isDestroyed() ? getState(win) : undefined
            if (!l2) return
            const instanceId = `i${Date.now()}${Math.floor(Math.random() * 1000)}`
            l2.openGroups.push({ instanceId, savedId: saved.id, collapsed: false, pinned: false })
            ensureStripToken(l2, `g:${instanceId}`, false)
            const id = createTab(l2, START_URL)
            l2.tabs.get(id)!.groupId = instanceId
            removeStripToken(l2, `t:${id}`)
            pushTabsState(l2)
          })
        } else if (action === 'close-all') {
          // Закрываем по копии порядка: closeTab мутирует tabOrder.
          for (const id of [...live.tabOrder]) closeTab(live, id)
        }
      }
    })
  })
  // Переключение приватности ТЕКУЩЕГО окна. Отдельного приватного окна
  // больше нет: пункт меняет режим этого окна, и все его вкладки
  // переоткрываются в другой партиции (см. switchIncognito).
  //
  // Возврат true означает, что режим переключился и окно надо
  // перерисовать; false — переключения не было (окно уже в нужном
  // режиме или разрушено).
  ipcMain.handle('window:incognito', (e) => {
    const ws = wsOf(e)
    const to = !ws.incognito
    switchIncognito(ws, tabsDeps, to)
    return to
  })
  // Группы вкладок: шаблоны в groups.json + открытые экземпляры в WindowState.
  registerGroupsIpc(wsOf, { createTab, closeTab, setActiveTab, pushTabsState, pruneEmptyGroup })
  // Внутренние страницы в активной вкладке текущего окна.
  ipcMain.handle('tabs:open-history', (e) => {
    const ws = wsOf(e)
    const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec) void rec.view.webContents.loadURL(HISTORY_URL)
    else createTab(ws, HISTORY_URL)
    return true
  })
  ipcMain.handle('tabs:open-settings', (e) => {
    const ws = wsOf(e)
    const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec) void rec.view.webContents.loadURL(SETTINGS_URL)
    else createTab(ws, SETTINGS_URL)
    return true
  })
  ipcMain.handle('tabs:open-downloads', (e) => {
    const ws = wsOf(e)
    const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec) void rec.view.webContents.loadURL(DOWNLOADS_URL)
    else createTab(ws, DOWNLOADS_URL)
    return true
  })
  // Загрузки: список/поиск/удаление/открытие файла. Инкогнито читает общий список.
  // История: чтение/поиск/удаление. Инкогнито-окнам отдаем пусто.
  ipcMain.handle('history:list', async (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getHistory(limit ?? 200)
  })
  ipcMain.handle('history:search', async (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchHistory(query, limit ?? 50)
  })
  ipcMain.handle('history:delete', async (e, url: string) => {
    if (wsOf(e).incognito) return false
    await deleteEntry(url)
    return true
  })
  ipcMain.handle('history:timeline', async (e, query?: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getTimeline(query ?? '', limit ?? 2000)
  })
  ipcMain.handle('history:delete-visit', async (e, url: string, at: number) => {
    if (wsOf(e).incognito) return false
    await deleteVisit(url, at)
    return true
  })
  ipcMain.handle('history:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearHistory()
    return true
  })
  ipcMain.handle('downloads:list', (e, limit?: number) => {
    if (wsOf(e).incognito) return []
    return getDownloads(limit ?? 200)
  })
  ipcMain.handle('downloads:search', (e, query: string, limit?: number) => {
    if (wsOf(e).incognito) return []
    return searchDownloads(query, limit ?? 100)
  })
  // remove/clear/open тоже закрыты: инкогнито видело пустой список, но
  // могло удалить или открыть чужую запись по id из основного окна.
  ipcMain.handle('downloads:remove', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    await removeDownload(id)
    return true
  })
  ipcMain.handle('downloads:clear', async (e) => {
    if (wsOf(e).incognito) return false
    await clearDownloads()
    return true
  })
  ipcMain.handle('downloads:open', async (e, id: string) => {
    if (wsOf(e).incognito) return false
    const list = await getDownloads(200)
    const found = list.find((d) => d.id === id)
    if (!found) return false
    try {
      const res = await shell.openPath(found.path)
      return res === ''
    } catch {
      return false
    }
  })
  // Системная иконка файла через Electron app.getFileIcon.
  // Возвращает dataURL PNG; пустая строка = fallback на эмодзи по расширению.
  ipcMain.handle('downloads:icon', async (_e, id: string) => {
    const list = await getDownloads(200)
    const found = list.find((d) => d.id === id)
    if (!found) return ''
    try {
      const icon = await app.getFileIcon(found.path, { size: 'normal' })
      if (icon.isEmpty()) return ''
      return icon.toDataURL()
    } catch {
      return ''
    }
  })
  // Настройки браузера.
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle(
    'settings:save',
    async (
      e,
      patch: {
        searchEngine?: string
        homepage?: string
        devtools?: boolean
        dnsMode?: string
        dnsCustom?: string
        locale?: string
        animations?: boolean
        theme?: string
        roundedCorners?: boolean
        fullscreenMode?: string
        rememberBounds?: boolean
        rememberTabs?: boolean
      }
    ) => {
      const next = await saveSettings(patch)
      // Shell перечитывает тему/скругление без перезагрузки: пуш во все окна.
      // Смена сценария F11 сбрасывает контентный fullscreen: view возвращается
      // в обычные bounds, иначе окно останется в рассинхроне с настройкой.
      // Смена темы обновляет color-scheme открытых сайтов (см. applyThemeToViews).
      if (
        patch.theme !== undefined ||
        patch.roundedCorners !== undefined ||
        patch.fullscreenMode !== undefined
      ) {
        for (const ws of windows.values()) {
          if (patch.fullscreenMode !== undefined && ws.contentFullscreen) {
            ws.contentFullscreen = false
            layoutActiveView(ws)
            ws.window?.webContents.send('window:content-fullscreen', false)
          }
          ws.window?.webContents.send('settings:changed')
        }
        if (patch.theme !== undefined) applyThemeToViews(next.theme)
      }
      void e
      return next
    }
  )
  // Ручное перетаскивание окна вместо -webkit-app-region: drag.
  //
  // sendSync, а не invoke: ответ нужен СИНХРОННО, до первого mousemove,
  // иначе окно дёрнется на первом кадре — invoke возвращается через
  // event loop, то есть уже после того, как renderer успел отправить
  // cursor-move. На двойном клике возвращаем false: системный разворот
  // обрабатывается renderer-ом отдельно.
  ipcMain.on('window:drag-start', (e, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ok = win ? startWindowDrag(win, x, y) : false
    e.returnValue = ok
  })
  ipcMain.on('window:drag-move', (e, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) moveWindowDrag(x, y)
  })
  ipcMain.on('window:drag-end', () => {
    endWindowDrag()
  })
  // ПКМ по кнопкам навигации: своё меню окна вместо системного.
  // Координаты — относительно content-области, как у всех меню оверлея.
  ipcMain.on('window:context-menu', (e, payload: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    showWindowMenu(win, { x: payload.x, y: payload.y }, {
      // restoreSession: false — иначе sessionTabs (общий слот на всё
      // приложение) подставил бы сюда вкладки какого-то другого окна,
      // и «новое окно» оказалось бы копией.
      newWindow: () => {
        createWindow({ restoreSession: false })
      },
      // Клон создаёт окно и кладёт вкладки сам (cloneWindow), поэтому
      // restoreSession тут не нужен: сессия прочитана не будет, так как
      // вкладки к моменту did-finish-load уже есть.
      cloneWindow: () => {
        cloneWindow(ws, tabsDeps)
      }
    })
  })
  // Кнопки кастомного заголовка: свернуть / развернуть / закрыть.
  ipcMain.handle('window:minimize', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
    return true
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
    return true
  })
  ipcMain.handle('window:is-maximized', (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })
  // F11 из фокуса shell: тоггл сценария из настроек вручную.
  ipcMain.handle('window:toggle-fullscreen', (e) => {
    const ws = getStateBySender(e.sender)
    if (!ws) return false
    return toggleFullscreenMode(ws)
  })
  // Плитки табло стартовой страницы.
  ipcMain.handle('shortcuts:list', () => getShortcuts())
  ipcMain.handle('shortcuts:add', (_e, input: { name?: string; url: string }) =>
    addShortcut(input)
  )
  ipcMain.handle('shortcuts:remove', (_e, url: string) => removeShortcut(url))
  // Вынос вкладки за окно — новое окно браузера с этой вкладкой.
  ipcMain.handle('tabs:detach', (e, id: number, pos: { x: number; y: number }) => {
    detachTabToNewWindow(wsOf(e), id, pos.x, pos.y)
    return true
  })
  // Слияние: перетащить вкладку из другого окна на панель этого.
  // View переезжает целиком, история и состояние сохраняются.
  // Смешивать режимы нельзя: incognito <-> normal attach запрещен.
  ipcMain.handle('tabs:attach', (e, id: number) => {
    const target = wsOf(e)
    const found = findTab(id)
    if (!found || !target.window) return false
    if (found.ws === target) return true
    if (found.ws.incognito !== target.incognito) return false
    const fromWs = found.ws
    const rec = found.rec
    fromWs.window?.contentView.removeChildView(rec.view)
    fromWs.tabs.delete(id)
    fromWs.tabOrder = fromWs.tabOrder.filter((t) => t !== id)
    if (!rec.groupId) removeStripToken(fromWs, `t:${id}`)
    if (fromWs.activeTabId === id) {
      fromWs.activeTabId = null
      if (fromWs.tabOrder.length > 0) {
        setActiveTab(fromWs, fromWs.tabOrder[fromWs.tabOrder.length - 1])
      } else {
        pushTabsState(fromWs)
      }
    } else {
      pushTabsState(fromWs)
    }
    // Окно-донор без вкладок закрываем, как в Chrome.
    if (fromWs.tabs.size === 0) fromWs.window?.close()

    target.tabs.set(id, rec)
    target.tabOrder.push(id)
    // Вкладка всегда в обычном ряду: minimize зону не меняет,
    // pinnedStripOrder — только для групп (иначе таб потеряется).
    if (!rec.groupId) ensureStripToken(target, `t:${id}`, false)
    target.window.contentView.addChildView(rec.view)
    setActiveTab(target, id)
    return true
  })
  ipcMain.handle('tabs:navigate', async (_e, id: number, rawUrl: string) => {
    const found = findTab(id)
    if (!found) throw new Error(`Tab ${id} not found`)
    const rec = found.rec
    let target = rawUrl.trim()
    // Внутренние страницы оставляем как есть.
    if (/^konstruktor:/.test(target)) {
      await rec.view.webContents.loadURL(target)
      return true
    }
    // Если схемы нет — считаем https. Если не похоже на URL — поисковик из настроек.
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(target)) target = 'https://' + target
      else {
        const { searchEngine } = await getSettings()
        target = searchEngine.replace('%s', encodeURIComponent(rawUrl))
      }
    }
    await rec.view.webContents.loadURL(target)
    return true
  })
  ipcMain.handle('tabs:back', (e) => {
    const ws = getStateBySender(e.sender)
    const rec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec?.view.webContents.navigationHistory.canGoBack()) {
      rec.view.webContents.navigationHistory.goBack()
      return true
    }
    return false
  })
  ipcMain.handle('tabs:forward', (e) => {
    const ws = getStateBySender(e.sender)
    const rec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec?.view.webContents.navigationHistory.canGoForward()) {
      rec.view.webContents.navigationHistory.goForward()
      return true
    }
    return false
  })
  ipcMain.handle('tabs:reload', (e) => {
    const ws = getStateBySender(e.sender)
    const rec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    rec?.view.webContents.reload()
    return true
  })
  ipcMain.on('layout:update', (e, insets) => {
    const ws = getStateBySender(e.sender)
    if (!ws) return
    ws.uiInsets = { ...ws.uiInsets, ...insets }
    layoutActiveView(ws)
  })
  // Меню браузера: DOM-оверлей в прозрачном окне поверх всего,
  // включая WebContentsView. Системный Menu.popup не используем:
  // на Windows он всегда светлый и не стилизуется.
  // Renderer шлет якорь ПРАВОГО НИЖНЕГО угла кнопки относительно
  // content-области окна. Оверлей позиционируется в overlay/service.
  ipcMain.on('menu:popup', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws) return
    const openPage = (url: string) => {
      // Внутреннюю страницу открываем в активной вкладке.
      const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
      if (rec) void rec.view.webContents.loadURL(url)
      else createTab(ws, url)
    }
    const items: OverlayMenuItem[] = [
      { id: 'downloads', label: 'Downloads', icon: '📥' },
      { id: 'history', label: 'History', icon: '🕘' },
      { id: 'settings', label: 'Settings', icon: '🛠️' },
      // DevTools активной вкладки. Состояние читаем при открытии меню:
      // панель могли закрыть крестиком в самом DevTools, и подпись пункта
      // обязана это отражать.
      {
        id: 'devtools',
        label: devToolsStateOf(ws, ws.activeTabId ?? -1).open
          ? 'Close DevTools'
          : 'Open DevTools',
        icon: '🛠'
      },
      // Заглушки: разделы в разработке, пункты неактивны.
      { id: 'profile', label: 'Profile', icon: '👤', disabled: true },
      { id: 'extensions', label: 'Extensions', icon: '🧩', disabled: true },
      { id: 'debug', label: 'Debug', icon: '🐞', disabled: true },
      // Пункт виден всегда: он переключает режим ТЕКУЩЕГО окна, а не
      // создаёт новое. В приватном окне он предлагает обратный переход,
      // поэтому скрывать его было бы неверно.
      {
        id: 'incognito',
        label: ws.incognito ? 'Switch to normal mode' : 'Switch to incognito mode',
        icon: '🕵️'
      }
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      items,
      // Второй клик по кнопке ☰ закрывает открытое ею же меню.
      toggleKey: 'browser-menu',
      onSelect: (id) => {
        if (id === 'downloads') openPage(DOWNLOADS_URL)
        else if (id === 'history') openPage(HISTORY_URL)
        else if (id === 'settings') openPage(SETTINGS_URL)
        else if (id === 'devtools') {
          // Меню закрываем ДО открытия панели: оверлей лежит поверх view,
          // и докнутые DevTools перерисовали бы его область. Плюс панель
          // забирает фокус, а меню его держит — оставить открытым значило бы
          // оставить окно без фокуса.
          closeOverlay(win)
          if (ws.activeTabId !== null) {
            toggleDevTools(ws, ws.activeTabId)
            pushTabsState(ws)
          }
        } else if (id === 'incognito') {
          // Переключение переоткрывает вкладки, поэтому активный оверлей
          // (меню, открытый поверх вкладок) закрываем заранее: его
          // содержимое сейчас станет неактуальным.
          closeOverlay(win)
          switchIncognito(ws, tabsDeps, !ws.incognito)
        }
      }
    })
  })
  // Клик по shell или по странице мимо открытого меню. Меню живёт в
  // отдельном окне, само оно клик не видит. Закрываем ТОЛЬКО меню:
  // диалоги (icon/dialog) и панель поиска имеют свою логику закрытия
  // и не должны реагировать на клик мимо.
  //
  // Sender бывает двух видов: webContents самого окна (клик по shell) и
  // webContents WebContentsView (клик по странице) — у второго
  // BrowserWindow.fromWebContents вернёт undefined, окно ищем по вкладкам.
  //
  // source различаем для диагностики: какой именно renderer прислал
  // гашение. Без этого нельзя понять, эхо это или настоящий клик.
  ipcMain.on('menu:dismiss-on-shell-click', (e, source?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? parentOfSenderView(e.sender)
    const fromView = !BrowserWindow.fromWebContents(e.sender)
    log('command', 'shell click', {
      source: source ?? (fromView ? 'view' : 'shell'),
      hasWindow: !!win
    })
    if (win) closeOverlayIfMenu(win)
  })
  // Оверлейные каналы (overlay:*, find:*) зарегистрированы в
  // Оверлейные каналы вынесены в overlay/ipc.ts. Здесь остались только каналы
  // приложения: вкладки, история, загрузки, настройки, окна, ярлыки.
  registerOverlayIpc()
  // Учёт подтверждений отрисовки оверлея. Слушатель должен стоять ДО
  // первого показа: иначе подтверждение, пришедшее между отправкой push
  // и подпиской ожидания, улетело бы в пустоту, и показ завершился бы
  // аварийным гашением по таймауту.
  watchPaintedOnce()
}

void app.whenReady().then(() => {
  // Внутренние страницы: один хендл на схему, роутинг по host.
  // protocol.handle привязан к сессии — регистрируем на всех трех,
  // иначе view с persist-партицией не резолвит konstruktor://*.
  const handleInternal = (ses: Electron.Session) => {
    try {
      ses.protocol.handle('konstruktor', (req) => {
        const host = new URL(req.url).host
        if (host === 'start') {
          return new Response(START_PAGE_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
        }
        if (host === 'history') {
          return new Response(HISTORY_PAGE_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
        }
        if (host === 'settings') {
          return new Response(SETTINGS_PAGE_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
        }
        if (host === 'downloads') {
          return new Response(DOWNLOADS_PAGE_HTML, {
            headers: { 'content-type': 'text/html; charset=utf-8' }
          })
        }
        return new Response('Not found', { status: 404 })
      })
    } catch {
      // Хендл уже зарегистрирован для этой сессии — игнорим.
    }
  }
  handleInternal(session.defaultSession)
  handleInternal(session.fromPartition(NORMAL_PARTITION))
  handleInternal(session.fromPartition(INCOGNITO_PARTITION))
  // Preload внутренних страниц на все партиции: window.konstruktor
  // доступен в каждом фрейме до загрузки документа.
  registerInternalPreload(session.defaultSession)
  registerInternalPreload(session.fromPartition(NORMAL_PARTITION))
  registerInternalPreload(session.fromPartition(INCOGNITO_PARTITION))
  setupDownloads(session.defaultSession)
  setupDownloads(session.fromPartition(NORMAL_PARTITION))
  // Приватная партиция вкладок: загрузки идут и сохраняются как обычно
  // (приватность касается cookies и истории), но тост о загрузке
  // показывается только в приватном окне.
  setupDownloads(session.fromPartition(INCOGNITO_PARTITION), true)
  registerIpc()
  // Системная тема ОС: nativeTheme следит сам и шлет обновления —
  // пересчитываем color-scheme сайтов при смене темы ОС.
  nativeTheme.on('updated', () => {
    void getSettings()
      .then((s) => {
        if ((s.theme ?? 'dark') === 'system') applyThemeToViews('system')
      })
      .catch(() => undefined)
  })
  // ДИАГНОСТИКА: автооткрытие меню через N мс после старта. Нужно, чтобы
  // попасть в окно задержки загрузки страницы (OVERLAY_PAGE_LOAD_DELAY_MS)
  // без ручной гонки мышью. Значение 0 или пусто — выключено.
  //
  // Окно берём из возврата createWindow, а не из getAllWindows()[0]:
  // в списке первым может оказаться оверлей, у которого contentBounds
  // 1x1 и координаты за экраном — меню уехало бы в -259,-99.
  const bootState = createWindow()
  const autoOpenAt = Number(process.env['OVERLAY_AUTO_OPEN_MS'] ?? '0') || 0
  if (autoOpenAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      log('lifecycle', 'auto-opening menu', { afterMs: autoOpenAt })
      showOverlay(win, {
        kind: 'menu',
        anchor: { x: 400, y: 300 },
        items: [
          { id: 'auto-1', label: 'Auto item 1', icon: '📥' },
          { id: 'auto-2', label: 'Auto item 2', icon: '🕘' }
        ],
        onSelect: () => undefined
      })
    }, autoOpenAt)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // Диагностика фокуса и ввода. Отдельный флаг, НЕ входит в обычный
  // OVERLAY_DEBUG: логирует каждую нажатую клавишу, поэтому в обычном
  // режиме это слишком шумно. Включать точечно, при разборе ввода.
  //
  // Что показывает:
  //   focus  — у какого окна фокус и кто из webContents его держит. Нужно,
  //            потому что окно может сообщать isFocused() === true и при
  //            этом не получать клавиатуру: WM отдал фокус окну, а
  //            конвейер ввода Chromium не активирован.
  //   key    — приход ЛЮБОЙ клавиши в каждый webContents процесса,
  //            включая view вкладок. Пробел, на котором спотыкались
  //            прежние замеры: вкладка — это WebContentsView, и её
  //            webContents НЕ входит в BrowserWindow.getAllWindows(),
  //            так что подписка только на окна показывает ложное
  //            «ввода нет».
  if (process.env['OVERLAY_FOCUS_DEBUG']) {
    const watched = new Set<string>()
    const watch = (wc: Electron.WebContents, tag: string): void => {
      const key = wc.id + ':' + tag
      if (watched.has(key)) return
      watched.add(key)
      wc.on('before-input-event', (_e, input) => {
        if (input.type !== 'keyDown') return
        log('lifecycle', 'focus: key', {
          where: tag,
          key: input.key,
          code: input.code,
          ctrl: input.control,
          meta: input.meta,
          wcFocused: wc.isFocused()
        })
      })
    }
    const sweep = (): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue
        watch(w.webContents, 'window:' + w.id)
        // View вкладок — вложенные WebContentsView, их нет в
        // getAllWindows(), но клавиатуру принимают они.
        try {
          for (const child of w.contentView.children) {
            // View — базовый тип, webContents есть не у всех потомков.
            const wc = (child as { webContents?: Electron.WebContents }).webContents
            if (wc) watch(wc, 'view-under:' + w.id)
          }
        } catch {
          // Обход дерева view не критичен для диагностики.
        }
      }
    }
    sweep()
    setInterval(sweep, 500)
    setInterval(() => {
      const focused = BrowserWindow.getFocusedWindow()
      log('lifecycle', 'focus: owner', {
        focusedId: focused ? focused.id : null,
        windows: BrowserWindow.getAllWindows()
          .map((w) => (w.isDestroyed() ? 'dead' : String(w.isFocused())))
          .join(',')
      })
    }, 1000)
  }

  // ДИАГНОСТИКА: два открытия панели поиска подряд, второе — сразу после
  // закрытия первой и БЕЗ клика по веб-странице. Раньше такой сценарий
  // не работал: после закрытия фокус оставался в прозрачном окне оверлея,
  // Ctrl+F уходил в его webContents, и панель не открывалась до клика по
  // странице. Значение 0 или пусто — выключено.
  const findCycleAt = Number(process.env['OVERLAY_FIND_CYCLE_MS'] ?? '0') || 0
  if (findCycleAt > 0) {
    setTimeout(() => {
      const win = bootState.window
      if (!win || win.isDestroyed()) return
      log('lifecycle', 'find cycle: opening #1', {})
      const ws1 = getState(win)
      if (ws1) openFindOverlay(ws1)
      setTimeout(() => {
        if (win.isDestroyed()) return
        log('lifecycle', 'find cycle: closing #1', {})
        closeOverlay(win)
        setTimeout(() => {
          if (win.isDestroyed()) return
          // Клика по странице здесь нет намеренно: проверяем, что фокус
          // вернулся сам и второй вызов проходит без участия пользователя.
          log('lifecycle', 'find cycle: opening #2 (no page click)', {})
          const ws = getState(win)
          log('lifecycle', 'find cycle: parent focused before #2', {
            focused: win.isFocused()
          })
          if (ws) openFindOverlay(ws)
          const ov = getActiveOverlay(win)
          log('lifecycle', 'find cycle: #2 result', {
            opened: !!ov && !ov.isDestroyed()
          })
        }, 400)
      }, 700)
    }, findCycleAt)
  }
  // Сводка по времени открытия оверлеев раз в 5 минут (OVERLAY_DEBUG != silent).
  setInterval(() => dumpOverlayStats(), 5 * 60 * 1000)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
