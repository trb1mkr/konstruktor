import { app, BrowserWindow, WebContentsView, ipcMain, nativeTheme, shell, protocol, session, clipboard } from 'electron'
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
  allocTabId,
  getState,
  getStateBySender,
  findTab,
  NORMAL_PARTITION,
  INCOGNITO_PARTITION,
  type WindowState,
  type TabRecord
} from './browserState'
import { applyThemeToViews, applyThemeToTab, viewBackgroundFor } from './browserTheme'
import {
  openFindOverlay,
  queryFind,
  nextFind,
  prevFind,
  closeFind
} from './findManager'
import { buildFoundCounterScript } from './findScripts'
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
import { registerInternalPreload } from './internalBridge'
import { dnsServersFor, applySecureDns } from './dnsConfig'
import {
  showOverlay,
  closeOverlay,
  getActiveOverlay,
  resolveOverlaySelect,
  resolveOverlayDismiss,
  resolveOverlaySubmit,
  resolveOverlaySubmitIcon,
  type OverlayMenuItem
} from './overlayManager'

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

// NOTE: dev = не упакованное приложение.
const isDev = !app.isPackaged

// Синхронное чтение settings.json напрямую с диска.
// Нужно в createWindow: кэш settingsStore еще пуст на момент первого окна,
// а асинхронный load() задержал бы создание окна. Возвращает частичные
// настройки поверх дефолтов — отсутствующие поля добирает store при load().
function readSettingsFileSync(): {
  rememberBounds?: boolean
  rememberTabs?: boolean
  windowBounds?: { x: number; y: number; width: number; height: number }
  windowMaximized?: boolean
  sessionTabs?: { url: string; active: boolean }[]
} {
  try {
    const p = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as {
      rememberBounds?: boolean
      rememberTabs?: boolean
      windowBounds?: { x: number; y: number; width: number; height: number }
      windowMaximized?: boolean
      sessionTabs?: { url: string; active: boolean }[]
    }
  } catch {
    return {}
  }
}

// Единый ряд панели вкладок: токены 't:<id>' и 'g:<instanceId>'.
// Группы того же ранга, что вкладки: таб и группа чередуются свободно.
// Закрепленные живут в pinnedStripOrder, обычные — в stripOrder.
// Вложенные группы (parentInstanceId) в ряд не входят — рисуются внутри родителя.
function rootGroupIds(ws: WindowState): string[] {
  return ws.openGroups.filter((g) => !g.parentInstanceId).map((g) => g.instanceId)
}

function isGroupPinned(ws: WindowState, instanceId: string): boolean {
  return ws.openGroups.find((g) => g.instanceId === instanceId)?.pinned ?? false
}

// Добавить токен в конец нужной зоны, если его там еще нет.
function ensureStripToken(ws: WindowState, token: string, pinned: boolean): void {
  const arr = pinned ? ws.pinnedStripOrder : ws.stripOrder
  if (!arr.includes(token)) arr.push(token)
}

// Убрать токен из обоих рядов (смена зоны/удаление).
function removeStripToken(ws: WindowState, token: string): void {
  ws.stripOrder = ws.stripOrder.filter((t) => t !== token)
  ws.pinnedStripOrder = ws.pinnedStripOrder.filter((t) => t !== token)
}

// Переместить токен в нужную зону с сохранением относительного порядка.
function moveStripToken(ws: WindowState, token: string, pinned: boolean): void {
  removeStripToken(ws, token)
  ensureStripToken(ws, token, pinned)
}

// Пересобрать ряды из текущего состояния: сначала пины, потом обычные.
// Minimize не двигает вкладку: свернутые живут в общем ряду на своём месте.
// pinnedStripOrder — только закрепленные группы, stripOrder — все вкладки + обычные группы.
function rebuildStripFromTabs(ws: WindowState): void {
  const pinnedTabs: number[] = []
  const normalTabs = ws.tabOrder.filter((id) => {
    const t = ws.tabs.get(id)
    return t && !t.groupId
  })
  const pinnedGroups = rootGroupIds(ws).filter((gid) => isGroupPinned(ws, gid))
  const normalGroups = rootGroupIds(ws).filter((gid) => !isGroupPinned(ws, gid))
  // Сохраняем существующий относительный порядок токенов, добавляем новые в конец.
  const keepOrder = (old: string[], fresh: string[]): string[] => {
    const set = new Set(fresh)
    const kept = old.filter((t) => set.has(t))
    for (const t of fresh) if (!kept.includes(t)) kept.push(t)
    return kept
  }
  ws.pinnedStripOrder = keepOrder(ws.pinnedStripOrder, [
    ...pinnedTabs.map((id) => `t:${id}`),
    ...pinnedGroups.map((gid) => `g:${gid}`)
  ])
  ws.stripOrder = keepOrder(ws.stripOrder, [
    ...normalTabs.map((id) => `t:${id}`),
    ...normalGroups.map((gid) => `g:${gid}`)
  ])
}

  // Применить порядок единого ряда от renderer после DnD.
