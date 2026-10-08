// Сохраненные группы вкладок: userData/groups.json.
// Группа — вложенная структура: children содержит id дочерних групп,
// дерево строится в renderer по этому полю. Закрепление на панели
// закладок — флаг pinned: незакрепленная группа живет только на панели
// вкладок, пока открыта.
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

export interface SavedGroup {
  id: string
  name: string
  icon: string
  color: string
  urls: string[]
  // id дочерних групп: группа содержит вкладки (urls) и другие группы.
  children: string[]
  // Показывать ли шаблон на панели закладок, когда группа закрыта.
  pinned: boolean
}

let filePath = ''
let cache: SavedGroup[] | null = null
let nextId = 1

async function load(): Promise<SavedGroup[]> {
  if (cache) return cache
  try {
    const raw = await readFile(filePath || join(app.getPath('userData'), 'groups.json'), 'utf-8')
    const parsed = JSON.parse(raw) as SavedGroup[]
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  // Миграция со старого формата: добиваем children/pinned.
  for (const g of cache) {
    if (!Array.isArray(g.children)) g.children = []
    if (typeof g.pinned !== 'boolean') g.pinned = true
  }
  // Счетчик id продолжаем после максимального сохраненного.
  for (const g of cache) {
    const m = /^g(\d+)$/.exec(g.id)
    if (m) nextId = Math.max(nextId, Number(m[1]) + 1)
  }
  return cache
}

async function save(): Promise<void> {
  if (!cache) return
  filePath = filePath || join(app.getPath('userData'), 'groups.json')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(filePath, JSON.stringify(cache, null, 2), 'utf-8')
}

export async function getGroups(): Promise<SavedGroup[]> {
  return (await load()).map((g) => ({ ...g, children: [...g.children] }))
}

export async function createSavedGroup(input: {
  name: string
  icon?: string
  color?: string
  urls?: string[]
  pinned?: boolean
}): Promise<SavedGroup> {
  const list = await load()
  const g: SavedGroup = {
    id: `g${nextId++}`,
    name: input.name.trim() || 'Group',
    icon: input.icon ?? '',
    color: input.color ?? '#888888',
    urls: (input.urls ?? []).filter((u) => u && u !== 'about:blank'),
    children: [],
    pinned: input.pinned ?? true
  }
  // Минимум 1 вкладка: пустую группу открываем со стартовой.
  if (g.urls.length === 0) g.urls = ['konstruktor://start']
  list.push(g)
  await save()
  return { ...g, children: [...g.children] }
}

export async function updateSavedGroup(
  id: string,
  patch: Partial<Pick<SavedGroup, 'name' | 'icon' | 'color' | 'urls' | 'children' | 'pinned'>>
): Promise<SavedGroup | null> {
  const list = await load()
  const g = list.find((x) => x.id === id)
  if (!g) return null
  if (patch.name !== undefined) g.name = patch.name.trim() || g.name
  if (patch.icon !== undefined) g.icon = patch.icon
  if (patch.color !== undefined) g.color = patch.color
  if (patch.urls !== undefined) {
    const urls = patch.urls.filter((u) => u && u !== 'about:blank')
    g.urls = urls.length > 0 ? urls : ['konstruktor://start']
  }
  if (patch.children !== undefined) {
    // Без циклов: нельзя вложить группу в саму себя.
    g.children = patch.children.filter((c) => c !== id && list.some((x) => x.id === c))
  }
  if (patch.pinned !== undefined) g.pinned = patch.pinned
  await save()
  return { ...g, children: [...g.children] }
}

export async function deleteSavedGroup(id: string): Promise<boolean> {
  const list = await load()
  const at = list.findIndex((x) => x.id === id)
  if (at < 0) return false
  list.splice(at, 1)
  await save()
  return true
}
