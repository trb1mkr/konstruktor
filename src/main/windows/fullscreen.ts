// Контентный и оконный fullscreen: F11-сценарий из настроек и сброс
// при выходе из fullscreen не через F11 (Esc, Win-жесты).
// Выделено из windowsManager.ts: оба сценария крутятся вокруг одного
// флага ws.contentFullscreen и обязаны отрабатывать одинаково.
//
// Зависимость от layout вынесена параметром: иначе fullscreen.ts ←
// windowsManager (layoutActiveView) и windowsManager ← fullscreen
// (toggle) давали бы циклический импорт. Вызывающая сторона передаёт
// свой layoutActiveView.
//
// ГРАНИЦА ФАЙЛА: только переключение и сброс контентного режима.
// Чтение флага (layoutView) живёт в windowsManager, применение
// fullscreenMode в settings:save — в store/ipc.
import { getSettingsSync } from '../store/settingsStore'
import type { WindowState } from './browserState'

type LayoutFn = (ws: WindowState) => void

// F11: сценарий из настроек. 'window' — fullscreen всего окна,
// 'content' — только WebContentsView (панели прячутся через shell).
// Контентный режим тоже разворачивает ОКНО на весь экран (иначе видны
// смещение окна и таскбар), но панели скрыты и view занимает все окно.
// Исходные bounds запоминаем: setFullScreen(false) сам их не вернет,
// т.к. окно уже было немаксимизированным — восстанавливаем вручную.
export function toggleFullscreenMode(ws: WindowState, layout: LayoutFn): boolean {
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
    layout(ws)
    ws.window.webContents.send('window:content-fullscreen', ws.contentFullscreen)
    return ws.contentFullscreen
  }
  ws.window.setFullScreen(!ws.window.isFullScreen())
  return ws.window.isFullScreen()
}

// Выход из fullscreen не через F11: контентный режим сбрасываем,
// иначе панели останутся скрытыми в обычном окне. Исконные bounds
// возвращаем — fullscreen их затёр.
export function clearContentFullscreen(ws: WindowState, layout: LayoutFn): void {
  if (!ws.contentFullscreen) return
  ws.contentFullscreen = false
  if (ws.savedBounds && !ws.window?.isDestroyed()) {
    ws.window?.setBounds(ws.savedBounds)
    ws.savedBounds = undefined
  }
  layout(ws)
  ws.window?.webContents.send('window:content-fullscreen', false)
}