// Minimize не двигает вкладку: все вкладки живут в обычном ряду на своём месте.
// Пины — только для групп. Неизвестные токены отбрасываются, недостающие дописываются в конец.
function reorderStrip(ws: WindowState, order: string[]): void {
  const knownTabs = new Set(
    ws.tabOrder.filter((id) => {
      const t = ws.tabs.get(id)
      return t && !t.groupId
    }).map((id) => `t:${id}`)
  )
  const knownGroups = new Set(rootGroupIds(ws).map((gid) => `g:${gid}`))
  const pinned: string[] = []
  const normal: string[] = []
  for (const tok of order) {
    if (tok.startsWith('t:')) {
      if (!knownTabs.has(tok)) continue
      const id = Number(tok.slice(2))
      const rec = ws.tabs.get(id)
      if (!rec) continue
      // Вкладки всегда в обычном ряду, minimize на зону не влияет.
      if (!normal.includes(tok)) normal.push(tok)
    } else if (tok.startsWith('g:')) {
      if (!knownGroups.has(tok)) continue
      const gid = tok.slice(2)
      if (isGroupPinned(ws, gid)) { if (!pinned.includes(tok)) pinned.push(tok) }
      else { if (!normal.includes(tok)) normal.push(tok) }
    }
  }
  // Недостающие — в конец своей зоны: вкладки всегда в обычный ряд.
  for (const id of ws.tabOrder) {
    const t = ws.tabs.get(id)
    if (!t || t.groupId) continue
    const tok = `t:${id}`
    if (!pinned.includes(tok) && !normal.includes(tok)) normal.push(tok)
  }
  for (const gid of rootGroupIds(ws)) {
    const tok = `g:${gid}`
    if (isGroupPinned(ws, gid) && !pinned.includes(tok)) pinned.push(tok)
    if (!isGroupPinned(ws, gid) && !normal.includes(tok)) normal.push(tok)
  }
  ws.pinnedStripOrder = pinned
  ws.stripOrder = normal
  // tabOrder синхронизируем с рядом: сначала пины, потом обычные.
  const tabSeq = [...pinned, ...normal]
    .filter((t) => t.startsWith('t:'))
    .map((t) => Number(t.slice(2)))
  const grouped = ws.tabOrder.filter((id) => ws.tabs.get(id)?.groupId)
  ws.tabOrder = [...tabSeq, ...grouped.filter((id) => !tabSeq.includes(id))]
  for (const id of [...ws.tabs.keys()]) {
    if (!ws.tabOrder.includes(id)) ws.tabOrder.push(id)
  }
}

// Пересчет геометрии view под свободную область.
// Renderer сообщает отступы UI через 'layout:update'.
// В контентном fullscreen отступы игнорируются: view на все окно.
// Дефолты ненулевые, чтобы UI был виден даже если renderer еще не прислал замеры.
function layoutView(ws: WindowState, view: WebContentsView) {
  if (!ws.window) return
  const b = ws.window.getContentBounds()
  if (ws.contentFullscreen) {
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
    return
  }
  const ins = ws.uiInsets
  view.setBounds({
    x: ins.left,
    y: ins.top,
    width: Math.max(0, b.width - ins.left - ins.right),
    height: Math.max(0, b.height - ins.top - ins.bottom)
  })
}

function layoutActiveView(ws: WindowState) {
  if (ws.activeTabId === null) return
  const rec = ws.tabs.get(ws.activeTabId)
  if (!rec) return
  layoutView(ws, rec.view)
}

// Слепок сессии обычных вкладок: url + какая активна.
// Инкогнито не пишем никогда. about:blank пропускаем (пустые вкладки).
// Debounce общий с bounds: дергаем из тех же мест.
function snapshotSessionTabs(ws: WindowState): { url: string; active: boolean }[] {
  return ws.tabOrder
    .map((id) => {
      const rec = ws.tabs.get(id)
      if (!rec || rec.url === 'about:blank') return null
      return { url: rec.url, active: id === ws.activeTabId }
    })
    .filter((t): t is { url: string; active: boolean } => t !== null)
}

