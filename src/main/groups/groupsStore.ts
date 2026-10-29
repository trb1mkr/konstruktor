// Сохраненные группы вкладок: groups.json в каталоге рабочего пространства.
// Группа — вложенная структура: children содержит id дочерних групп,
// дерево строится в renderer по этому полю. Закрепление на панели
// закладок — флаг pinned: незакрепленная группа живет только на панели
// вкладок, пока открыта.
import { readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'

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

// Кэш шаблонов и счётчик id — по пространствам: id вида g<N> уникальны
// внутри своего файла, и общий счётчик выдавал бы дыры в нумерации.
const caches = new Map<string, SavedGroup[]>()
const nextIds = new Map<string, number>()

function fileOf(wsId: string): string {
  return workspaceFile(wsId, 'groups.json')
}

async function load(wsId: string): Promise<SavedGroup[]> {
  const cached = caches.get(wsId)
  if (cached) return cached
  let list: SavedGroup[]
  try {
    const raw = await readFile(fileOf(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as SavedGroup[]
    list = Array.isArray(parsed) ? parsed : []
  } catch {
    list = []
  }
  // Миграция со старого формата: добиваем children/pinned.
  for (const g of list) {
    if (!Array.isArray(g.children)) g.children = []
    if (typeof g.pinned !== 'boolean') g.pinned = true
  }
  // Счетчик id продолжаем после максимального сохраненного.
  let next = 1
  for (const g of list) {
    const m = /^g(\d+)$/.exec(g.id)
    if (m) next = Math.max(next, Number(m[1]) + 1)
  }
  nextIds.set(wsId, next)
  caches.set(wsId, list)
  return list
}

async function save(wsId: string): Promise<void> {
  const list = caches.get(wsId)
  if (!list) return
  await writeJsonAtomic(fileOf(wsId), list)
}

export async function getGroups(wsId = bootWorkspaceId()): Promise<SavedGroup[]> {
  return (await load(wsId)).map((g) => ({ ...g, children: [...g.children] }))
}

export async function createSavedGroup(
  input: {
    name: string
    icon?: string
    color?: string
    urls?: string[]
    pinned?: boolean
  },
  wsId = bootWorkspaceId()
): Promise<SavedGroup> {
  const list = await load(wsId)
  const idNumber = nextIds.get(wsId) ?? 1
  const g: SavedGroup = {
    id: `g${idNumber}`,
    name: input.name.trim() || 'Group',
    icon: input.icon ?? '',
    color: input.color ?? '#888888',
    urls: (input.urls ?? []).filter((u) => u && u !== 'about:blank'),
    children: [],
    pinned: input.pinned ?? true
  }
  nextIds.set(wsId, idNumber + 1)
  // Минимум 1 вкладка: пустую группу открываем со стартовой.
  if (g.urls.length === 0) g.urls = ['konstruktor://start']
  list.push(g)
  await save(wsId)
  return { ...g, children: [...g.children] }
}

export async function updateSavedGroup(
  id: string,
  patch: Partial<Pick<SavedGroup, 'name' | 'icon' | 'color' | 'urls' | 'children' | 'pinned'>>,
  wsId = bootWorkspaceId()
): Promise<SavedGroup | null> {
  const list = await load(wsId)
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
  await save(wsId)
  return { ...g, children: [...g.children] }
}

export async function deleteSavedGroup(
  id: string,
  wsId = bootWorkspaceId()
): Promise<boolean> {
  const list = await load(wsId)
  const at = list.findIndex((x) => x.id === id)
  if (at < 0) return false
  list.splice(at, 1)
  await save(wsId)
  return true
}
