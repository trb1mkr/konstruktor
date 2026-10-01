// Регистрация IPC-каналов оверлея.
//
// Шаг 4 плана (docs/OVERLAY_PLAN.md) выносит сюда всё, что относится к
// оверлеям. Раньше эти хендлеры жили в index.ts вперемешку с вкладками,
// историей и настройками, и править их можно было только там.
//
// ГРАНИЦА: файл про оверлеи, а не про приложение. Каналы вкладок,
// истории, загрузок, настроек, окон и ярлыков остаются в index.ts —
// они не оверлейные и тянуть их сюда незачем. Здесь только те, кто
// обращается к окну оверлея или к панели поиска, которая сама является
// оверлеем (kind 'find').
//
// Каналы делятся на две группы по источнику сообщения:
//
//   overlay:* — приходят от renderer'а ОВЕРЛЕЯ. Родителя находим через
//     BrowserWindow.fromWebContents(e.sender): это само окно оверлея.
//     Логика разбора команд живёт в service.ts, здесь только пересылка.
//
//   find:* — приходят от renderer'а СТРАНИЦЫ (view вкладки), потому что
//     панель поиска управляется вкладкой, а её webContents нужен для
//     findInPage. Родителя находим через getStateBySender.
//
// Смешивать эти группы нельзя: sender у них принципиально разный, и
// путаница даст молчаливо неверного родителя.

import { BrowserWindow, ipcMain } from 'electron'
import { log } from './logger'
import {
  resolveOverlaySelect,
  resolveOverlaySubmit,
  resolveOverlaySubmitIcon,
  resolveOverlayDismiss,
  showOverlay
} from './service'
import { getStateBySender } from '../browserState'
import { openFindOverlay, queryFind, nextFind, prevFind, closeFind } from '../findManager'
import { isCommandCurrent } from './session'

/**
 * Окно оверлея по sender'у, либо undefined, если sender — не оверлей.
 *
 * Проверка на undefined обязательна: каналы overlay:* доступны из
 * preload'а оверлея, но в теории могут быть вызваны и из другого
 * контекста, и resolveOverlay* на чужом окне молча ничего не делает.
 */
function overlayOf(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow | undefined {
  // fromWebContents возвращает null, а не undefined — приводим явно, иначе
  // проверка `if (overlay)` в вызывающем коде работает, а типы спорят.
  return BrowserWindow.fromWebContents(e.sender) ?? undefined
}

/**
 * Принимает ли main команду от этого окна.
 *
 * Окно оверлея переиспользуется из пула, поэтому команда, отправленная
 * для ПРОШЛОЙ сессии, вполне может прийти, когда активна следующая:
 * renderer отправил click, сессия сменилась, click долетел. Без сверки
 * токена команда исполнилась бы против нового содержимого — например,
 * клик по пункту старого меню закрыл бы новое.
 *
 * Токен опционален только до шага 10: устаревшие вызовы из внешнего кода
 * его не передают, и без него проверять нечего. Когда приходит сессия с
 * токеном — сверка обязательна.
 */
function accept(e: Electron.IpcMainInvokeEvent, overlay: BrowserWindow, sessionId?: number): boolean {
  if (sessionId === undefined) return true
  return isCommandCurrent(overlay, sessionId)
}

export function registerOverlayIpc(): void {
  // Выбор пункта меню. Значение true в ответе — сигнал renderer'у, что
  // команда принята; сам оверлей к этому моменту уже может быть закрыт.
  //
  // false означает, что команда от устаревшей сессии и НЕ исполнена:
  // renderer должен трактовать это как «меню уже не то» и не закрывать
  // себя по локальной логике.
  ipcMain.handle('overlay:select', (e, id: string, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (!overlay) return false
    if (!accept(e, overlay, sessionId)) return false
    resolveOverlaySelect(overlay, id)
    return true
  })
  // Submit диалога с полем ввода: значение "buttonId::text".
  ipcMain.handle('overlay:submit', (e, raw: string, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (!overlay) return false
    if (!accept(e, overlay, sessionId)) return false
    resolveOverlaySubmit(overlay, raw)
    return true
  })
  // Общий диалог иконки: верификация источника и apply.
  // Контекст (вкладка/группа) лежит в request активной сессии, который
  // service находит сам — передавать apply сюда больше не нужно.
  ipcMain.handle(
    'overlay:submit-icon',
    async (e, buttonId: string, value: string, sessionId?: number) => {
      const overlay = overlayOf(e)
      if (!overlay) return false
      if (!accept(e, overlay, sessionId)) return false
      return resolveOverlaySubmitIcon(overlay, buttonId, value)
    }
  )
  // Закрытие оверлея по Escape, клику мимо или таймеру тоста.
  ipcMain.handle('overlay:dismiss', (e, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (!overlay) return false
    if (!accept(e, overlay, sessionId)) return false
    resolveOverlayDismiss(overlay)
    return true
  })
  // Тосты поверх сайта: notify(title, body) из любого renderer-компонента.
  // Sender здесь — окно браузера, поэтому оверлеем он не является.
  ipcMain.handle(
    'overlay:notify',
    (e, toast: { title: string; body?: string; timeout?: number }) => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
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
  // Диагностика: renderer оверлея сообщает о своих наблюдениях. Помогает
  // отличить CSS-анимацию от системной анимации появления окна.
  ipcMain.on('overlay:trace', (e, message: string) => {
    const overlay = overlayOf(e)
    log('lifecycle', `[trace] ${message}`, { windowId: overlay?.id })
  })

  // Панель поиска (Ctrl+F) — оверлей kind 'find', но управляется вкладкой.
  // Опции как в VS Code: matchCase, wholeWord, useRegex. Состояние и
  // DOM-инъекции — в findManager/findScripts.
  //
  // Токен сессии здесь проверяется по той же причине, что и в overlay:*:
  // панель поиска живёт в том же переиспользуемом окне, и запоздалый ввод
  // из прошлой сессии применился бы к текущей вкладке.
  ipcMain.handle(
    'find:query',
    (
      e,
      opts: { query: string; matchCase: boolean; wholeWord: boolean; useRegex: boolean },
      sessionId?: number
    ) => {
      const overlay = overlayOf(e)
      if (overlay && !accept(e, overlay, sessionId)) return false
      return queryFind(e.sender, opts)
    }
  )
  ipcMain.handle('find:next', (e, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (overlay && !accept(e, overlay, sessionId)) return false
    return nextFind(e.sender)
  })
  ipcMain.handle('find:prev', (e, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (overlay && !accept(e, overlay, sessionId)) return false
    return prevFind(e.sender)
  })
  ipcMain.handle('find:close', (e, sessionId?: number) => {
    const overlay = overlayOf(e)
    if (overlay && !accept(e, overlay, sessionId)) return false
    return closeFind(e.sender)
  })
  // Открыть панель: Ctrl+F из renderer или before-input-event view.
  ipcMain.handle('find:open', (e, query?: string) => {
    const ws = getStateBySender(e.sender)
    if (!ws) return false
    return openFindOverlay(ws, query ?? '')
  })
}
