// Связка кластеров windows/ и tabs/ без циклов: они вызывают друг
// друга только через deps, здесь собираются оба набора.
// Выделено из index.ts: единое место wiring'а, register*Ipc и диагностика
// импортируют отсюда готовые createTab/createWindow вместо своих копий.
import { getStateBySender, findTab, windows, NORMAL_PARTITION, type WindowState } from './browserState'
import {
  createTab as createTabRaw,
  setActiveTab as setActiveTabRaw,
  closeTab as closeTabRaw,
  detachTabToNewWindow as detachTabRaw,
  pruneEmptyGroup,
  pushTabsState,
  type TabsDeps
} from '../tabs/tabsManager'
import {
  createWindow as createWindowRaw,
  layoutView,
  layoutActiveView,
  persistSessionTabs,
  type WindowDeps
} from './windowsManager'
import { toggleFullscreenMode as toggleFullscreen } from './fullscreen'
import { closeOverlayOnTabChange, showOverlay } from '../overlay'
import { inspectElementAt } from '../tabs/devtools'
import type { PageMenuDeps } from '../tabs/pageMenu'
import { START_URL } from '../pages/internalPages'
import { registerExtensionHost } from '../extensions/bridge'
import type { ChromeTabLike } from '../../shared/extensions-types'
import { BrowserWindow, session } from 'electron'

// wsOf: sender -> окно. Бросает, если окна нет: такое возможно только
// при гонке «ответ ушёл в уже закрытое окно», и молчаливый undefined
// превратил бы её в невыполненный handle без ошибки в логах.
export function wsOf(e: { sender: Electron.WebContents }): WindowState {
  const ws = getStateBySender(e.sender)
  if (!ws) throw new Error('No window for sender')
  return ws
}

// Оба набора deps собираются здесь: tabsManager получает layout-хелперы
// windowsManager, windowsManager — createTab tabsManager.
// Действия контекстного меню страницы (pageMenu.ts) — тот же случай: сам
// модуль меню окон не знает, поэтому openTab/openWindow/inspectAt приходят
// отсюда, а не импортом.
const pageMenuDeps: PageMenuDeps = {
  openTab: (ws, url) => {
    createTab(ws, url)
  },
  openWindow: (url) => {
    // Порядок как в cloneWindow: сначала окно, затем вкладка. Первую вкладку
    // createWindow создаёт только на did-finish-load шелла, поэтому грузить
    // URL «в активную вкладку» сразу после вызова нельзя — активной ещё нет.
    // Явный createTab кладёт вкладку раньше, и обработчик did-finish-load
    // уходит в ветку «вкладки уже есть», не подменяя её стартовой.
    const ws = createWindow({ restoreSession: false })
    createTab(ws, url)
  },
  inspectAt: (ws, tabId, x, y) => {
    inspectElementAt(ws, tabId, x, y)
  }
}

const tabsDeps: TabsDeps = {
  layoutView,
  layoutActiveView,
  // Обёртка: fullscreen.ts принимает layout явно, чтобы не было
  // цикла fullscreen <-> windowsManager.
  toggleFullscreenMode: (ws) => toggleFullscreen(ws, layoutActiveView),
  persistSessionTabs,
  createWindow: (opts) => createWindow(opts),
  pruneEmptyGroup,
  pageMenu: pageMenuDeps
}

export function createTab(ws: WindowState, url = START_URL): number {
  return createTabRaw(ws, tabsDeps, url)
}

