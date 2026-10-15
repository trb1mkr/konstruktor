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
import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { log, logError } from '../overlay/logger'
import type { Decision, PermissionScope } from './policy'

/** Решения по областям одного сайта. */
export type ScopeDecisions = Partial<Record<PermissionScope, Decision>>
/** Все сайты: origin -> решения. */
export type OriginDecisions = Record<string, ScopeDecisions>

let filePath = ''
let cache: OriginDecisions | null = null

// Приватные окна: решения живут только в памяти и умирают с процессом.
const ephemeral: OriginDecisions = {}

function pathOf(): string {
  filePath = filePath || join(app.getPath('userData'), 'permissions.json')
  return filePath
}

/** Читает файл один раз и держит результат в кэше. */
export async function loadPermissions(): Promise<OriginDecisions> {
  if (cache) return cache
  let next: OriginDecisions = {}
  try {
    const raw = await readFile(pathOf(), 'utf-8')
    const parsed = JSON.parse(raw) as { origins?: OriginDecisions }
    if (parsed && typeof parsed.origins === 'object' && parsed.origins) next = parsed.origins
  } catch {
    // Нет файла или битый JSON — решений ещё нет.
  }
  cache = next
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
): Decision | undefined {
  const table = persist ? (cache ?? {}) : ephemeral
  return table[origin]?.[scope]
}

/** Все решения сайта — для страницы настроек. */
export function decisionsOf(origin: string, persist: boolean): ScopeDecisions {
  const table = persist ? (cache ?? {}) : ephemeral
  return { ...(table[origin] ?? {}) }
}

/** Снимок всех решений — для страницы настроек. */
export function allDecisions(): { origins: OriginDecisions; ephemeral: OriginDecisions } {
  return { origins: { ...(cache ?? {}) }, ephemeral: { ...ephemeral } }
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
): Promise<void> {
  if (!persist) {
    ephemeral[origin] = { ...(ephemeral[origin] ?? {}), [scope]: value }
    log('session', 'permission decision (ephemeral)', { origin, scope, value })
    return
  }
  const table = cache ?? (cache = {})
  table[origin] = { ...(table[origin] ?? {}), [scope]: value }
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(pathOf(), JSON.stringify({ origins: table }, null, 2), 'utf-8')
  } catch (err) {
    logError('permissions write failed', err)
  }
  log('session', 'permission decision', { origin, scope, value })
}

/** Убирает все решения сайта (кнопка сброса в настройках и в бейдже). */
export async function clearOrigin(origin: string, persist: boolean): Promise<void> {
  if (!persist) {
    delete ephemeral[origin]
    return
  }
  const table = cache ?? (cache = {})
  delete table[origin]
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(pathOf(), JSON.stringify({ origins: table }, null, 2), 'utf-8')
  } catch (err) {
    logError('permissions write failed', err)
  }
}

/** Убирает все решения всех сайтов. */
export async function clearAllDecisions(): Promise<void> {
  cache = {}
  for (const origin of Object.keys(ephemeral)) delete ephemeral[origin]
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(pathOf(), JSON.stringify({ origins: {} }, null, 2), 'utf-8')
  } catch (err) {
    logError('permissions write failed', err)
  }
}

/**
 * Убирает одну область у сайта — «сбросить это разрешение» из бейджа.
 */
export async function clearScope(
  origin: string,
  scope: PermissionScope,
  persist: boolean,
): Promise<void> {
  if (!persist) {
    if (!ephemeral[origin]) return
    delete ephemeral[origin][scope]
    return
  }
  const table = cache ?? (cache = {})
  const record = table[origin]
  if (!record) return
  delete record[scope]
  if (Object.keys(record).length === 0) delete table[origin]
  try {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(pathOf(), JSON.stringify({ origins: table }, null, 2), 'utf-8')
  } catch (err) {
    logError('permissions write failed', err)
  }
}