function persistSessionTabs(ws: WindowState): void {
  if (ws.incognito) return
  if (getSettingsSync().rememberTabs === false) return
  void saveSettings({ sessionTabs: snapshotSessionTabs(ws) }).catch(() => undefined)
}

// Восстановление сессии при старте: создает вкладки из sessionTabs,
// активную ставит последней (setActiveTab в createTab каждый раз двигает).
// Возвращает false если восстанавливать нечего — caller создаст стартовую.
function restoreSessionTabs(ws: WindowState): boolean {
  const saved = readSettingsFileSync()
  if (saved.rememberTabs === false) return false
  const tabs = (saved.sessionTabs ?? []).filter(
    (t) => typeof t?.url === 'string' && t.url.length > 0 && t.url !== 'about:blank'
  )
  if (tabs.length === 0) return false
  let activeId: number | null = null
  for (const t of tabs.slice(0, 50)) {
    try {
      const id = createTab(ws, t.url)
      if (t.active) activeId = id
    } catch {
      // Битый URL — пропускаем вкладку.
    }
  }
  if (activeId !== null) setActiveTab(ws, activeId)
  return ws.tabOrder.length > 0
}

// F11: сценарий из настроек. 'window' — fullscreen всего окна,
// 'content' — только WebContentsView (панели прячутся через shell).
// Контентный режим тоже разворачивает ОКНО на весь экран (иначе видны
// смещение окна и таскбар), но панели скрыты и view занимает все окно.
// Исходные bounds запоминаем: setFullScreen(false) сам их не вернет,
// т.к. окно уже было немаксимизированным — восстанавливаем вручную.
function toggleFullscreenMode(ws: WindowState): boolean {
  if (!ws.window || ws.window.isDestroyed()) return false
  const mode = getSettingsSync().fullscreenMode === 'content' ? 'content' : 'window'
  if (mode === 'content') {
    if (!ws.contentFullscreen) {
      ws.savedBounds = ws.window.getBounds()
      ws.contentFullscreen = true
      ws.window.setFullScreen(true)
    } else {
      ws.contentFullscreen = false
      ws.window.setFullScreen(false)
      // Возвращаем исконный размер: fullscreen его затирает.
      if (ws.savedBounds) {
        ws.window.setBounds(ws.savedBounds)
        ws.savedBounds = undefined
      }
    }
    layoutActiveView(ws)
    ws.window.webContents.send('window:content-fullscreen', ws.contentFullscreen)
    return ws.contentFullscreen
  }
  ws.window.setFullScreen(!ws.window.isFullScreen())
  return ws.window.isFullScreen()
}

function pushTabsState(ws: WindowState) {
  const list: TabRecord[] = ws.tabOrder
    .map((id) => {
      const t = ws.tabs.get(id)
      return t
        ? {
            id,
            viewId: t.view.webContents.id,
            url: t.url,
            title: t.customTitle ?? t.title,
            pinned: t.pinned,
            favicon: t.customFavicon ?? t.favicon,
            groupId: t.groupId
          }
        : null
    })
    .filter((t) => t !== null) as TabRecord[]
  ws.window?.webContents.send('tabs:state', {
    tabs: list,
    activeTabId: ws.activeTabId,
    incognito: ws.incognito,
    openGroups: ws.openGroups.map((g) => ({ ...g })),
    stripOrder: [...ws.stripOrder],
    pinnedStripOrder: [...ws.pinnedStripOrder]
  })
}

// Загрузки: один обработчик на сессию. Файл качается через will-download,
// прогресс пишем в downloads.json — страница konstruktor://downloads
// читает через IPC и обновляется раз в секунду.
function setupDownloads(ses: Electron.Session) {
  ses.on('will-download', (_e, item) => {
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
        if (finalState === 'completed') {
          for (const ws of windows.values()) {
            if (!ws.window || ws.window.isDestroyed()) continue
            const bounds = ws.window.getContentBounds()
            showOverlay(ws.window, {
              kind: 'toast',
              anchor: { x: Math.max(0, bounds.width - 380), y: bounds.height - 160 },
              toast: { title: 'Download complete', body: filename }
            })
          }
        }
      })
    })
  })
}

