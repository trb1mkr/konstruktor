// Роутинг konstruktor://: один хендл на схему, роутинг по host.
// Выделено из index.ts. protocol.handle привязан к сессии — хендл
// регистрируется на всех трёх партициях, иначе view с persist-партицией
// не резолвит konstruktor://*.
//
// HTML собирается на каждый запрос с текущим языком: готовая строка
// при импорте модуля успела бы устареть к моменту смены настроек.
import {
  buildStartPage,
  buildHistoryPage,
  buildSettingsPage,
  buildDownloadsPage,
  buildExtensionsPage,
  buildPermissionsPage
} from './internalPages'
import { currentLang, t } from '../i18n'
import { readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { findExtensionRecord } from '../extensions/extensionStore'

// MIME собственной страницы расширения: konstruktor://ext/<id>/<файл>.
const EXT_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

// Файл расширения отдаётся только из его каталога: попытка выйти за
// пределы через '..' возвращает 404, а не содержимое чужого файла.
async function serveExtensionFile(extId: string, rel: string): Promise<Response> {
  const rec = findExtensionRecord(extId)
  if (!rec) return new Response(t('internal.notFound'), { status: 404 })
  const root = resolve(rec.dir) + sep
  const target = resolve(join(rec.dir, rel || 'page.html'))
  if (!target.startsWith(root)) return new Response(t('internal.notFound'), { status: 404 })
  try {
    const data = await readFile(target)
    const mime = EXT_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    return new Response(new Uint8Array(data), { headers: { 'content-type': mime } })
  } catch {
    return new Response(t('internal.notFound'), { status: 404 })
  }
}

export function registerInternalProtocol(ses: Electron.Session): void {
  try {
    ses.protocol.handle('konstruktor', async (req) => {
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
      if (host === 'extensions') {
        return new Response(buildExtensionsPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      if (host === 'permissions') {
        return new Response(buildPermissionsPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      // Страницы собственных расширений: konstruktor://ext/<id>/<файл>.
      if (host === 'ext') {
        const parts = new URL(req.url).pathname.split('/').filter(Boolean)
        const extId = parts.shift() ?? ''
        return serveExtensionFile(extId, parts.join('/'))
      }
      return new Response(t('internal.notFound'), { status: 404 })
    })
  } catch {
    // Хендл уже зарегистрирован для этой сессии — игнорим.
  }
}
