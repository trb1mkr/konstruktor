// Связка кластеров windows/ и tabs/ без циклов: они вызывают друг
// друга только через deps, здесь собираются оба набора.
// Выделено из index.ts: единое место wiring'а, register*Ipc и диагностика
// импортируют отсюда готовые createTab/createWindow вместо своих копий.
import { getStateBySender, type WindowState } from './browserState'
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
import { closeOverlayOnTabChange } from '../overlay'
import { inspectElementAt } from '../tabs/devtools'
import type { PageMenuDeps } from '../tabs/pageMenu'
import { START_URL } from '../pages/internalPages'

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
  const windowDeps: WindowDeps = { createTab, setActiveTab, pushTabsState }
  return createWindowRaw(opts, windowDeps)
}

export { pushTabsState, pruneEmptyGroup, tabsDeps }
