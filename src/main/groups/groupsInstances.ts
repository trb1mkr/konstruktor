// Открытые экземпляры групп: alloc, sync urls, open/create/close/add/remove.
// Выделено из groupsManager.ts: здесь мутации WindowState.openGroups + вкладки.
// Меню (groups:context-menu) и nest/unnest живут в groupsMenu.ts.
import type { WindowState } from '../windows/browserState'
import { ensureStripToken, removeStripToken, moveStripToken } from '../tabs/stripOrder'
import { getGroups, createSavedGroup, updateSavedGroup } from './groupsStore'
import { START_URL } from '../pages/internalPages'

let nextInstance = 1

export function allocInstance(): string {
  return `i${nextInstance++}`
}

export function syncSavedUrls(ws: WindowState, instanceId: string): void {
  const urls = ws.tabOrder
    .map((id) => ws.tabs.get(id))
    .filter((t) => t && t.groupId === instanceId)
    .map((t) => t!.url)
    .filter((u) => u && u !== 'about:blank')
  const inst = ws.openGroups.find((g) => g.instanceId === instanceId)
  if (!inst || urls.length === 0) return
  void updateSavedGroup(inst.savedId, { urls }).catch(() => undefined)
}

export interface GroupTabDeps {
  createTab: (ws: WindowState, url?: string) => number
  closeTab: (ws: WindowState, id: number) => void
  setActiveTab: (ws: WindowState, id: number) => void
  pushTabsState: (ws: WindowState) => void
  pruneEmptyGroup: (ws: WindowState, instanceId: string) => void
}

// Открыть шаблон: новый экземпляр, можно несколько одинаковых.
// Дочерние группы открываются рекурсивно внутрь родителя.
export function openInstance(
  ws: WindowState,
  deps: GroupTabDeps,
  savedId: string,
  parentInstanceId?: string
): string | null {
  void (async () => {
    const list = await getGroups()
    const byId = new Map(list.map((g) => [g.id, g]))
    const openRec = (id: string, parent?: string, seen: string[] = []): void => {
      if (seen.includes(id)) return
      const s = byId.get(id)
      if (!s) return
      const instanceId = allocInstance()
      ws.openGroups.push({ instanceId, savedId: s.id, collapsed: false, pinned: false, parentInstanceId: parent })
      // В единый ряд — только корневые: вложенные рисуются внутри родителя.
      if (!parent) ensureStripToken(ws, `g:${instanceId}`, false)
      for (const url of s.urls.length > 0 ? s.urls : [START_URL]) {
        const tabId = deps.createTab(ws, url)
        ws.tabs.get(tabId)!.groupId = instanceId
        removeStripToken(ws, `t:${tabId}`)
      }
      for (const child of s.children) openRec(child, instanceId, [...seen, id])
    }
    openRec(savedId, parentInstanceId)
    deps.pushTabsState(ws)
  })()
  return ws.openGroups[ws.openGroups.length - 1]?.instanceId ?? null
}

// Создать шаблон + сразу открыть экземпляр в этом окне.
export async function createAndOpen(
  ws: WindowState,
  deps: GroupTabDeps,
  input: { name?: string; icon?: string; color?: string; pinned?: boolean }
): Promise<{ savedId: string; instanceId: string }> {
  const saved = await createSavedGroup({
    name: input.name ?? 'Group',
    icon: input.icon ?? '',
    color: input.color ?? '#888888',
    urls: [START_URL],
    pinned: input.pinned
  })
  const instanceId = allocInstance()
  ws.openGroups.push({ instanceId, savedId: saved.id, collapsed: false, pinned: false })
  ensureStripToken(ws, `g:${instanceId}`, false)
  const id = deps.createTab(ws, START_URL)
  ws.tabs.get(id)!.groupId = instanceId
  removeStripToken(ws, `t:${id}`)
  deps.pushTabsState(ws)
  return { savedId: saved.id, instanceId }
}

export function toggleCollapse(ws: WindowState, deps: GroupTabDeps, instanceId: string): boolean {
  const g = ws.openGroups.find((x) => x.instanceId === instanceId)
  if (!g) return false
  g.collapsed = !g.collapsed
  // Свернутая группа прячет view, кроме активной — иначе пустой экран.
  for (const [id, rec] of ws.tabs) {
    if (rec.groupId !== instanceId) continue
    if (id === ws.activeTabId) continue
    rec.view.setVisible(!g.collapsed)
  }
  deps.pushTabsState(ws)
  return g.collapsed
}

export function togglePin(ws: WindowState, deps: GroupTabDeps, instanceId: string): boolean {
  const g = ws.openGroups.find((x) => x.instanceId === instanceId)
  if (!g) return false
  g.pinned = !g.pinned
  // Пин двигает корневую группу между зонами единого ряда.
  if (!g.parentInstanceId) moveStripToken(ws, `g:${instanceId}`, g.pinned)
  deps.pushTabsState(ws)
  return g.pinned
}

// Поднять вложенный экземпляр на верхний уровень панели.
export function promoteToRoot(ws: WindowState, instanceId: string): void {
  const inst = ws.openGroups.find((g) => g.instanceId === instanceId)
  if (!inst) return
  inst.parentInstanceId = undefined
  ensureStripToken(ws, `g:${instanceId}`, inst.pinned)
}

// Убрать экземпляр внутрь родителя: из единого ряда уходит.
export function demoteToChild(ws: WindowState, instanceId: string, parentInstanceId: string): void {
  const inst = ws.openGroups.find((g) => g.instanceId === instanceId)
  if (!inst) return
  inst.parentInstanceId = parentInstanceId
  removeStripToken(ws, `g:${instanceId}`)
}

// Удалить все экземпляры шаблона из окна: вкладки разгруппировываются и живут.
export function removeSavedInstances(ws: WindowState, savedId: string): void {
  for (const g of ws.openGroups.filter((x) => x.savedId === savedId)) {
    for (const [, rec] of ws.tabs) {
      if (rec.groupId === g.instanceId) rec.groupId = undefined
    }
    removeStripToken(ws, `g:${g.instanceId}`)
  }
  ws.openGroups = ws.openGroups.filter((x) => x.savedId !== savedId)
}
