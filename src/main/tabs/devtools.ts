// DevTools открытой веб-страницы: док в WebContentsView вкладки.
//
// Отдельный модуль от `windowsManager`, где живёт DevTools интерфейса
// (shell): там webContents принадлежит самому окну, здесь — вложенной
// view. Смешивать их в одном месте нельзя, это разные носители.
//
// Ключевой факт, из которого строится всё остальное: WebContentsView — это
// в Electron не голая views::WebView, а обёртка InspectableWebContentsView.
// Внутри неё уже есть пара «страница + DevTools» и готовая разметка док-а
// с разделителем и ресайзом. Док-нутые DevTools не рисует приложение:
// Electron сам делит bounds view между content и devtools_web_view.
//
// Отсюда две вещи, которые нельзя упустить:
//
// 1. Док приходит сам, в layout вкладки вмешиваться не нужно. Единственное
//    исключение — `layoutView` зовёт `view.setBounds()` на все 100% контейнера,
//    и док-нутый DevTools живёт ВНУТРИ этих bounds, поэтому пересчёт после
//    открытия безопасен.
//
// 2. `setDevToolsWebContents` для вкладок использовать нельзя: он переводит
//    DevTools в режим `detach` (отдельное окно), а док-нуть в собственный
//    BrowserWindow/overlay-окно нельзя — там нет InspectableWebContentsView,
//    который Chromium ждёт для разметки дока.
//
// Про mode: 'right'/'left'/'bottom' док-ится внутрь view. mode: 'detach'
// и 'undocked' открывают отдельное системное окно — это уже другой UX
// (окно поверх окна, свой таскбар), его в конструктор не берём.
import { log } from '../overlay/logger'
import type { WindowState } from '../windows/browserState'

// Док-режимы, которые Chromium умеет рисовать внутри view.
// 'right' — как в Chrome при первом открытии, 'bottom' — для широких окон,
// где боковая панель съела бы слишком много ширины.
export type DevToolsDockMode = 'right' | 'bottom'

// Состояние DevTools вкладки живёт в записи вкладки (TabData.devTools),
// а не в карте рядом: смена активной вкладки не должна закрывать DevTools —
// он остаётся открытым на своей вкладке, пока пользователь туда не вернётся.

// Выбор стороны дока под текущую геометрию view.
//
// Chromium сам переключает док при ресайзе (в InspectableWebContentsView
// держится currentDockState из настроек фронтенда), но при ПЕРВОМ открытии
// режим выбираем мы. Ниже 480 px по ширине бок отдаёт слишком мало места
// под колонки Network и Elements, а у высокого окна (высота больше 3/4
// ширины) бок забирает непропорционально много — там док вниз.
function pickModeFor(rec: { view: { getBounds(): Electron.Rectangle } }): DevToolsDockMode {
  const b = rec.view.getBounds()
  if (b.width < 480) return 'bottom'
  return b.height > b.width * 0.75 ? 'bottom' : 'right'
}

/**
 * Открыть DevTools на вкладке, если закрыты, закрыть, если открыты.
 *
 * Возвращает новое состояние — вызывающий кладёт его в запись и пушит
 * в shell, чтобы меню показало галочку.
 */
export function toggleDevTools(
  ws: WindowState,
  tabId: number
): { open: boolean; mode: DevToolsDockMode } {
  const rec = ws.tabs.get(tabId)
  if (!rec) return { open: false, mode: 'right' }
  const wc = rec.view.webContents
  if (wc.isDestroyed()) return { open: false, mode: 'right' }
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools()
    return { open: false, mode: rec.devTools?.mode ?? 'right' }
  }
  const mode = pickModeFor(rec)
  wc.openDevTools({ mode, activate: true })
  rec.devTools = { open: true, mode }
  log('command', 'page devtools opened', { tabId, mode, windowId: ws.window?.id })
  return { open: true, mode }
}

// Закрыть, если открыты. Вызывается при закрытии вкладки и при пересоздании
// view (инкогнито-переключение): закрытый webContents уносит DevTools с собой,
// и держать протухшую запись значило бы показать в меню «открыто» у мёртвой
// вкладки.
export function closeDevToolsFor(ws: WindowState, tabId: number): void {
  const rec = ws.tabs.get(tabId)
  if (!rec) return
  rec.devTools = undefined
  const wc = rec.view.webContents
  if (wc.isDestroyed()) return
  if (wc.isDevToolsOpened()) wc.closeDevTools()
}

// Состояние для пуша в shell и для пункта меню: запись может устареть, если
// пользователь закрыл DevTools крестиком в самом DevTools. Тогда Chromium
// шлёт 'devtools-closed' (см. подписку в tabsManager), но подстраховка в виде
// опроса самого webContents дешевле, чем доверять только событию.
export function devToolsStateOf(
  ws: WindowState,
  tabId: number
): { open: boolean; mode: DevToolsDockMode } {
  const rec = ws.tabs.get(tabId)
  if (!rec) return { open: false, mode: 'right' }
  const mode = rec.devTools?.mode ?? 'right'
  if (rec.view.webContents.isDestroyed()) return { open: false, mode }
  return { open: rec.view.webContents.isDevToolsOpened(), mode }
}