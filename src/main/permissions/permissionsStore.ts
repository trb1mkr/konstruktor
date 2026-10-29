// Хранилище решений по разрешениям страниц: origin -> область -> allow/block.
//
// Файл permissions.json в userData, кэш в памяти. Чтение обязано быть
// СИНХРОННЫМ: обработчик проверки разрешения в Electron синхронный
// (`setPermissionCheckHandler` возвращает boolean, а не Promise), а
// обработчик запроса обязан ответить до конца тика, иначе Chromium
// считает запрос потерянным. Поэтому кэш прогрет при старте, а решения
// обновляются в нём ДО записи на диск.
//
// Приватные окна решений не помнят вовсе: их карта живёт только в памяти
// процесса и никогда не попадает в файл. Это осознанное отличие от
// обычных окон — иначе инкогнито оставляло бы след на диске.
import { readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'
import { log, logError } from '../overlay/logger'
import type { Decision, PermissionScope } from './policy'

/** Решения по областям одного сайта. */
export type ScopeDecisions = Partial<Record<PermissionScope, Decision>>
/** Все сайты: origin -> решения. */
export type OriginDecisions = Record<string, ScopeDecisions>

// Кэш решений по пространствам: у каждого свой permissions.json.
const caches = new Map<string, OriginDecisions>()

// Приватный режим: решения живут только в памяти и умирают с процессом.
// Ключ — пространство: у каждого приватная карта своя.
const ephemerals = new Map<string, OriginDecisions>()

function ephemeralOf(wsId: string): OriginDecisions {
  let table = ephemerals.get(wsId)
  if (!table) {
    table = {}
    ephemerals.set(wsId, table)
  }
  return table
}

function fileOf(wsId: string): string {
  return workspaceFile(wsId, 'permissions.json')
}

/** Читает файл один раз и держит результат в кэше. */
export async function loadPermissions(wsId = bootWorkspaceId()): Promise<OriginDecisions> {
  const cached = caches.get(wsId)
  if (cached) return cached
  let next: OriginDecisions = {}
  try {
    const raw = await readFile(fileOf(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as { origins?: OriginDecisions }
    if (parsed && typeof parsed.origins === 'object' && parsed.origins) next = parsed.origins
  } catch {
    // Нет файла или битый JSON — решений ещё нет.
  }
  caches.set(wsId, next)
  return next
}

/**
 * Решение по области для сайта.
 *
 * Синхронно и без async: вызывается из обработчиков разрешений.
 * `persist: false` — приватное окно: решение живёт только в памяти.
 */
export function getDecision(
  origin: string,
  scope: PermissionScope,
  persist: boolean,
  wsId = bootWorkspaceId()
): Decision | undefined {
  const table = persist ? (caches.get(wsId) ?? {}) : ephemeralOf(wsId)
  return table[origin]?.[scope]
}

/** Все решения сайта — для страницы настроек. */
export function decisionsOf(
  origin: string,
  persist: boolean,
  wsId = bootWorkspaceId()
): ScopeDecisions {
  const table = persist ? (caches.get(wsId) ?? {}) : ephemeralOf(wsId)
  return { ...(table[origin] ?? {}) }
}

/** Снимок всех решений — для страницы настроек. */
export function allDecisions(wsId = bootWorkspaceId()): {
  origins: OriginDecisions
  ephemeral: OriginDecisions
} {
  return { origins: { ...(caches.get(wsId) ?? {}) }, ephemeral: { ...ephemeralOf(wsId) } }
}

async function persistTable(wsId: string, table: OriginDecisions): Promise<void> {
  try {
    await writeJsonAtomic(fileOf(wsId), { origins: table })
  } catch (err) {
    logError('permissions write failed', err)
  }
}

/**
 * Записывает решение.
 *
 * Кэш обновляется ДО записи на диск: следующая проверка того же
 * разрешения (Chromium спрашивает его повторно) обязана увидеть решение
 * сразу, без ожидания файла. Ошибка записи не должна ломать выдачу —
 * решение уже действует в текущем сеансе.
 */
export async function setDecision(
  origin: string,
  scope: PermissionScope,
  value: Decision,
  persist: boolean,
  wsId = bootWorkspaceId()
): Promise<void> {
  if (!persist) {
    const table = ephemeralOf(wsId)
    table[origin] = { ...(table[origin] ?? {}), [scope]: value }
    log('session', 'permission decision (ephemeral)', { origin, scope, value, wsId })
    return
  }
  const table = caches.get(wsId) ?? {}
  table[origin] = { ...(table[origin] ?? {}), [scope]: value }
  caches.set(wsId, table)
  await persistTable(wsId, table)
  log('session', 'permission decision', { origin, scope, value, wsId })
}

/** Убирает все решения сайта (кнопка сброса в настройках и в бейдже). */
export async function clearOrigin(
  origin: string,
  persist: boolean,
  wsId = bootWorkspaceId()
): Promise<void> {
  if (!persist) {
    delete ephemeralOf(wsId)[origin]
    return
  }
  const table = caches.get(wsId) ?? {}
  delete table[origin]
  caches.set(wsId, table)
  await persistTable(wsId, table)
}

/** Убирает все решения всех сайтов. */
export async function clearAllDecisions(wsId = bootWorkspaceId()): Promise<void> {
  caches.set(wsId, {})
  for (const origin of Object.keys(ephemeralOf(wsId))) delete ephemeralOf(wsId)[origin]
  await persistTable(wsId, {})
}

/**
 * Убирает одну область у сайта — «сбросить это разрешение» из бейджа.
 */
export async function clearScope(
  origin: string,
  scope: PermissionScope,
  persist: boolean,
  wsId = bootWorkspaceId()
): Promise<void> {
  if (!persist) {
    const eph = ephemeralOf(wsId)
    if (!eph[origin]) return
    delete eph[origin][scope]
    return
  }
  const table = caches.get(wsId) ?? {}
  const record = table[origin]
  if (!record) return
  delete record[scope]
  if (Object.keys(record).length === 0) delete table[origin]
  caches.set(wsId, table)
  await persistTable(wsId, table)
}
