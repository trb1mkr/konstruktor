// Реестр рабочих пространств: список, метаданные, миграция старого профиля.
//
// Раскладка:
//   userData/workspaces.json      порядок и последнее открытое пространство
//   userData/workspaces/<id>/     все данные пространства
//
// Чтение синхронное и с кэшем: миграция и первый путь к settings.json нужны
// до готовности приложения, а объём файлов — единицы килобайт.
//
// Метаданные пространства лежат ВНУТРИ его каталога (workspace.json), а не
// в реестре: так каталог самодостаточен и его можно скопировать целиком —
// это же свойство понадобится синхронизации.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync
} from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeJsonAtomicSync } from './atomic'
import {
  userDataDir,
  workspaceDir,
  workspaceExtensionsDir,
  workspaceFile,
  workspaceRegistryFile,
  workspacesRoot
} from './paths'

/** Id мигрированного профиля. Партиция у него историческая — см. partition. */
export const DEFAULT_WORKSPACE_ID = 'default'

/** Партиция мигрированного профиля: логины переживают миграцию. */
export const DEFAULT_PARTITION = 'persist:konstruktor'

export interface WorkspaceMeta {
  id: string
  name: string
  /**
   * Иконка пространства: РОВНО один эмодзи.
   *
   * Раньше допускался URL картинки — так же, как у иконки группы. Но в
   * заголовке окна и в строке списка иконка стоит в узком квадрате, и
   * картинка там мельче эмодзи, а произвольный текст выглядел ошибкой
   * ввода. Поэтому набор сужен до одного эмодзи (см. normalizeIcon).
   */
  icon: string
  color: string
  /**
   * Партиция Chromium пространства. Локальное поле: в синхронизацию не
   * входит, при переносе на другую машину выбирается заново.
   */
  partition: string
  createdAt: number
  updatedAt: number
  /**
   * Когда пространство последний раз открывалось (окно создано).
   *
   * `updatedAt` для этого не годится: он меняется от любой правки
   * метаданных и счётчика ключей. Поле нужно странице пространств —
   * «последнее открытие» в раскрытой карточке.
   */
  lastOpenedAt?: number
  // Версия документа для будущего слияния при синхронизации.
  rev: number
  schemaVersion: number
  /**
   * Следующий свободный ключ окна (w<N>).
   *
   * Ключ окна — стабильный идентификатор внутри пространства: runtime id
   * Electron меняется от запуска к запуску, а слепок окон и список недавно
   * закрытых должны пережить перезапуск. Счётчик лежит в метаданных, чтобы
   * после перезапуска выданные ключи не повторились.
   */
  nextWindowKey?: number
}

interface RegistryFile {
  schemaVersion: number
  // Порядок в списке страницы пространств.
  order: string[]
  lastOpenId: string | null
  updatedAt: number
}

const REGISTRY_SCHEMA = 1
const META_SCHEMA = 1

// Файлы старого профиля, которые переезжают в пространство default.
// extensions.json и каталог extensions/ — реестр и сами файлы расширений.
const LEGACY_FILES = [
  'settings.json',
  'history.json',
  'downloads.json',
  'shortcuts.json',
  'groups.json',
  'permissions.json',
  'extensions.json'
]

let registry: RegistryFile | null = null
const metas = new Map<string, WorkspaceMeta>()

/** Id пространства, с которым работают сторы без явного аргумента. */
let bootId = DEFAULT_WORKSPACE_ID

function emptyRegistry(): RegistryFile {
  return { schemaVersion: REGISTRY_SCHEMA, order: [], lastOpenId: null, updatedAt: Date.now() }
}

function readRegistryFile(): RegistryFile {
  try {
    const parsed = JSON.parse(readFileSync(workspaceRegistryFile(), 'utf-8')) as Partial<RegistryFile>
    return {
      schemaVersion: REGISTRY_SCHEMA,
      order: Array.isArray(parsed.order) ? parsed.order.filter((id) => typeof id === 'string') : [],
      lastOpenId: typeof parsed.lastOpenId === 'string' ? parsed.lastOpenId : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
    }
  } catch {
    return emptyRegistry()
  }
}

