// Реестр установленных расширений: extensions.json в каталоге рабочего
// пространства. Единственный источник истины в main; shell и страница
// получают срез по IPC. По образцу settingsStore: файл читается один раз,
// дальше живёт в кэше, а запись идёт через upsert/remove.
import { dirname } from 'path'
import { mkdir, readFile } from 'fs/promises'
import { writeJsonAtomic } from '../workspaces/atomic'
import { workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId } from '../workspaces/registry'
import type { ExtensionSource } from '../../shared/extensions-types'

export interface ExtensionRecord {
  id: string
  electronId?: string
  name: string
  version: string
  description: string
  dir: string
  enabled: boolean
  // Закреплено на панели: иконка видна всегда, а не только под кнопкой
  // меню расширений. Хранится рядом с остальным состоянием расширения,
  // чтобы не заводить второй файл ради одного булева поля.
  pinned?: boolean
  source: ExtensionSource
  permissions: string[]
  hosts: string[]
  warnings: string[]
  installedAt: number
  manifestVersion: number
  native: boolean
  capabilities: string[]
  // Легаси-цепочка фона: её поднимает сгенерированный service worker.
  // Хранится в реестре, потому что в манифесте остаётся только наш загрузчик.
  backgroundScripts?: string[]
  backgroundModule?: boolean
  contentScriptCount?: number
  // Состояние кнопки из манифеста: живое состояние держит bridge.
  actionSeed?: { title: string; badgeColor: string; icon: string; popup: string }
  // Секция commands манифеста: сочетания клавиш обслуживает свой
  // перехватчик (commands.ts), Chromium их не исполняет.
  manifestCommands?: unknown
  // Адрес проверки обновлений: свой update_url либо эндпоинт веб-магазина
  // (строится по идентификатору, если расширение поставлено из .crx).
  updateUrl?: string
  // Ошибка последней загрузки в сессию; пустая строка = загружено.
  error?: string
}

// Кэш реестра по пространствам: у каждого свой список установленных.
const caches = new Map<string, ExtensionRecord[]>()

export function extensionsFilePath(wsId = bootWorkspaceId()): string {
  return workspaceFile(wsId, 'extensions.json')
}

export async function loadExtensions(wsId = bootWorkspaceId()): Promise<ExtensionRecord[]> {
  const cached = caches.get(wsId)
  if (cached) return cached
  const path = extensionsFilePath(wsId)
  let list: ExtensionRecord[] = []
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      list = parsed.filter((r): r is ExtensionRecord => !!r && typeof r.id === 'string')
    }
  } catch {
    // Нет файла или битый JSON — пустой реестр.
  }
  caches.set(wsId, list)
  return list
}

// Синхронный доступ для кода, который не может ждать (push состояния).
export function getExtensionsSync(wsId = bootWorkspaceId()): ExtensionRecord[] {
  return caches.get(wsId) ?? []
}

// Сброс кэша: реестр перечитывается с диска при следующем обращении.
export function resetExtensionsCache(wsId = bootWorkspaceId()): void {
  caches.delete(wsId)
}

export function setExtensionsCache(list: ExtensionRecord[], wsId = bootWorkspaceId()): void {
  caches.set(wsId, list)
}

export async function saveExtensions(
  list: ExtensionRecord[],
  wsId = bootWorkspaceId()
): Promise<void> {
  caches.set(wsId, list)
  const path = extensionsFilePath(wsId)
  await mkdir(dirname(path), { recursive: true })
  await writeJsonAtomic(path, list)
}

export async function upsertExtension(
  rec: ExtensionRecord,
  wsId = bootWorkspaceId()
): Promise<void> {
  const list = [...(caches.get(wsId) ?? (await loadExtensions(wsId)))]
  const idx = list.findIndex((r) => r.id === rec.id)
  if (idx >= 0) list[idx] = rec
  else list.push(rec)
  await saveExtensions(list, wsId)
}

export async function removeExtensionRecord(
  id: string,
  wsId = bootWorkspaceId()
): Promise<boolean> {
  const list = (caches.get(wsId) ?? (await loadExtensions(wsId))).filter((r) => r.id !== id)
  await saveExtensions(list, wsId)
  return true
}

export function findExtensionRecord(
  id: string,
  wsId = bootWorkspaceId()
): ExtensionRecord | undefined {
  return (caches.get(wsId) ?? []).find((r) => r.id === id)
}

// Запись, выключенная пользователем, не считается ошибкой и не грузится:
// pinned по умолчанию false — расширение попадает под кнопку меню.
export function isPinned(rec: ExtensionRecord): boolean {
  return rec.pinned === true
}

// Поиск по идентификатору Chromium: шим из расширения знает только его.
export function findExtensionByElectronId(
  electronId: string,
  wsId = bootWorkspaceId()
): ExtensionRecord | undefined {
  return (caches.get(wsId) ?? []).find((r) => r.electronId === electronId)
}

/**
 * Запись по electronId во ВСЕХ пространствах.
 *
 * Мост loopback один на процесс и обслуживает расширения всех открытых
 * пространств, а `electronId` выдаётся при загрузке в партицию — то есть
 * однозначен в пределах процесса. Поиск только в пространстве запуска
 * работал, пока открыто было одно пространство: расширение второго при
 * первом же вызове получало `unknown extension` и теряло меню, хранилище и
 * попап (замерено на копировании расширений в новое пространство).
 */
export function findExtensionByElectronIdAny(
  electronId: string
): ExtensionRecord | undefined {
  for (const list of caches.values()) {
    const rec = list.find((r) => r.electronId === electronId)
    if (rec) return rec
  }
  return undefined
}

/** Запись по id расширения во всех пространствах: для событий моста. */
export function findExtensionRecordAny(id: string): ExtensionRecord | undefined {
  for (const list of caches.values()) {
    const rec = list.find((r) => r.id === id)
    if (rec) return rec
  }
  return undefined
}
