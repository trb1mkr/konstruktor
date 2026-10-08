import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

// Плитки табло стартовой страницы: userData/shortcuts.json.
// Правятся прямо на konstruktor://start (add/remove), мост window.konstruktor.
export interface Shortcut {
  name: string
  url: string
  favicon: string
}

const DEFAULTS: Shortcut[] = [
  { name: 'Wikipedia', url: 'https://wikipedia.org', favicon: '' },
  { name: 'GitHub', url: 'https://github.com', favicon: '' }
]

let filePath = ''
let cache: Shortcut[] | null = null

async function load(): Promise<Shortcut[]> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath || join(app.getPath('userData'), 'shortcuts.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Shortcut[]
    cache = Array.isArray(parsed) ? parsed : [...DEFAULTS]
  } catch {
    cache = [...DEFAULTS]
  }
  // Миграция: убираем example.com из старых файлов.
  const filtered = cache.filter((s) => !s.url.includes('example.com'))
  if (filtered.length !== cache.length) {
    cache = filtered
    await save()
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  filePath = filePath || join(app.getPath('userData'), 'shortcuts.json')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getShortcuts(): Promise<Shortcut[]> {
  return [...(await load())]
}

export async function addShortcut(input: { name?: string; url: string }): Promise<Shortcut[]> {
  const list = await load()
  let url = input.url.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url
  const existing = list.find((s) => s.url === url)
  if (existing) {
    if (input.name) existing.name = input.name
  } else {
    list.push({ name: input.name || url, url, favicon: '' })
  }
  await save()
  return [...list]
}

export async function removeShortcut(url: string): Promise<Shortcut[]> {
  const list = await load()
  cache = list.filter((s) => s.url !== url)
  await save()
  return [...(cache ?? [])]
}
