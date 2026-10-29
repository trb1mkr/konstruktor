import { readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'

// Плитки табло стартовой страницы: каталог пространства, shortcuts.json.
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

// Кэш по пространствам: у каждого свой набор плиток.
const caches = new Map<string, Shortcut[]>()

function fileOf(wsId: string): string {
  return workspaceFile(wsId, 'shortcuts.json')
}

async function save(wsId: string): Promise<void> {
  const list = caches.get(wsId)
  if (!list) return
  await writeJsonAtomic(fileOf(wsId), list)
}

async function load(wsId: string): Promise<Shortcut[]> {
  const cached = caches.get(wsId)
  if (cached) return cached
  let next: Shortcut[]
  try {
    const raw = await readFile(fileOf(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as Shortcut[]
    next = Array.isArray(parsed) ? parsed : [...DEFAULTS]
  } catch {
    next = [...DEFAULTS]
  }
  // Миграция: убираем example.com из старых файлов.
  const filtered = next.filter((s) => !s.url.includes('example.com'))
  if (filtered.length !== next.length) {
    caches.set(wsId, filtered)
    await save(wsId)
    return filtered
  }
  caches.set(wsId, next)
  return next
}

export async function getShortcuts(wsId = bootWorkspaceId()): Promise<Shortcut[]> {
  return [...(await load(wsId))]
}

export async function addShortcut(
  input: { name?: string; url: string },
  wsId = bootWorkspaceId()
): Promise<Shortcut[]> {
  const list = await load(wsId)
  let url = input.url.trim()
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url
  const existing = list.find((s) => s.url === url)
  if (existing) {
    if (input.name) existing.name = input.name
  } else {
    list.push({ name: input.name || url, url, favicon: '' })
  }
  await save(wsId)
  return [...list]
}

export async function removeShortcut(url: string, wsId = bootWorkspaceId()): Promise<Shortcut[]> {
  const list = await load(wsId)
  const next = list.filter((s) => s.url !== url)
  caches.set(wsId, next)
  await save(wsId)
  return [...next]
}
