// Роутинг konstruktor://: один хендл на схему, роутинг по host.
// Выделено из index.ts. protocol.handle привязан к сессии — хендл
// регистрируется на каждой партиции пространства (обычной и приватной),
// иначе view с persist-партицией не резолвит konstruktor://*.
//
// Пространство передаётся замыканием: страница обслуживает данные того
// пространства, чья это сессия, а по запросу партицию не узнать.
//
// HTML собирается на каждый запрос с языком СВОЕГО пространства: язык —
// настройка пространства, а окна разных пространств живут одновременно.
// Готовая строка при импорте модуля успела бы устареть к моменту смены
// настроек.
import {
  buildStartPage,
  buildHistoryPage,
  buildSettingsPage,
  buildDownloadsPage,
  buildExtensionsPage,
  buildPermissionsPage,
  buildWorkspacesPage
} from './internalPages'
import { langFor, translatorFor } from '../i18n'
import { readFile } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { findExtensionRecord } from '../extensions/extensionStore'
import { bootWorkspaceId } from '../workspaces/registry'

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
async function serveExtensionFile(extId: string, rel: string, wsId: string): Promise<Response> {
  const t = translatorFor(langFor(wsId))
  const rec = findExtensionRecord(extId, wsId)
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

export function registerInternalProtocol(ses: Electron.Session, wsId = bootWorkspaceId()): void {
  try {
    ses.protocol.handle('konstruktor', async (req) => {
      const host = new URL(req.url).host
      const lang = langFor(wsId)
      const t = translatorFor(lang)
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
      if (host === 'workspaces') {
        return new Response(buildWorkspacesPage(lang), {
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      }
      // Страницы собственных расширений: konstruktor://ext/<id>/<файл>.
      if (host === 'ext') {
        const parts = new URL(req.url).pathname.split('/').filter(Boolean)
        const extId = parts.shift() ?? ''
        return serveExtensionFile(extId, parts.join('/'), wsId)
      }
      return new Response(t('internal.notFound'), { status: 404 })
    })
  } catch {
    // Хендл уже зарегистрирован для этой сессии — игнорим.
  }
}
