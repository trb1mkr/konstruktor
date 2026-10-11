// Реестр установленных расширений: extensions.json в userData.
// Единственный источник истины в main; shell и страница получают срез по IPC.
// По образцу settingsStore: файл читается один раз, дальше живёт в кэше,
// а запись идёт через upsert/remove — частичные патчи тут не нужны.
import { app } from 'electron'
import { dirname, join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
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

let cache: ExtensionRecord[] | null = null

export function extensionsFilePath(): string {
  return join(app.getPath('userData'), 'extensions.json')
}

export async function loadExtensions(): Promise<ExtensionRecord[]> {
  if (cache) return cache
  const path = extensionsFilePath()
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
  cache = list
  return list
}

// Синхронный доступ для кода, который не может ждать (push состояния).
export function getExtensionsSync(): ExtensionRecord[] {
  return cache ?? []
}

// Сброс кэша: реестр перечитывается с диска при следующем обращении.
export function resetExtensionsCache(): void {
  cache = null
}

export function setExtensionsCache(list: ExtensionRecord[]): void {
  cache = list
}

export async function saveExtensions(list: ExtensionRecord[]): Promise<void> {
  cache = list
  const path = extensionsFilePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(list, null, 2), 'utf8')
}

export async function upsertExtension(rec: ExtensionRecord): Promise<void> {
  const list = [...(cache ?? (await loadExtensions()))]
  const idx = list.findIndex((r) => r.id === rec.id)
  if (idx >= 0) list[idx] = rec
  else list.push(rec)
  await saveExtensions(list)
}

export async function removeExtensionRecord(id: string): Promise<boolean> {
  const list = (cache ?? (await loadExtensions())).filter((r) => r.id !== id)
  await saveExtensions(list)
  return true
}

export function findExtensionRecord(id: string): ExtensionRecord | undefined {
  return (cache ?? []).find((r) => r.id === id)
}

// Запись, выключенная пользователем, не считается ошибкой и не грузится:
// pinned по умолчанию false — расширение попадает под кнопку меню.
export function isPinned(rec: ExtensionRecord): boolean {
  return rec.pinned === true
}

// Поиск по идентификатору Chromium: шим из расширения знает только его.
export function findExtensionByElectronId(electronId: string): ExtensionRecord | undefined {
  return (cache ?? []).find((r) => r.electronId === electronId)
}