function loadRegistry(): RegistryFile {
  if (!registry) registry = readRegistryFile()
  return registry
}

function saveRegistry(): void {
  if (!registry) return
  registry.updatedAt = Date.now()
  writeJsonAtomicSync(workspaceRegistryFile(), registry)
}

/** Метаданные пространства; null — каталога или файла нет. */
export function readWorkspaceMeta(id: string): WorkspaceMeta | null {
  const cached = metas.get(id)
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(workspaceFile(id, 'workspace.json'), 'utf-8')) as
      Partial<WorkspaceMeta>
    if (typeof parsed.id !== 'string' || parsed.id !== id) return null
    const meta: WorkspaceMeta = {
      id,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : id,
      icon: typeof parsed.icon === 'string' ? parsed.icon : '',
      color: typeof parsed.color === 'string' ? parsed.color : '#888888',
      partition:
        typeof parsed.partition === 'string' && parsed.partition
          ? parsed.partition
          : partitionFor(id),
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      lastOpenedAt: typeof parsed.lastOpenedAt === 'number' ? parsed.lastOpenedAt : undefined,
      rev: typeof parsed.rev === 'number' ? parsed.rev : 1,
      schemaVersion: META_SCHEMA,
      nextWindowKey:
        typeof parsed.nextWindowKey === 'number' && parsed.nextWindowKey > 0
          ? parsed.nextWindowKey
          : 1
    }
    metas.set(id, meta)
    return meta
  } catch {
    return null
  }
}

/**
 * Записывает метаданные пространства.
 *
 * `rev` растёт на каждой записи: по нему будущая синхронизация отличает
 * более свежую копию. `updatedAt` — тоже для слияния, но человекочитаемо.
 */
export function writeWorkspaceMeta(meta: WorkspaceMeta): void {
  const next: WorkspaceMeta = {
    ...meta,
    schemaVersion: META_SCHEMA,
    updatedAt: Date.now(),
    rev: meta.rev + 1
  }
  metas.set(next.id, next)
  writeJsonAtomicSync(workspaceFile(next.id, 'workspace.json'), next)
}

/**
 * Партиция для нового пространства.
 *
 * `default` сохраняет историческую партицию: иначе после миграции у
 * пользователя пропали бы все логины и cookies, хотя данные на месте.
 */
export function partitionFor(id: string): string {
  return id === DEFAULT_WORKSPACE_ID ? DEFAULT_PARTITION : `persist:konstruktor-${id}`
}

/** Идентификатор пространства, с которым работают сторы по умолчанию. */
export function bootWorkspaceId(): string {
  return bootId
}

/** Переключает пространство по умолчанию (стартовое и при открытии окна). */
export function setBootWorkspaceId(id: string): void {
  bootId = id
}

/** Id последнего открытого пространства — его открываем при старте. */
export function lastOpenWorkspaceId(): string {
  const reg = loadRegistry()
  const id = reg.lastOpenId ?? ''
  if (id && readWorkspaceMeta(id)) return id
  // Последнее открытое могло быть удалено (или его каталог убрали руками):
  // тогда стартуем с первого живого, а не с отсутствующего default.
  const first = reg.order.find((x) => readWorkspaceMeta(x))
  return first ?? DEFAULT_WORKSPACE_ID
}

export function setLastOpenWorkspaceId(id: string): void {
  const reg = loadRegistry()
  if (reg.lastOpenId === id) return
  reg.lastOpenId = id
  saveRegistry()
}

/** Все пространства в порядке реестра. Битые каталоги пропускаются. */
export function listWorkspaces(): WorkspaceMeta[] {
  const reg = loadRegistry()
  const out: WorkspaceMeta[] = []
  for (const id of reg.order) {
    const meta = readWorkspaceMeta(id)
    if (meta) out.push(meta)
  }
  return out
}

