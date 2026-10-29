import { readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'

// Загрузки: JSON в каталоге рабочего пространства, один источник истины в
// main. Инкогнито-окна не пишут историю загрузок (файл все равно качается).
export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadEntry {
  id: string
  url: string
  filename: string
  path: string
  totalBytes: number
  receivedBytes: number
  state: DownloadState
  startedAt: number
  endedAt: number | null
}

const MAX_ENTRIES = 200

// Кэш по пространствам: у каждого свой файл.
const caches = new Map<string, DownloadEntry[]>()

function fileOf(wsId: string): string {
  return workspaceFile(wsId, 'downloads.json')
}

async function load(wsId: string): Promise<DownloadEntry[]> {
  const cached = caches.get(wsId)
  if (cached) return cached
  let next: DownloadEntry[] = []
  try {
    const raw = await readFile(fileOf(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as DownloadEntry[]
    next = Array.isArray(parsed) ? parsed : []
  } catch {
    // Нет файла или битый JSON — загрузок ещё нет.
  }
  caches.set(wsId, next)
  return next
}

async function save(wsId: string): Promise<void> {
  const list = caches.get(wsId)
  if (!list) return
  await writeJsonAtomic(fileOf(wsId), list)
}

export function newDownloadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function addDownload(entry: DownloadEntry, wsId = bootWorkspaceId()): Promise<void> {
  const list = await load(wsId)
  list.unshift(entry)
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
  await save(wsId)
}

export async function updateDownload(
  id: string,
  patch: Partial<
    Pick<DownloadEntry, 'totalBytes' | 'receivedBytes' | 'state' | 'endedAt' | 'path' | 'filename'>
  >,
  wsId = bootWorkspaceId()
): Promise<DownloadEntry | undefined> {
  const list = await load(wsId)
  const found = list.find((e) => e.id === id)
  if (!found) return undefined
  Object.assign(found, patch)
  await save(wsId)
  return { ...found }
}

export async function getDownloads(limit = 200, wsId = bootWorkspaceId()): Promise<DownloadEntry[]> {
  return (await load(wsId)).slice(0, limit)
}

export async function searchDownloads(
  query: string,
  limit = 100,
  wsId = bootWorkspaceId()
): Promise<DownloadEntry[]> {
  const q = query.trim().toLowerCase()
  if (!q) return getDownloads(limit, wsId)
  return (await load(wsId))
    .filter(
      (e) => e.filename.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
    )
    .slice(0, limit)
}

export async function removeDownload(id: string, wsId = bootWorkspaceId()): Promise<void> {
  const list = await load(wsId)
  caches.set(
    wsId,
    list.filter((e) => e.id !== id)
  )
  await save(wsId)
}

export async function clearDownloads(wsId = bootWorkspaceId()): Promise<void> {
  caches.set(wsId, [])
  await save(wsId)
}
