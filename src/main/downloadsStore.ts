import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

// Загрузки: JSON-файл в userData, один источник истины в main.
// Инкогнито-окна не пишут историю загрузок (файл все равно качается).
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
let filePath = ''
let cache: DownloadEntry[] | null = null

async function path(): Promise<string> {
  if (!filePath) filePath = join(app.getPath('userData'), 'downloads.json')
  return filePath
}

async function load(): Promise<DownloadEntry[]> {
  if (cache) return cache
  try {
    const raw = await readFile(await path(), 'utf-8')
    const parsed = JSON.parse(raw) as DownloadEntry[]
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(await path(), JSON.stringify(cache), 'utf-8')
}

export function newDownloadId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function addDownload(entry: DownloadEntry): Promise<void> {
  const list = await load()
  list.unshift(entry)
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
  await save()
}

export async function updateDownload(
  id: string,
  patch: Partial<Pick<DownloadEntry, 'totalBytes' | 'receivedBytes' | 'state' | 'endedAt' | 'path' | 'filename'>>
): Promise<DownloadEntry | undefined> {
  const list = await load()
  const found = list.find((e) => e.id === id)
  if (!found) return undefined
  Object.assign(found, patch)
  await save()
  return { ...found }
}

export async function getDownloads(limit = 200): Promise<DownloadEntry[]> {
  return (await load()).slice(0, limit)
}

export async function searchDownloads(query: string, limit = 100): Promise<DownloadEntry[]> {
  const q = query.trim().toLowerCase()
  if (!q) return getDownloads(limit)
  return (await load())
    .filter(
      (e) => e.filename.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
    )
    .slice(0, limit)
}

export async function removeDownload(id: string): Promise<void> {
  const list = await load()
  cache = list.filter((e) => e.id !== id)
  await save()
}

export async function clearDownloads(): Promise<void> {
  cache = []
  await save()
}