export function createWorkspace(input: {
  name?: string
  icon?: string
  color?: string
}): WorkspaceMeta {
  const id = randomUUID()
  const now = Date.now()
  const meta: WorkspaceMeta = {
    id,
    name: (input.name ?? '').trim() || 'Workspace',
    icon: normalizeIcon(input.icon ?? '') || DEFAULT_ICON,
    color: input.color ?? '#888888',
    partition: partitionFor(id),
    createdAt: now,
    updatedAt: now,
    rev: 0,
    schemaVersion: META_SCHEMA,
    nextWindowKey: 1
  }
  mkdirSync(workspaceDir(id), { recursive: true })
  writeWorkspaceMeta(meta)
  const reg = loadRegistry()
  reg.order.push(id)
  saveRegistry()
  return metas.get(id) ?? meta
}

export function renameWorkspace(id: string, name: string): WorkspaceMeta | null {
  const meta = readWorkspaceMeta(id)
  if (!meta) return null
  const trimmed = name.trim()
  if (trimmed) meta.name = trimmed
  writeWorkspaceMeta(meta)
  return metas.get(id) ?? meta
}

/** Иконка по умолчанию: пространство без выбранного эмодзи. */
export const DEFAULT_ICON = '🗂️'

// Разбиение на графемы: один эмодзи может состоять из нескольких code
// points (кожа, ZWJ-последовательности, флаги). Без Segmenter мы бы
// сохраняли половину эмодзи или считали один эмодзи двумя.
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Иконка пространства -> ровно один эмодзи ('' — если эмодзи нет).
 *
 * Сужение до одного символа не косметика: иконка стоит в квадрате 40px в
 * списке и в заголовке окна. Слово там обрезается, а картинка-URL
 * оказывалась мельче эмодзи, поэтому принимается только pictographic
 * графема. Первая подходящая, а не вся строка: вставка «Работа 🏢» даёт
 * иконку 🏢, а не отказ.
 *
 * Проверка стоит в main, а не только в форме страницы: метаданные правятся
 * и другими входами, и испорченная иконка осталась бы в workspace.json.
 */
export function normalizeIcon(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (/\p{Extended_Pictographic}/u.test(segment)) return segment
  }
  return ''
}

/**
 * Правит пользовательские поля пространства: имя, иконку, цвет.
 *
 * Остальные поля (id, партиция, счётчик ключей окон) не правятся никогда:
 * партиция привязана к каталогу данных Chromium, а счётчик — к уже
 * выданным ключам слепка. Пустое имя сохраняется как есть — откатывать его
 * к прежнему нельзя, иначе пользователь не поймёт, почему ввод не применился;
 * имя по умолчанию подставляет вызывающий.
 */
export function updateWorkspaceMeta(
  id: string,
  patch: { name?: string; icon?: string; color?: string }
): WorkspaceMeta | null {
  const meta = readWorkspaceMeta(id)
  if (!meta) return null
  if (patch.name !== undefined) meta.name = patch.name.trim() || meta.name
  // Не эмодзи — оставляем прежнюю иконку: очищать её из-за опечатки в
  // другом поле было бы неожиданно.
  if (patch.icon !== undefined) meta.icon = normalizeIcon(patch.icon) || meta.icon
  if (patch.color !== undefined) meta.color = patch.color.trim() || meta.color
  writeWorkspaceMeta(meta)
  return metas.get(id) ?? meta
}

/**
 * Отмечает, что пространство открывалось: карточка на странице показывает
 * «последнее открытие».
 *
 * Вызывается при создании окна — то есть и при восстановлении окон из
 * слепка: это тоже открытие пространства пользователем.
 */