function createTab(ws: WindowState, url = START_URL): number {
  if (!ws.window) throw new Error('No window')
  const view = new WebContentsView({
    webPreferences: {
      // Сайты изолированы: nodeIntegration выключен по умолчанию.
      contextIsolation: true,
      // Инкогнито-окно: in-memory партиция, ничего не пишется на диск.
      partition: ws.incognito ? INCOGNITO_PARTITION : NORMAL_PARTITION
    }
  })
  // Нативный фон view под тему: дефолт #FFF вспыхивает белым
  // до первой отрисовки страницы. Красим сразу при создании.
  try {
    view.setBackgroundColor(viewBackgroundFor(getSettingsSync().theme ?? 'dark'))
  } catch {
    // Старый Electron без setBackgroundColor у View — игнорим.
  }
  const id = allocTabId()
  ws.tabs.set(id, { view, url, title: 'New Tab', pinned: false, favicon: '', retriedWithChromeUA: false, customTitle: undefined, customFavicon: undefined })
  ws.tabOrder.push(id)
  // Новая вкладка без группы — в конец обычного ряда панели.
  ensureStripToken(ws, `t:${id}`, false)
  ws.window.contentView.addChildView(view)
  // Начальная геометрия сразу, иначе view с нулевыми bounds до первого layout:update.
  layoutView(ws, view)
  // Тема новой вкладки — сразу текущая, без ожидания смены настроек.
  applyThemeToTab(ws.tabs.get(id)!, getSettingsSync().theme ?? 'dark', (k) => {
    const live = ws.tabs.get(id)
    if (live) live.themeKey = k
  })

  view.webContents.on('did-navigate', (_e, navUrl) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.url = navUrl
    rec.favicon = ''
    if (id === ws.activeTabId) ws.window?.webContents.send('tabs:navigated', { id, url: navUrl })
    pushTabsState(ws)
    persistSessionTabs(ws)
    // История: только обычные окна, внутренние страницы пропускаем в store.
    if (!ws.incognito) {
      void recordVisit({ url: navUrl, title: rec.title, favicon: rec.favicon }).catch((err: unknown) =>
        console.error('[history] record failed:', err)
      )
    }
  })
  // did-navigate не стреляет для in-page и части редиректов — дублируем через did-navigate-in-page.
  view.webContents.on('did-navigate-in-page', (_e, navUrl) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.url = navUrl
    if (id === ws.activeTabId) ws.window?.webContents.send('tabs:navigated', { id, url: navUrl })
    pushTabsState(ws)
    persistSessionTabs(ws)
  })
  view.webContents.on('page-title-updated', (_e, title) => {
    const rec = ws.tabs.get(id)
    if (!rec) return
    rec.title = title
    pushTabsState(ws)
    // Только метаданные: заголовок прилетает после навигации,
    // новый визит не засчитываем.
    if (!ws.incognito) {
      void updateMetadata(rec.url, { title }).catch(() => undefined)
    }
  })
  // Иконка сайта для панели вкладок.
  view.webContents.on('page-favicon-updated', (_e, favicons) => {
    const rec = ws.tabs.get(id)
    if (!rec || favicons.length === 0) return
    rec.favicon = favicons[0]
    pushTabsState(ws)
    // Только метаданные: иконка прилетает после навигации,
    // новый визит не засчитываем (иначе один заход = ×2).
    if (!ws.incognito) {
      void updateMetadata(rec.url, { favicon: rec.favicon }).catch(() =>
        undefined
      )
    }
  })
  view.webContents.on('did-fail-load', (_e, code, desc, validatedUrl) => {
    ws.window?.webContents.send('tabs:load-failed', { id, code, desc, url: validatedUrl })
    // GitHub и часть CDN отдают ERR_CONNECTION_CLOSED на дефолтном UA:
    // повтор с Chrome-UA чинит handshake без участия пользователя.
    const rec = ws.tabs.get(id)
    if (
      rec &&
      !rec.retriedWithChromeUA &&
      (code === -100 || code === -101 || code === -104) &&
      !validatedUrl.startsWith('konstruktor://')
    ) {
      rec.retriedWithChromeUA = true
      const chromeUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      rec.view.webContents.setUserAgent(chromeUA)
      void rec.view.webContents.loadURL(validatedUrl).catch(() => undefined)
    }
  })
  // Внешние ссылки открываем в системном браузере.
  view.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    void shell.openExternal(popupUrl)
    return { action: 'deny' }
  })
  // Ctrl+F внутри страницы: перехватываем до сайта и открываем свою панель.
  // before-input-event не стреляет, если фокус в omnibox/devtools или
  // страница перехватила keydown — дублируем через menu-роль и Ctrl+F shell.
  // F11 внутри страницы: Chromium в WebContentsView перехватывает клавишу
  // сам и не отдает ее сайту — тогглим сценарий из настроек вручную.
  // F11 без модификаторов в любом фокусе view = toggle fullscreen.
  view.webContents.on('before-input-event', (e, input) => {
    if (
      input.key === 'F11' &&
      input.type === 'keyDown' &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      !input.alt &&
      ws.window &&
      !ws.window.isDestroyed()
    ) {
      e.preventDefault()
      toggleFullscreenMode(ws)
      return
    }
    const key = (input.key ?? '').toLowerCase()
    // code KeyF — физическая клавиша, не зависит от раскладки (русская 'а' = KeyF).
    const isF = key === 'f' || input.code === 'KeyF'
    if ((input.control || input.meta) && !input.shift && !input.alt && isF && input.type === 'keyDown') {
      e.preventDefault()
      openFindOverlay(ws)
    }
    // Escape при открытой панели поиска: закрываем панель, чистим подсветку.
    if (input.key === 'Escape' && input.type === 'keyDown' && ws.window) {
      const overlay = getActiveOverlay(ws.window)
      if (overlay && !overlay.isDestroyed()) {
        view.webContents.stopFindInPage('clearSelection')
        closeOverlay(ws.window)
      }
    }
  })
  // Счетчик совпадений поиска: found-in-page активной view уходит
  // в панель поиска (оверлей kind 'find') через executeJavaScript.
  view.webContents.on('found-in-page', (_e, result) => {
    if (id !== ws.activeTabId || !ws.window) return
    const overlay = getActiveOverlay(ws.window)
    if (!overlay || overlay.isDestroyed()) return
    const text =
      result.matches === 0
        ? 'No results'
        : `${result.activeMatchOrdinal} of ${result.matches}`
    overlay.webContents.executeJavaScript(buildFoundCounterScript(text)).catch(() => undefined)
  })

  if (url !== 'about:blank') {
    // loadURL для konstruktor://start резолвится через protocol.handle ниже.
    void view.webContents.loadURL(url).catch((err: unknown) => {
      console.error(`[tabs] loadURL failed for tab ${id}:`, err)
    })
  }
  setActiveTab(ws, id)
  return id
}

