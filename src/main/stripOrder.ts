// Единый ряд панели вкладок: токены 't:<id>' и 'g:<instanceId>'.
// Группы того же ранга, что вкладки: таб и группа чередуются свободно.
// Закрепленные живут в pinnedStripOrder, обычные — в stripOrder.
// Вложенные группы (parentInstanceId) в ряд не входят — рисуются внутри родителя.
//
// Инвариант: каждый корневой элемент панели представлен ровно одним токеном
// в ровно одной зоне. Вкладка без группы -> 't:<id>' в stripOrder.
// Корневая группа -> 'g:<instanceId>' в своей зоне по флагу pinned.
// Вкладка внутри группы токена не имеет. Нарушение инварианта = невидимая
// группа или дубль (см. баг stray 't:'-токена у New Group).
import type { WindowState } from './browserState'

export function rootGroupIds(ws: WindowState): string[] {
  return ws.openGroups.filter((g) => !g.parentInstanceId).map((g) => g.instanceId)
}

export function isGroupPinned(ws: WindowState, instanceId: string): boolean {
  return ws.openGroups.find((g) => g.instanceId === instanceId)?.pinned ?? false
}

// Добавить токен в конец нужной зоны, если его там еще нет.
export function ensureStripToken(ws: WindowState, token: string, pinned: boolean): void {
  const arr = pinned ? ws.pinnedStripOrder : ws.stripOrder
  if (!arr.includes(token)) arr.push(token)
}

// Убрать токен из обоих рядов (смена зоны/удаление).
export function removeStripToken(ws: WindowState, token: string): void {
  ws.stripOrder = ws.stripOrder.filter((t) => t !== token)
  ws.pinnedStripOrder = ws.pinnedStripOrder.filter((t) => t !== token)
}

// Переместить токен в нужную зону с сохранением относительного порядка.
export function moveStripToken(ws: WindowState, token: string, pinned: boolean): void {
  removeStripToken(ws, token)
  ensureStripToken(ws, token, pinned)
}

// Пересобрать ряды из текущего состояния: сначала пины, потом обычные.
// Minimize не двигает вкладку: свернутые живут в общем ряду на своём месте.
// pinnedStripOrder — только закрепленные группы, stripOrder — все вкладки + обычные группы.
export function rebuildStripFromTabs(ws: WindowState): void {
  const pinnedTabs: number[] = []
  const normalTabs = ws.tabOrder.filter((id) => {
    const t = ws.tabs.get(id)
    return t && !t.groupId
  })
  const pinnedGroups = rootGroupIds(ws).filter((gid) => isGroupPinned(ws, gid))
  const normalGroups = rootGroupIds(ws).filter((gid) => !isGroupPinned(ws, gid))
  // Сохраняем существующий относительный порядок токенов, добавляем новые в конец.
  const keepOrder = (old: string[], fresh: string[]): string[] => {
    const set = new Set(fresh)
    const kept = old.filter((t) => set.has(t))
    for (const t of fresh) if (!kept.includes(t)) kept.push(t)
    return kept
  }
  ws.pinnedStripOrder = keepOrder(ws.pinnedStripOrder, [
    ...pinnedTabs.map((id) => `t:${id}`),
    ...pinnedGroups.map((gid) => `g:${gid}`)
  ])
  ws.stripOrder = keepOrder(ws.stripOrder, [
    ...normalTabs.map((id) => `t:${id}`),
    ...normalGroups.map((gid) => `g:${gid}`)
  ])
}

// Применить порядок единого ряда от renderer после DnD.
// Minimize не двигает вкладку: все вкладки живут в обычном ряду на своём месте.
// Пины — только для групп. Неизвестные токены отбрасываются, недостающие дописываются в конец.
export function reorderStrip(ws: WindowState, order: string[]): void {
  const knownTabs = new Set(
    ws.tabOrder.filter((id) => {
      const t = ws.tabs.get(id)
      return t && !t.groupId
    }).map((id) => `t:${id}`)
  )
  const knownGroups = new Set(rootGroupIds(ws).map((gid) => `g:${gid}`))
  const pinned: string[] = []
  const normal: string[] = []
  for (const tok of order) {
    if (tok.startsWith('t:')) {
      if (!knownTabs.has(tok)) continue
      const id = Number(tok.slice(2))
      const rec = ws.tabs.get(id)
      if (!rec) continue
      // Вкладки всегда в обычном ряду, minimize на зону не влияет.
      if (!normal.includes(tok)) normal.push(tok)
    } else if (tok.startsWith('g:')) {
      if (!knownGroups.has(tok)) continue
      const gid = tok.slice(2)
      if (isGroupPinned(ws, gid)) { if (!pinned.includes(tok)) pinned.push(tok) }
      else { if (!normal.includes(tok)) normal.push(tok) }
    }
  }
  // Недостающие — в конец своей зоны: вкладки всегда в обычный ряд.
  for (const id of ws.tabOrder) {
    const t = ws.tabs.get(id)
    if (!t || t.groupId) continue
    const tok = `t:${id}`
    if (!pinned.includes(tok) && !normal.includes(tok)) normal.push(tok)
  }
  for (const gid of rootGroupIds(ws)) {
    const tok = `g:${gid}`
    if (isGroupPinned(ws, gid) && !pinned.includes(tok)) pinned.push(tok)
    if (!isGroupPinned(ws, gid) && !normal.includes(tok)) normal.push(tok)
  }
  ws.pinnedStripOrder = pinned
  ws.stripOrder = normal
  // tabOrder синхронизируем с рядом: сначала пины, потом обычные.
  const tabSeq = [...pinned, ...normal]
    .filter((t) => t.startsWith('t:'))
    .map((t) => Number(t.slice(2)))
  const grouped = ws.tabOrder.filter((id) => ws.tabs.get(id)?.groupId)
  ws.tabOrder = [...tabSeq, ...grouped.filter((id) => !tabSeq.includes(id))]
  for (const id of [...ws.tabs.keys()]) {
    if (!ws.tabOrder.includes(id)) ws.tabOrder.push(id)
  }
}

// Проверка инварианта для отладки: возвращает список нарушений.
// Пустой массив = ряд в порядке. Использовать в dev/assert, не в проде на каждый чих.
export function checkStripInvariant(ws: WindowState): string[] {
  const problems: string[] = []
  const all = [...ws.stripOrder, ...ws.pinnedStripOrder]
  const seen = new Set<string>()
  for (const tok of all) {
    if (seen.has(tok)) problems.push(`duplicate token ${tok}`)
    seen.add(tok)
  }
  for (const id of ws.tabOrder) {
    const t = ws.tabs.get(id)
    if (!t) { problems.push(`tabOrder has missing tab ${id}`); continue }
    if (t.groupId) {
      if (all.includes(`t:${id}`)) problems.push(`grouped tab t:${id} still in strip`)
    } else {
      if (!all.includes(`t:${id}`)) problems.push(`ungrouped tab t:${id} missing in strip`)
    }
  }
  for (const gid of rootGroupIds(ws)) {
    if (!all.includes(`g:${gid}`)) problems.push(`root group g:${gid} missing in strip`)
  }
  return problems
}
