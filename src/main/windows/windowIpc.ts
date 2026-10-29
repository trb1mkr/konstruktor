// IPC окна: кнопки заголовка, drag, fullscreen, инкогнито, контекстное
// меню окна и каналы зума. Выделено из index.ts:.zoom — здесь, потому
// что зум всегда считается по активной вкладке окна и пушит tabs:state.
import { BrowserWindow, ipcMain } from 'electron'
import { getState, getStateBySender } from './browserState'
import {
  startWindowDrag,
  moveWindowDrag,
  endWindowDrag,
  layoutActiveView
} from './windowsManager'
import { toggleFullscreenMode } from './fullscreen'
import { switchIncognito, cloneWindow } from '../tabs/tabsManager'
import { applyZoomToWs, openZoomPopup, stepActiveZoom } from '../zoomManager'
import { showWindowMenu } from './windowMenu'
import { createWindow, pushTabsState, tabsDeps, wsOf } from './deps'
import { readWorkspaceMeta } from '../workspaces/registry'

export function registerWindowIpc(): void {
  // Пространство текущего окна — для значка перед кнопкой меню браузера.
  // Shell не знает своего пространства и не должен: партиция и метаданные
  // живут в main. Иконка — один эмодзи (см. registry.normalizeIcon), имя
  // нужно для подсказки.
  ipcMain.handle('window:workspace', (e) => {
    const ws = getStateBySender(e.sender)
    if (!ws) return null
    const meta = readWorkspaceMeta(ws.workspaceId)
    return meta
      ? { id: meta.id, name: meta.name, icon: meta.icon, color: meta.color }
      : { id: ws.workspaceId, name: ws.workspaceId, icon: '', color: '#888888' }
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
  // Масштаб страницы активной вкладки. Процент всегда читается из
  // webContents (источник истины — Chromium), после применения пушится
  // tabs:state — badge в адресной строке обновляется реактивно, отдельный
  // канал не нужен. Всё идёт через applyZoomToWs/stepActiveZoom: там же
  // живёт режим единого зума (все вкладки всех окон).
  ipcMain.handle('zoom:in', (e) => stepActiveZoom(wsOf(e), 1, pushTabsState))
  ipcMain.handle('zoom:out', (e) => stepActiveZoom(wsOf(e), -1, pushTabsState))
  ipcMain.handle('zoom:reset', (e) => applyZoomToWs(wsOf(e), 100, pushTabsState))
  ipcMain.handle('zoom:set', (e, raw: number) => applyZoomToWs(wsOf(e), raw, pushTabsState))
  // Попап масштаба: якорь — правый НИЖНИЙ угол бейджа, координаты
  // content-области (тот же контракт, что у menu:popup кнопки ☰).
  ipcMain.on('zoom:popup', (e, anchor: { x: number; y: number }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const ws = win ? getState(win) : undefined
    if (!win || !ws || !anchor) return
    openZoomPopup(
      win,
      ws,
      { x: Math.round(anchor.x), y: Math.round(anchor.y) },
      pushTabsState
    )
  })
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
      // restoreSession: false — новое окно получает только стартовую
      // страницу, а не слепок вкладок. Пространство наследуется: данные
      // (история, группы, расширения) у окон одного пространства общие.
      newWindow: () => {
        createWindow({ restoreSession: false, workspaceId: ws.workspaceId })
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
    return toggleFullscreenMode(ws, layoutActiveView)
  })
}