function setActiveTab(ws: WindowState, id: number) {
  const rec = ws.tabs.get(id)
  if (!rec || !ws.window) return
  // Прячем предыдущую view, показываем новую.
  if (ws.activeTabId !== null) {
    const prev = ws.tabs.get(ws.activeTabId)
    if (prev && prev.view !== rec.view) prev.view.setVisible(false)
  }
  ws.activeTabId = id
  rec.view.setVisible(true)
  layoutActiveView(ws)
  pushTabsState(ws)
  persistSessionTabs(ws)
}

function closeTab(ws: WindowState, id: number) {
  const rec = ws.tabs.get(id)
  if (!rec || !ws.window) return
  const groupId = rec.groupId
  ws.window.contentView.removeChildView(rec.view)
  rec.view.webContents.close()
  ws.tabs.delete(id)
  ws.tabOrder = ws.tabOrder.filter((t) => t !== id)
  // Вкладка без группы жила в едином ряду — убираем токен.
  if (!groupId) removeStripToken(ws, `t:${id}`)
  // Группа без вкладок исчезает с панели вкладок, шаблон остается в store.
  if (groupId) pruneEmptyGroup(ws, groupId)
  if (ws.activeTabId === id) {
    ws.activeTabId = null
    if (ws.tabOrder.length > 0) setActiveTab(ws, ws.tabOrder[ws.tabOrder.length - 1])
    else {
      pushTabsState(ws)
      persistSessionTabs(ws)
    }
  } else {
    pushTabsState(ws)
    persistSessionTabs(ws)
  }
}

// Убрать пустые экземпляры групп: ни одной вкладки с таким instanceId.
function pruneEmptyGroup(ws: WindowState, instanceId: string) {
  const alive = [...ws.tabs.values()].some((t) => t.groupId === instanceId)
  if (!alive) {
    ws.openGroups = ws.openGroups.filter((g) => g.instanceId !== instanceId)
    removeStripToken(ws, `g:${instanceId}`)
  }
}