export function setActiveTab(ws: WindowState, id: number): void {
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

export function closeTab(ws: WindowState, id: number): void {
  closeTabRaw(ws, tabsDeps, id)
}

export function detachTabToNewWindow(fromWs: WindowState, id: number, sx: number, sy: number): void {
  detachTabRaw(fromWs, tabsDeps, id, sx, sy)
}

// restoreSession пробрасывается в createWindow: «Open new window» открывает
// пустое окно и не должен подхватывать sessionTabs (общий слот на всё
// приложение) — иначе «новое» окно оказывалось бы копией чужого.
export function createWindow(
  opts: { x?: number; y?: number; restoreSession?: boolean } = {}
): WindowState {
  const windowDeps: WindowDeps = { createTab, setActiveTab, pushTabsState, closeTab }
  return createWindowRaw(opts, windowDeps)
}

export { pushTabsState, pruneEmptyGroup, tabsDeps }

// --- Возможности хоста для расширений ------------------------------------

// Расширения обращаются к вкладкам и окнам через loopback-мост, но сами
// кластеры не знают: возможности собираются здесь, где уже есть и createTab,
// и createWindow. Импорт в обратную сторону дал бы цикл (extensions -> deps).
function windowStateOf(id: number | undefined): WindowState | undefined {
  if (id === undefined) return undefined
  for (const ws of windows.values()) if (ws.window?.id === id) return ws
  return undefined
}

function activeWindowState(): WindowState | undefined {
  const focusedId = BrowserWindow.getFocusedWindow()?.id
  return windowStateOf(focusedId) ?? windows.values().next().value
}

function tabsOfWs(ws: WindowState): ChromeTabLike[] {
  const windowId = ws.window?.id ?? -1
  const out: ChromeTabLike[] = []
  ws.tabOrder.forEach((tabId, index) => {
    const rec = ws.tabs.get(tabId)
    if (!rec) return
    const wc = rec.view?.webContents
    out.push({
      id: tabId,
      index,
      windowId,
      url: rec.url,
      title: rec.customTitle ?? rec.title,
      active: tabId === ws.activeTabId,
      pinned: rec.pinned,
      incognito: ws.incognito,
      // Реальный признак звука: расширения используют его, чтобы понять,
      // есть ли вообще что слушать, и по нему же показывают индикатор.
      // Умирающий webContents бросает на любом обращении — проверяем.
      audible: wc && !wc.isDestroyed() ? wc.isCurrentlyAudible() : false
    })
  })
  return out
}

registerExtensionHost({
  listWindows: () =>
    [...windows.values()]
      .filter((ws) => ws.window)
      .map((ws) => ({
        id: ws.window?.id ?? -1,
        focused: ws.window?.isFocused() ?? false,
        incognito: ws.incognito
      })),
  listTabs: (windowId) =>
    [...windows.values()]
      .filter((ws) => windowId === undefined || ws.window?.id === windowId)
      .flatMap(tabsOfWs),
  activeWindowId: () => activeWindowState()?.window?.id ?? null,
  focusedWindowId: () => BrowserWindow.getFocusedWindow()?.id ?? null,
  openTab: (url, opts) => {
    const ws = windowStateOf(opts.windowId) ?? activeWindowState()
    if (!ws) return null
    const id = createTab(ws, url)
    if (opts.active) setActiveTab(ws, id)
    return id
  },
  closeTab: (id) => {
    const found = findTab(id)
    if (!found) return false
    closeTab(found.ws, id)
    return true
  },
  activateTab: (id) => {
    const found = findTab(id)
    if (!found) return false
    setActiveTab(found.ws, id)
    return true
  },
  navigateTab: (id, url) => {
    const found = findTab(id)
    if (!found || found.rec.view.webContents.isDestroyed()) return false
    void found.rec.view.webContents.loadURL(url)
    return true
  },
  reloadTab: (id) => {
    const found = findTab(id)
    if (!found || found.rec.view.webContents.isDestroyed()) return false
    found.rec.view.webContents.reload()
    return true
  },
  createWindow: (url) => {
    const ws = createWindow({ restoreSession: false })
    if (url) createTab(ws, url)
    return ws.window?.id ?? null
  },
  closeWindow: (id) => {
    const win = BrowserWindow.fromId(id)
    if (!win) return false
    win.close()
    return true
  },
  notify: (toast) => {
    const ws = activeWindowState()
    if (!ws?.window) return
    const bounds = ws.window.getContentBounds()
    showOverlay(ws.window, {
      kind: 'toast',
      anchor: { x: Math.max(0, bounds.width - 380), y: bounds.height - 160 },
      toast
    })
  },
  downloadUrl: (url) => {
    void session.fromPartition(NORMAL_PARTITION).downloadURL(url)
  }
})
