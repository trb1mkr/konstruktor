import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

// История посещений: JSON-файл в userData, один источник истины в main.
// Renderer ходит через IPC, инкогнито-окна не пишут и не читают.
// Модель: одна строка на URL + массив меток визитов. Счётчик = visits.length,
// время последнего визита = visits[0]. Старый формат (visitedAt/visitCount)
// мигрируется при загрузке: visitCount превращается в N меток.
export interface HistoryEntry {
  url: string
  title: string
  favicon: string
  visits: number[]
}

// Совместимость со старым файлом: visitedAt + visitCount без visits.
interface LegacyEntry {
  url: string
  title: string
  favicon: string
  visitedAt?: number
  visitCount?: number
  visits?: number[]
}

const MAX_ENTRIES = 1000
// Храним не больше N меток на URL, чтобы файл не рос бесконечно.
const MAX_VISITS_PER_URL = 500
let filePath = ''
let cache: HistoryEntry[] | null = null

async function path(): Promise<string> {
  if (!filePath) filePath = join(app.getPath('userData'), 'history.json')
  return filePath
}

async function load(): Promise<HistoryEntry[]> {
  if (cache) return cache
  try {
    const raw = await readFile(await path(), 'utf-8')
    const parsed = JSON.parse(raw) as LegacyEntry[]
    cache = Array.isArray(parsed) ? parsed.map(migrateEntry).filter((e) => e.visits.length > 0) : []
  } catch {
    cache = []
  }
  return cache
}

// Миграция старой записи: visitCount меток на момент visitedAt.
// Новые записи уже содержат visits — только нормализуем сортировку.
function migrateEntry(raw: LegacyEntry): HistoryEntry {
  if (Array.isArray(raw.visits) && raw.visits.length > 0) {
    return {
      url: raw.url,
      title: raw.title,
      favicon: raw.favicon ?? '',
      visits: [...raw.visits].sort((a, b) => b - a).slice(0, MAX_VISITS_PER_URL)
    }
  }
  const at = raw.visitedAt ?? Date.now()
  const count = Math.max(1, raw.visitCount ?? 1)
  return {
    url: raw.url,
    title: raw.title,
    favicon: raw.favicon ?? '',
    visits: Array.from({ length: Math.min(count, MAX_VISITS_PER_URL) }, () => at)
  }
}

async function save(): Promise<void> {
  if (!cache) return
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(await path(), JSON.stringify(cache), 'utf-8')
}

// Внутренние страницы не пишем.
function isSkippable(url: string): boolean {
  return (
    url === 'about:blank' ||
    url.startsWith('konstruktor://') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome://')
  )
}

export async function recordVisit(entry: {
  url: string
  title: string
  favicon: string
}): Promise<void> {
  if (isSkippable(entry.url)) return
  const list = await load()
  const now = Date.now()
  const existing = list.find((e) => e.url === entry.url)
  if (existing) {
    existing.title = entry.title || existing.title
    existing.favicon = entry.favicon || existing.favicon
    existing.visits.unshift(now)
    if (existing.visits.length > MAX_VISITS_PER_URL) {
      existing.visits.length = MAX_VISITS_PER_URL
    }
    // Поднимаем вверх.
    list.splice(list.indexOf(existing), 1)
    list.unshift(existing)
  } else {
    list.unshift({
      url: entry.url,
      title: entry.title || entry.url,
      favicon: entry.favicon,
      visits: [now]
    })
  }
  // Жесткий лимит, чтобы файл не рос бесконечно.
  if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES
  await save()
}

// Обновление метаданных без нового визита: заголовок и иконка прилетают
// ПОЗЖЕ навигации (page-title-updated / page-favicon-updated).
// Счётчик и время не трогаем, порядок не меняем — иначе один заход
// считается за два (это и давало лишний ×2).
export async function updateMetadata(
  url: string,
  patch: { title?: string; favicon?: string }
): Promise<void> {
  if (isSkippable(url)) return
  if (!patch.title && !patch.favicon) return
  const list = await load()
  const existing = list.find((e) => e.url === url)
  if (!existing) return
  if (patch.title) existing.title = patch.title
  if (patch.favicon) existing.favicon = patch.favicon
  await save()
}

export async function getHistory(limit = 200): Promise<HistoryEntry[]> {
  return (await load()).slice(0, limit)
}

export async function searchHistory(query: string, limit = 50): Promise<HistoryEntry[]> {
  const q = query.trim().toLowerCase()
  if (!q) return getHistory(limit)
  return (await load())
    .filter(
      (e) => e.url.toLowerCase().includes(q) || e.title.toLowerCase().includes(q)
    )
    .slice(0, limit)
}

// Хронология: плоский список визитов для группировки по дням/месяцам/годам.
// Один URL с N визитами даёт N строк — страница истории строит дерево сама.
export interface VisitRow {
  url: string
  title: string
  favicon: string
  at: number
}

export async function getTimeline(query = '', limit = 2000): Promise<VisitRow[]> {
  const q = query.trim().toLowerCase()
  const rows: VisitRow[] = []
  for (const e of await load()) {
    if (q && !e.url.toLowerCase().includes(q) && !e.title.toLowerCase().includes(q)) continue
    for (const at of e.visits) {
      rows.push({ url: e.url, title: e.title, favicon: e.favicon, at })
      if (rows.length >= limit) break
    }
    if (rows.length >= limit) break
  }
  // Список уже отсортирован по последнему визиту; внутри — по убыванию времени.
  rows.sort((a, b) => b.at - a.at)
  return rows.slice(0, limit)
}

// Удаление одного визита (точка в хронологии), а не всего URL.
export async function deleteVisit(url: string, at: number): Promise<void> {
  const list = await load()
  const existing = list.find((e) => e.url === url)
  if (!existing) return
  existing.visits = existing.visits.filter((t) => t !== at)
  if (existing.visits.length === 0) {
    cache = list.filter((e) => e !== existing)
  }
  await save()
}

export async function deleteEntry(url: string): Promise<void> {
  const list = await load()
  cache = list.filter((e) => e.url !== url)
  await save()
}

export async function clearHistory(): Promise<void> {
  cache = []
  await save()
}