// Вынос вкладки в новое окно: view переезжает целиком, история сохраняется.
// Новое окно создается ПЕРВЫМ (renderer успевает прислать layout до переезда),
// затем view переносится. Иначе did-finish-load нового окна создаст лишнюю
// стартовую вкладку, а pushTabsState уйдет в пустоту.
function detachTabToNewWindow(fromWs: WindowState, id: number, sx: number, sy: number) {
  const rec = fromWs.tabs.get(id)
  if (!rec || !fromWs.window) return
  // Detach наследует incognito-флаг: партиция view уже задана при создании.
  const ws = createWindow({
    x: Math.round(sx - 80),
    y: Math.round(sy - 40),
    incognito: fromWs.incognito
  })
  if (!ws.window) return
  // Переносим view сразу: новое окно еще грузит renderer, вкладка уже в tabOrder.
  // did-finish-load увидит непустой tabs и не создаст стартовую.
  ws.tabs.set(id, rec)
  ws.tabOrder.push(id)
  ws.activeTabId = id
  // Detach уносит вкладку без группы — токен в ряд нового окна.
  if (!rec.groupId) ensureStripToken(ws, `t:${id}`, rec.pinned)

  fromWs.window.contentView.removeChildView(rec.view)
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
  // Пустое окно без вкладок закрываем, как в Chrome.
  if (fromWs.tabs.size === 0) fromWs.window.close()

  ws.window.contentView.addChildView(rec.view)
  rec.view.setVisible(true)
  layoutView(ws, rec.view)
  pushTabsState(ws)
}