export function touchWorkspaceOpened(id: string): void {
  const meta = readWorkspaceMeta(id)
  if (!meta) return
  meta.lastOpenedAt = Date.now()
  writeWorkspaceMeta(meta)
}

/**
 * Удаляет пространство: запись из реестра и каталог данных.
 *
 * Не удаляется только ПОСЛЕДНЕЕ пространство: без него браузер стартовал бы
 * без данных и без настроек. Раньше удаление default было запрещено
 * навсегда, но это ограничение оказалось про происхождение профиля, а не
 * про данные: пользователь, живущий во втором пространстве, не мог убрать
 * первое.
 *
 * Партиция Chromium удаляется отдельно — её файлы держит открытая сессия
 * (см. workspaces/ipc.ts).
 */
export function deleteWorkspace(id: string): boolean {
  const meta = readWorkspaceMeta(id)
  if (!meta) return false
  if (listWorkspaces().length <= 1) return false
  const reg = loadRegistry()
  reg.order = reg.order.filter((x) => x !== id)
  if (reg.lastOpenId === id) reg.lastOpenId = reg.order[0] ?? DEFAULT_WORKSPACE_ID
  saveRegistry()
  metas.delete(id)
  // Загрузочное пространство тоже не должно указывать на удалённую запись:
  // сторы с аргументом по умолчанию продолжили бы писать в пустой каталог.
  if (bootId === id) bootId = lastOpenWorkspaceId()
  try {
    rmSync(workspaceDir(id), { recursive: true, force: true })
  } catch {
    // Каталог занят: запись из реестра уже убрана, мусор не мешает.
  }
  return true
}

/** Проверка существования пространства — для IPC-обработчиков. */
export function workspaceExists(id: string): boolean {
  return readWorkspaceMeta(id) !== null
}

/**
 * Выдаёт стабильный ключ окна внутри пространства (`w1`, `w2`, …).
 *
 * Счётчик хранится в метаданных пространства: иначе после перезапуска
 * новые окна получали бы ключи уже сохранённых, и слепок окон схлопнулся
 * бы в одно окно.
 */
export function allocWindowKey(wsId: string): string {
  const meta = readWorkspaceMeta(wsId)
  if (!meta) return 'w1'
  const n = meta.nextWindowKey && meta.nextWindowKey > 0 ? meta.nextWindowKey : 1
  const next: WorkspaceMeta = { ...meta, nextWindowKey: n + 1 }
  writeWorkspaceMeta(next)
  return `w${n}`
}

// --- Миграция -----------------------------------------------------------

/**
 * Переносит файл в каталог пространства.
 *
 * `rename` в пределах одного тома атомарен и дешёв; если каталоги на разных
 * томах (userData на другом диске через симлинк), rename падает EXDEV —
 * тогда копируем и удаляем оригинал.
 */
function moveFile(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  try {
    renameSync(from, to)
  } catch {
    try {
      copyFileSync(from, to)
      unlinkSync(from)
    } catch {
      // Не удалось перенести — старый файл остаётся, данные не теряются.
    }
  }
}

function moveDir(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return
  try {
    renameSync(from, to)
  } catch {
    try {
      mkdirSync(to, { recursive: true })
      for (const name of readdirSync(from)) {
        const src = join(from, name)
        const dst = join(to, name)
        if (existsSync(dst)) continue
        try {
          renameSync(src, dst)
        } catch {
          copyFileSync(src, dst)
        }
      }
      rmSync(from, { recursive: true, force: true })
    } catch {
      // Частичный перенос: файлы, которые не удалось перенести, остаются.
    }
  }
}

/**
 * Готовит раскладку рабочих пространств и мигрирует старый профиль.
 *
 * Вызывается синхронно один раз при старте — до чтения settings.json для
 * DNS и до создания первого окна. Повторный вызов ничего не делает: признак
 * миграции — существование workspaces.json.
 */
