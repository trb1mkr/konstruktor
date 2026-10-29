// Закладки: bookmarks.json в каталоге рабочего пространства.
//
// До появления пространств закладки жили в localStorage шелла, а шелл
// работает в in-memory партиции — значит они не переживали перезапуск
// вовсе. Закладки принадлежат пространству, поэтому их место здесь, рядом
// с историей и группами.
import { readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'

export interface Bookmark {
  title: string
  url: string
  favicon: string
  // Время добавления: порядок в панели и будущее слияние при синхронизации.
  addedAt: number
}

// Кэш по пространствам.
const caches = new Map<string, Bookmark[]>()

function fileOf(wsId: string): string {
  return workspaceFile(wsId, 'bookmarks.json')
}

async function load(wsId: string): Promise<Bookmark[]> {
  const cached = caches.get(wsId)
  if (cached) return cached
  let list: Bookmark[] = []
  try {
    const raw = await readFile(fileOf(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as Bookmark[]
    if (Array.isArray(parsed)) {
      list = parsed
        .filter((b) => b && typeof b.url === 'string' && b.url.length > 0)
        .map((b) => ({
          title: typeof b.title === 'string' && b.title ? b.title : b.url,
          url: b.url,
          favicon: typeof b.favicon === 'string' ? b.favicon : '',
          addedAt: typeof b.addedAt === 'number' ? b.addedAt : Date.now()
        }))
    }
  } catch {
    // Файла нет — закладок ещё нет.
  }
  caches.set(wsId, list)
  return list
}

async function save(wsId: string): Promise<void> {
  const list = caches.get(wsId)
  if (!list) return
  await writeJsonAtomic(fileOf(wsId), list)
}

export async function getBookmarks(wsId = bootWorkspaceId()): Promise<Bookmark[]> {
  return [...(await load(wsId))]
}

export function getBookmarksSync(wsId = bootWorkspaceId()): Bookmark[] {
  return [...(caches.get(wsId) ?? [])]
}

/**
 * Тоггл закладки по URL: страница уже в списке — снимаем, иначе добавляем.
 * Возвращает новый список: панель рисует его без отдельного чтения.
 */
export async function toggleBookmark(
  input: { title: string; url: string; favicon?: string },
  wsId = bootWorkspaceId()
): Promise<Bookmark[]> {
  const list = await load(wsId)
  const url = input.url.trim()
  if (!url) return [...list]
  const at = list.findIndex((b) => b.url === url)
  if (at >= 0) {
    list.splice(at, 1)
  } else {
    list.push({
      title: input.title || url,
      url,
      favicon: input.favicon ?? '',
      addedAt: Date.now()
    })
  }
  await save(wsId)
  return [...list]
}

export async function removeBookmark(url: string, wsId = bootWorkspaceId()): Promise<Bookmark[]> {
  const list = await load(wsId)
  const next = list.filter((b) => b.url !== url)
  caches.set(wsId, next)
  await save(wsId)
  return [...next]
}

/** Массовая замена списка — импорт секции из другого пространства. */
export async function replaceBookmarks(
  list: Bookmark[],
  wsId = bootWorkspaceId()
): Promise<Bookmark[]> {
  const next = list
    .filter((b) => b && typeof b.url === 'string' && b.url.length > 0)
    .map((b) => ({
      title: b.title || b.url,
      url: b.url,
      favicon: b.favicon ?? '',
      addedAt: b.addedAt ?? Date.now()
    }))
  caches.set(wsId, next)
  await save(wsId)
  return [...next]
}