function createWindow(opts: { x?: number; y?: number; incognito?: boolean } = {}): WindowState {
  const ws: WindowState = {
    window: null,
    tabs: new Map(),
    tabOrder: [],
    activeTabId: null,
    stripOrder: [],
    pinnedStripOrder: [],
    uiInsets: { top: 110, bottom: 50, left: 0, right: 0 },
    incognito: opts.incognito ?? false,
    contentFullscreen: false,
    openGroups: []
  }
  // Восстановление геометрии: при rememberBounds стартуем с прошлого
  // размера/позиции, иначе дефолт 1600×900. Maximized — отдельным флагом.
  // Кэш settingsStore в main может быть пустым на момент первого окна
  // (load() еще не вызывался) — читаем файл синхронно напрямую.
  const saved = readSettingsFileSync()
  const useBounds = saved.rememberBounds !== false && saved.windowBounds
  const startBounds =
    opts.x !== undefined || opts.y !== undefined
      ? undefined
      : useBounds
        ? saved.windowBounds
        : undefined
  const win = new BrowserWindow({
    x: opts.x ?? startBounds?.x,
    y: opts.y ?? startBounds?.y,
    width: startBounds?.width ?? 1600,
    height: startBounds?.height ?? 900,
    autoHideMenuBar: true,
    // Свой заголовок: системный скрыт, кнопки рисует renderer.
    frame: false,
    titleBarStyle: 'hidden',
    // Прозрачный фон + CSS border-radius в shell: скругленные углы
    // в оконном режиме. В maximize/fullscreen радиус убирается классом.
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: true,
    webPreferences: {
      // CJS-билд preload (format: 'cjs'): index.cjs рядом с internal.cjs.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // ESM-прелоад (.mjs при "type": "module") требует sandbox: false,
      // иначе скрипт молча не грузится и window.browserAPI undefined.
      sandbox: false
    }
  })
  ws.window = win
  windows.set(win.id, ws)

  // DevTools по требованию: настройка devtools, env KONSTRUKTOR_DEVTOOLS=1
  // или флаг --devtools. По умолчанию закрыты.
  void getSettings()
    .then((s) => {
      const want =
        s.devtools || process.env.KONSTRUKTOR_DEVTOOLS === '1' || process.argv.includes('--devtools')
      if (want && ws.window && !ws.window.webContents.isDevToolsOpened()) {
        ws.window.webContents.openDevTools({ mode: 'detach' })
      }
    })
    .catch(() => undefined)

  win.on('resize', () => layoutActiveView(ws))
  win.on('resized', () => layoutActiveView(ws))
  // Состояние окна пушим в shell — опроса таймером больше нет.
  // maximize/unmaximize не покрывают все случаи: resize развернутого окна
  // (перетаскивание за край) и F11 (fullscreen) меняют геометрию без этих
  // событий — поэтому шлем оба флага на каждый resize тоже.
  const pushWindowState = () => {
    if (!ws.window || ws.window.isDestroyed()) return
    ws.window.webContents.send('window:maximized', ws.window.isMaximized())
    ws.window.webContents.send('window:fullscreen', ws.window.isFullScreen())
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)
  win.on('enter-full-screen', pushWindowState)
  win.on('leave-full-screen', () => {
    // Выход из fullscreen не через F11 (Esc, Win-жесты): контентный режим
    // тоже сбрасываем, иначе панели останутся скрытыми в обычном окне.
    if (ws.contentFullscreen) {
      ws.contentFullscreen = false
      if (ws.savedBounds && !ws.window?.isDestroyed()) {
        ws.window?.setBounds(ws.savedBounds)
        ws.savedBounds = undefined
      }
      layoutActiveView(ws)
      ws.window?.webContents.send('window:content-fullscreen', false)
    }
    pushWindowState()
  })
  win.on('resized', pushWindowState)
  // Первый layout после готовности renderer: к этому моменту view уже есть.
  // Сессия вкладок восстанавливается здесь же: did-finish-load значит shell
  // готов принимать pushTabsState. Инкогнито сессию не читает никогда.
  win.webContents.on('did-finish-load', () => {
    if (ws.tabs.size === 0) {
      const restored = !ws.incognito && restoreSessionTabs(ws)
      if (!restored) createTab(ws)
    } else {
      layoutActiveView(ws)
      pushTabsState(ws)
    }
  })
  // Глобальный Ctrl+F окна: срабатывает даже если before-input-event view
  // не выстрелил (фокус в shell, пустая вкладка, перехват сайтом).
  // F11 из фокуса shell: тоггл сценария из настроек вручную.
  win.webContents.on('before-input-event', (e, input) => {
    if (
      input.key === 'F11' &&
      input.type === 'keyDown' &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      !input.alt
    ) {
      e.preventDefault()
      if (!win.isDestroyed()) toggleFullscreenMode(ws)
      return
    }
    const key = (input.key ?? '').toLowerCase()
    const isF = key === 'f' || input.code === 'KeyF'
    if (
      (input.control || input.meta) &&
      !input.shift &&
      !input.alt &&
      isF &&
      input.type === 'keyDown'
    ) {
      e.preventDefault()
      openFindOverlay(ws)
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Восстановленный maximized применяется после загрузки shell.
  if (readSettingsFileSync().rememberBounds !== false && readSettingsFileSync().windowMaximized) {
    win.maximize()
  }

  // Геометрия пишется при каждом resize/move обычного окна.
  // Debounce 500ms: resize шлет десятки событий в секунду.
  let boundsTimer: NodeJS.Timeout | null = null
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
      void saveSettings({ windowBounds: win.getBounds() }).catch(() => undefined)
    }, 500)
  }
  win.on('resized', persistBounds)
  win.on('moved', persistBounds)
  win.on('maximize', () => {
    void saveSettings({ windowMaximized: true }).catch(() => undefined)
  })
  win.on('unmaximize', () => {
    void saveSettings({ windowMaximized: false }).catch(() => undefined)
  })

  win.on('close', () => {
    // Финальный слепок при закрытии: обычное окно — bounds + не maximized,
    // maximized/fullscreen — только флаг (bounds от таких окон кривые).
    // Сессия вкладок — всегда (кроме инкогнито): закрытие может быть
    // резким, debounce persistSessionTabs мог не успеть.
    if (getSettingsSync().rememberBounds !== false) {
      if (win.isMaximized() || win.isFullScreen()) {
        void saveSettings({ windowMaximized: true }).catch(() => undefined)
      } else {
        void saveSettings({ windowBounds: win.getBounds(), windowMaximized: false }).catch(
          () => undefined
        )
      }
    }
    if (!ws.incognito && getSettingsSync().rememberTabs !== false) {
      void saveSettings({ sessionTabs: snapshotSessionTabs(ws) }).catch(() => undefined)
    }
  })

  win.on('closed', () => {
    for (const tab of ws.tabs.values()) {
      try {
        tab.view.webContents.close()
      } catch {
        // Окно уже мертво — игнорим.
      }
    }
    // Инкогнито: чистим in-memory сессию при закрытии окна.
    if (ws.incognito) {
      try {
        const ses = win.webContents.session
        void ses.clearStorageData().catch(() => undefined)
        void ses.clearCache().catch(() => undefined)
      } catch {
        // Сессия уже уничтожена — игнорим.
      }
    }
    windows.delete(win.id)
    ws.window = null
    ws.tabs.clear()
  })

  return ws
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
        return { id, url: t.url, title: t.customTitle ?? t.title, pinned: t.pinned, favicon: t.customFavicon ?? t.favicon, groupId: t.groupId }
      }),
      activeTabId: ws.activeTabId,
      incognito: ws.incognito,
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
      incognito: false,
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
              incognito: false,
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
      incognito: false,
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
  // Новое инкогнито-окно: in-memory партиция, данные стираются при закрытии.
  ipcMain.handle('window:incognito', () => {
    const ws = createWindow({ incognito: true })
    return ws.window?.id ?? null
  })
  // Группы вкладок: шаблоны в groups.json + открытые экземпляры в WindowState.
  registerGroupsIpc(wsOf, { createTab, closeTab, setActiveTab, pushTabsState, pruneEmptyGroup, ensureStripToken, removeStripToken, moveStripToken })
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
  ipcMain.handle('downloads:list', (_e, limit?: number) => getDownloads(limit ?? 200))
  ipcMain.handle('downloads:search', (_e, query: string, limit?: number) =>
    searchDownloads(query, limit ?? 100)
  )
  ipcMain.handle('downloads:remove', async (_e, id: string) => {
    await removeDownload(id)
    return true
  })
  ipcMain.handle('downloads:clear', async () => {
    await clearDownloads()
    return true
  })
  ipcMain.handle('downloads:open', async (_e, id: string) => {
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
    if (!rec.groupId) ensureStripToken(target, `t:${id}`, rec.pinned)
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
  // content-области окна. Оверлей позиционируется в overlayManager.
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
      // Заглушки: разделы в разработке, пункты неактивны.
      { id: 'profile', label: 'Profile', icon: '👤', disabled: true },
      { id: 'extensions', label: 'Extensions', icon: '🧩', disabled: true },
      { id: 'debug', label: 'Debug', icon: '🐞', disabled: true },
      // В инкогнито-окне пункт скрыт — окно уже приватное.
      ...(ws.incognito ? [] : [{ id: 'incognito', label: 'New incognito window', icon: '🕵️' }])
    ]
    showOverlay(win, {
      kind: 'menu',
      anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      items,
      incognito: ws.incognito,
      onSelect: (id) => {
        if (id === 'downloads') openPage(DOWNLOADS_URL)
        else if (id === 'history') openPage(HISTORY_URL)
        else if (id === 'settings') openPage(SETTINGS_URL)
        else if (id === 'incognito') createWindow({ incognito: true })
      }
    })
  })
  // Оверлей-окно: выбор пункта, submit диалога и dismiss.
  ipcMain.handle('overlay:select', (e, id: string) => {
    const overlay = BrowserWindow.fromWebContents(e.sender)
    if (overlay) resolveOverlaySelect(overlay, id)
    return true
  })
  ipcMain.handle('overlay:submit', (e, raw: string) => {
    const overlay = BrowserWindow.fromWebContents(e.sender)
    if (overlay) resolveOverlaySubmit(overlay, raw)
    return true
  })
  // Общий диалог иконки: верификация источника, apply кладет иконку.
  // Контекст (вкладка/группа) хранится в замыкании onSelect диалога.
  ipcMain.handle('overlay:submit-icon', (e, buttonId: string, value: string) => {
    const overlay = BrowserWindow.fromWebContents(e.sender)
    if (!overlay) return false
    const apply = (overlay as unknown as { __iconApply?: (icon: string) => void }).__iconApply
    if (!apply) return false
    return resolveOverlaySubmitIcon(overlay, buttonId, value, apply)
  })
  ipcMain.handle('overlay:dismiss', (e) => {
    const overlay = BrowserWindow.fromWebContents(e.sender)
    if (overlay) resolveOverlayDismiss(overlay)
    return true
  })
  // Тосты поверх сайта: notify(title, body) из любого renderer-компонента.
  ipcMain.handle(
    'overlay:notify',
    (e, toast: { title: string; body?: string; timeout?: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return false
      const bounds = win.getContentBounds()
      showOverlay(win, {
        kind: 'toast',
        anchor: { x: Math.max(0, bounds.width - 380), y: bounds.height - 160 },
        toast
      })
      return true
    }
  )
  // Поиск по странице (Ctrl+F): панель в правом верхнем углу области
  // страницы (оверлей kind 'find'), подсветка через webContents.findInPage.
  // Опции как в VS Code: matchCase, wholeWord, useRegex.
  // Состояние и DOM-инъекции — в findManager/findScripts.
  ipcMain.handle(
    'find:query',
    (
      e,
      opts: { query: string; matchCase: boolean; wholeWord: boolean; useRegex: boolean }
    ) => queryFind(e.sender, opts)
  )
  ipcMain.handle('find:next', (e) => nextFind(e.sender))
  ipcMain.handle('find:prev', (e) => prevFind(e.sender))
  ipcMain.handle('find:close', (e) => closeFind(e.sender))
  // Открыть панель поиска: Ctrl+F из renderer или before-input-event view.
  ipcMain.handle('find:open', (e, query?: string) => {
    const ws = getStateBySender(e.sender)
    if (!ws) return false
    return openFindOverlay(ws, query ?? '')
  })
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
  setupDownloads(session.fromPartition(INCOGNITO_PARTITION))
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
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