export function ensureWorkspaceLayoutSync(): void {
  mkdirSync(workspacesRoot(), { recursive: true })
  const migrated = existsSync(workspaceRegistryFile())
  if (!migrated) {
    const dir = workspaceDir(DEFAULT_WORKSPACE_ID)
    mkdirSync(dir, { recursive: true })
    for (const name of LEGACY_FILES) moveFile(join(userDataDir(), name), join(dir, name))
    moveDir(join(userDataDir(), 'extensions'), workspaceExtensionsDir(DEFAULT_WORKSPACE_ID))
    // Реестр расширений хранит АБСОЛЮТНЫЕ пути установки. Каталог переехал —
    // пути переписываем, иначе каждое расширение стартовало бы с ошибкой
    // «каталог не найден», хотя файлы на месте.
    const extFile = workspaceFile(DEFAULT_WORKSPACE_ID, 'extensions.json')
    try {
      const list = JSON.parse(readFileSync(extFile, 'utf-8')) as { dir?: string }[]
      const from = join(userDataDir(), 'extensions')
      const to = workspaceExtensionsDir(DEFAULT_WORKSPACE_ID)
      let changed = false
      for (const rec of list) {
        if (typeof rec.dir === 'string' && rec.dir.startsWith(from)) {
          rec.dir = to + rec.dir.slice(from.length)
          changed = true
        }
      }
      if (changed) writeJsonAtomicSync(extFile, list)
    } catch {
      // Реестра нет или он битый — расширений не было.
    }
    const now = Date.now()
    writeJsonAtomicSync(workspaceFile(DEFAULT_WORKSPACE_ID, 'workspace.json'), {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Default',
      icon: '🏠',
      color: '#888888',
      partition: DEFAULT_PARTITION,
      createdAt: now,
      updatedAt: now,
      rev: 1,
      schemaVersion: META_SCHEMA,
      nextWindowKey: 1
    } satisfies WorkspaceMeta)
    registry = {
      schemaVersion: REGISTRY_SCHEMA,
      order: [DEFAULT_WORKSPACE_ID],
      lastOpenId: DEFAULT_WORKSPACE_ID,
      updatedAt: now
    }
    saveRegistry()
  }
  // Кэш метаданных и загрузочное пространство — по реестру.
  metas.clear()
  registry = readRegistryFile()
  // Каталоги могли убрать руками: порядок чистим по живым записям, иначе
  // мёртвые id тянулись бы в реестре и в списке страницы.
  //
  // Пропавший default при живых других пространствах НЕ восстанавливается:
  // default теперь обычное, удаляемое пространство (см. deleteWorkspace), и
  // воскрешать его после удаления было бы неожиданно. Создаётся он только
  // когда живых нет вовсе — иначе браузер стартовал бы без данных.
  const live = registry.order.filter((id) => readWorkspaceMeta(id))
  if (live.length === 0) {
    mkdirSync(workspaceDir(DEFAULT_WORKSPACE_ID), { recursive: true })
    const now = Date.now()
    writeJsonAtomicSync(workspaceFile(DEFAULT_WORKSPACE_ID, 'workspace.json'), {
      id: DEFAULT_WORKSPACE_ID,
      name: 'Default',
      icon: '🏠',
      color: '#888888',
      partition: DEFAULT_PARTITION,
      createdAt: now,
      updatedAt: now,
      rev: 1,
      schemaVersion: META_SCHEMA,
      nextWindowKey: 1
    } satisfies WorkspaceMeta)
    registry.order = [DEFAULT_WORKSPACE_ID]
    registry.lastOpenId = DEFAULT_WORKSPACE_ID
    saveRegistry()
  } else if (live.length !== registry.order.length) {
    registry.order = live
    if (registry.lastOpenId && !live.includes(registry.lastOpenId)) {
      registry.lastOpenId = live[0]
    }
    saveRegistry()
  }
  for (const id of registry.order) readWorkspaceMeta(id)
  setBootWorkspaceId(lastOpenWorkspaceId())
}
