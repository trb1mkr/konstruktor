// Роутинг konstruktor://: один хендл на схему, роутинг по host.
// Выделено из index.ts. protocol.handle привязан к сессии — хендл
// регистрируется на всех трёх партициях, иначе view с persist-партицией
// не резолвит konstruktor://*.
//
// HTML собирается на каждый запрос с текущим языком: готовая строка
// при импорте модуля успела бы устареть к моменту смены настроек.
import { buildStartPage, buildHistoryPage, buildSettingsPage, buildDownloadsPage } from './internalPages'
import { currentLang, t } from '../i18n'

export function registerInternalProtocol(ses: Electron.Session): void {
  try {
    ses.protocol.handle('konstruktor', (req) => {
      const host = new URL(req.url).host
      const lang = currentLang()
      if (host === 'start') {
        return new Response(buildStartPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      if (host === 'history') {
        return new Response(buildHistoryPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      if (host === 'settings') {
        return new Response(buildSettingsPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      if (host === 'downloads') {
        return new Response(buildDownloadsPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      return new Response(t('internal.notFound'), { status: 404 })
    })
  } catch {
    // Хендл уже зарегистрирован для этой сессии — игнорим.
  }
}
