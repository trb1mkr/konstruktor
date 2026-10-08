import { session } from 'electron'
import { join } from 'path'

// Мост внутренних страниц (konstruktor://history, konstruktor://settings).
// У WebContentsView нет своего preload через webPreferences — вместо этого
// регистрируем скрипт на сессию: ses.registerPreloadScript({ type: 'frame' })
// выполняется в каждом фрейме до загрузки документа, contextBridge доступен.
// Вызывать ОДИН раз на партицию при старте приложения.
export function registerInternalPreload(ses: Electron.Session): void {
  // CJS-билд (format: 'cjs' в electron.vite.config): песочница view
  // не понимает ESM-import, только require.
  const preloadPath = join(__dirname, '../preload/internal.cjs')
  try {
    ses.registerPreloadScript({
      type: 'frame',
      id: 'konstruktor-internal',
      filePath: preloadPath
    })
  } catch {
    // Уже зарегистрирован — игнорим.
  }
  void session
}
