// IPC вкладок: жизненный цикл, порядок панели, навигация, DevTools.
// Выделено из index.ts: здесь только каналы tabs:*/devtools:*/layout:update,
// их действия — через windows/deps (связка без циклов). Меню вкладок
// (ПКМ) живёт в tabsMenu.ts, каналы окна — в windowIpc.ts.
import { ipcMain } from 'electron'
import {
  findTab,
  getStateBySender,
  type WindowState
} from '../windows/browserState'
import {
  ensureStripToken,
  removeStripToken,
  reorderStrip,
  rebuildStripFromTabs
} from './stripOrder'
import { toggleDevTools, devToolsStateOf } from './devtools'
import { layoutActiveView } from '../windows/windowsManager'
import { percentOf } from '../zoomManager'
import { pushTabsState, createTab, closeTab, setActiveTab, detachTabToNewWindow, wsOf } from '../windows/deps'
import { getSettings } from '../store/settingsStore'
import { HISTORY_URL, SETTINGS_URL, DOWNLOADS_URL } from '../pages/internalPages'

export function registerTabsIpc(): void {
  ipcMain.handle('tabs:create', (e, url?: string) => createTab(wsOf(e), url ?? undefined))
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
        return { id, url: t.url, title: t.customTitle ?? t.title, pinned: t.pinned, favicon: t.customFavicon ?? t.favicon, groupId: t.groupId, devToolsOpen: t.devTools?.open === true, zoom: percentOf(t.view.webContents) }
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
  // Принимает URL картинки, dataURL или file:// от диалога выбора файла.
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
  // Внутренние страницы в активной вкладке текущего окна.
  ipcMain.handle('tabs:open-history', (e) => {
    openInternalPage(wsOf(e), HISTORY_URL)
    return true
  })
  ipcMain.handle('tabs:open-settings', (e) => {
    openInternalPage(wsOf(e), SETTINGS_URL)
    return true
  })
  ipcMain.handle('tabs:open-downloads', (e) => {
    openInternalPage(wsOf(e), DOWNLOADS_URL)
    return true
  })
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
}

// Активная вкладка или undefined: URL внутренней страницы уходит в неё,
// иначе страница открывается новой вкладкой.
function openInternalPage(ws: WindowState, url: string): void {
  const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  if (rec) void rec.view.webContents.loadURL(url)
  else createTab(ws, url)
}
