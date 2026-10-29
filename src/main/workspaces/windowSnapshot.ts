// Слепок окон рабочего пространства: windows.json.
//
// Зачем не settings.sessionTabs, как раньше. Прежний слот хранил ОДИН
// список вкладок на всё приложение: второе окно затирало слепок первого,
// группы и порядок панели не сохранялись вовсе, а привязки к окну не было
// — восстановить «вкладку в то же окно» было не по чему.
//
// Теперь слепок описывает КАЖДОЕ окно пространства: геометрию, вкладки с
// их ключами, открытые группы, порядок панели и активную вкладку. Runtime
// id в файл не попадают: вкладка адресуется ключом `t<N>`, окно — `w<N>`,
// и именно поэтому слепок переживает перезапуск (id выдаются заново).
//
// Модуль намеренно не знает про createTab/createWindow: он только читает
// состояние и пишет файл. Применение слепка живёт в windowsManager, где
// есть deps. Иначе получился бы цикл deps -> windowSnapshot -> deps.
import { existsSync, readFileSync } from 'fs'
import { BrowserWindow } from 'electron'
import { windows, type TabData, type WindowState } from '../windows/browserState'
import { getSettingsSync } from '../store/settingsStore'
import { writeJsonAtomic, writeJsonAtomicSync } from './atomic'
import { workspaceFile } from './paths'

/** Вкладка в слепке. Все поля — данные, ни одного runtime-идентификатора. */
export interface SnapshotTab {
  key: string
  url: string
  title: string
  favicon: string
  customTitle?: string
  customFavicon?: string
  pinned: boolean
  /** instanceId открытого экземпляра группы; undefined — вне групп. */
  groupId?: string
}

export interface SnapshotWindow {
  key: string
  /** Геометрия окна в оконном режиме. */
  bounds?: { x: number; y: number; width: number; height: number }
  maximized: boolean
  /**
   * Отступы панелей shell на момент слепка.
   *
   * Без них восстановленная view ставится по дефолтным 110/50, пока shell
   * не пришлёт настоящие: страница успевает отрисоваться с неверной
   * высотой (выше и короче) и прыгает на первом же `layout:update`.
   * С отступами первый же layout верный.
   */
  uiInsets?: { top: number; bottom: number; left: number; right: number }
  activeTabKey: string | null
  tabs: SnapshotTab[]
  /** Открытые экземпляры групп вместе с instanceId — ссылки вкладок живые. */
  openGroups: {
    instanceId: string
    savedId: string
    collapsed: boolean
    pinned: boolean
    parentInstanceId?: string
  }[]
  /** Токены ряда: `t:<key>` для вкладок, `g:<instanceId>` для групп. */
  stripOrder: string[]
  pinnedStripOrder: string[]
}

export interface WorkspaceWindowsFile {
  schemaVersion: number
  savedAt: number
  windows: SnapshotWindow[]
}

const SCHEMA = 1
/** Задержка записи: перетаскивание вкладки шлёт десятки пушей подряд. */
const PERSIST_DEBOUNCE_MS = 500

/**
 * Идёт ли выход из приложения.
 *
 * Нужен хуку закрытия окна: при выходе окна закрываются по одному, и если
 * слепок писать на каждом закрытии, к моменту последнего окна в нём
 * осталось бы только оно. Поэтому при выходе слепок пишется ОДИН раз —
 * в `before-quit`, до того как окна начали закрываться, — а хук закрытия
 * окна в этом режиме молчит.
 */
let quitting = false

export function markAppQuitting(): void {
  quitting = true
}

export function isAppQuitting(): boolean {
  return quitting
}

// --- Чтение и запись ----------------------------------------------------

export function workspaceWindowsPath(wsId: string): string {
  return workspaceFile(wsId, 'windows.json')
}

export function readWorkspaceWindows(wsId: string): SnapshotWindow[] {
  try {
    const raw = readFileSync(workspaceWindowsPath(wsId), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WorkspaceWindowsFile>
    if (!Array.isArray(parsed.windows)) return []
    return parsed.windows.filter(
      (w): w is SnapshotWindow =>
        !!w && typeof w.key === 'string' && Array.isArray(w.tabs) && Array.isArray(w.stripOrder)
    )
  } catch {
    return []
  }
}

/** Есть ли слепок с вкладками — по нему решается, восстанавливать ли окна. */
export function hasWorkspaceWindows(wsId: string): boolean {
  return existsSync(workspaceWindowsPath(wsId))
}

export function clearWorkspaceWindows(wsId: string): void {
  fileCache.delete(wsId)
  try {
    writeJsonAtomicSync(workspaceWindowsPath(wsId), {
      schemaVersion: SCHEMA,
      savedAt: Date.now(),
      windows: []
    } satisfies WorkspaceWindowsFile)
  } catch {
    // Нет прав — оставляем как есть: пустой слепок не нужен.
  }
}

/** Последний записанный слепок в памяти — для слияния при partial-записи. */
const fileCache = new Map<string, SnapshotWindow[]>()

// --- Снятие слепка ------------------------------------------------------

/**
 * Вкладка в слепке по живой записи окна.
 *
 * Вынесено из `captureWindow`, потому что тот же объект нужен списку
 * недавно закрытых: он тоже сохраняет вкладку, но одну и без окон.
 */
export function snapshotTabOf(rec: TabData): SnapshotTab {
  return {
    key: rec.key,
    url: rec.url,
    title: rec.customTitle ?? rec.title,
    favicon: rec.customFavicon ?? rec.favicon,
    customTitle: rec.customTitle,
    customFavicon: rec.customFavicon,
    pinned: rec.pinned,
    groupId: rec.groupId
  }
}

/**
 * Слепок одного окна.
 *
 * Порядок вкладок берётся из `tabOrder`, а не из `stripOrder`: вкладки
 * групп токенов в ряду не имеют, и по ряду они бы потерялись. Группы и
 * порядок восстанавливаются из `openGroups` и `stripOrder` отдельно.
 */
export function captureWindow(ws: WindowState): SnapshotWindow | null {
  if (!ws.window || ws.window.isDestroyed()) return null
  if (ws.incognito) return null
  const tabs: SnapshotTab[] = []
  for (const id of ws.tabOrder) {
    const rec = ws.tabs.get(id)
    if (!rec) continue
    if (rec.url === 'about:blank') continue
    tabs.push(snapshotTabOf(rec))
  }
  if (tabs.length === 0) return null
  const activeRec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  const bounds = ws.window.getBounds()
  return {
    key: ws.key,
    bounds: ws.window.isMaximized() || ws.window.isFullScreen() ? undefined : bounds,
    maximized: ws.window.isMaximized(),
    uiInsets: { ...ws.uiInsets },
    activeTabKey: activeRec?.key ?? tabs[0].key,
    tabs,
    openGroups: ws.openGroups.map((g) => ({ ...g })),
    // Токены вкладок в файле — по ключам: runtime id в слепок не попадают.
    stripOrder: ws.stripOrder
      .map((token) => tokenToKey(ws, token))
      .filter((token): token is string => token !== null),
    pinnedStripOrder: ws.pinnedStripOrder
      .map((token) => tokenToKey(ws, token))
      .filter((token): token is string => token !== null)
  }
}

/** `t:<id>` -> `t:<key>`. Токены групп (`g:`) не меняются. */
function tokenToKey(ws: WindowState, token: string): string | null {
  if (!token.startsWith('t:')) return token
  const id = Number(token.slice(2))
  const rec = ws.tabs.get(id)
  return rec ? `t:${rec.key}` : null
}

/**
 * Собирает слепок всех окон пространства.
 *
 * `excludeKey` — окно, которое сейчас закрывается: если в пространстве
 * остаются другие окна, закрытое восстанавливать не нужно. Вызывающий
 * обязан передавать исключение только когда есть кому остаться — иначе
 * слепок окажется пустым, и при следующем запуске восстанавливать будет
 * нечего (именно это и случилось с закрытием единственного окна).
 *
 * Пустой результат в любом случае не затирает файл: значит окон не
 * осталось (идёт выход), а не пользователь сознательно начал с чистого
 * листа — это отдельный сценарий, `clearWorkspaceWindows`.
 */
export function captureWorkspace(wsId: string, excludeKey?: string): SnapshotWindow[] {
  const out: SnapshotWindow[] = []
  for (const ws of windows.values()) {
    if (ws.workspaceId !== wsId) continue
    if (excludeKey && ws.key === excludeKey) continue
    const shot = captureWindow(ws)
    if (shot) {
      out.push(shot)
      continue
    }
    // Окно ещё не восстановило вкладки (идёт загрузка shell) — берём его
    // прошлую запись из файла. Иначе отложенная запись посреди старта
    // выбросила бы окно из слепка, и при следующем запуске его бы не стало.
    const prev = lastFor(wsId, ws.key)
    if (prev) out.push(prev)
  }
  if (out.length > 0) return out
  return previousSnapshot(wsId)
}

/** Прошлый слепок пространства: кэш процесса либо файл. */
function previousSnapshot(wsId: string): SnapshotWindow[] {
  const cached = fileCache.get(wsId)
  if (cached) return cached
  const fromDisk = readWorkspaceWindows(wsId)
  fileCache.set(wsId, fromDisk)
  return fromDisk
}

/** Прошлая запись окна: из кэша процесса либо с диска. */
function lastFor(wsId: string, key: string): SnapshotWindow | undefined {
  const cached = fileCache.get(wsId) ?? readWorkspaceWindows(wsId)
  return cached.find((w) => w.key === key)
}

// --- Запись -------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>()

function writeNow(wsId: string, list: SnapshotWindow[]): void {
  fileCache.set(wsId, list)
  const payload: WorkspaceWindowsFile = { schemaVersion: SCHEMA, savedAt: Date.now(), windows: list }
  if (quitting) {
    try {
      writeJsonAtomicSync(workspaceWindowsPath(wsId), payload)
    } catch {
      // Диск или права — выход из-за этого срывать нельзя.
    }
    return
  }
  void writeJsonAtomic(workspaceWindowsPath(wsId), payload).catch(() => undefined)
}

/**
 * Отложенная запись слепка пространства.
 *
 * Вызывается на любое изменение состояния вкладок (pushTabsState) и на
 * изменения групп. Пять сотен миллисекунд гасят дрожание перетаскивания,
 * а закрытие окна пишет синхронно — иначе последний слепок теряется
 * вместе с процессом.
 */
export function scheduleWorkspaceWindowsPersist(wsId: string): void {
  const existing = timers.get(wsId)
  if (existing) clearTimeout(existing)
  timers.set(
    wsId,
    setTimeout(() => {
      timers.delete(wsId)
      writeNow(wsId, captureWorkspace(wsId))
    }, PERSIST_DEBOUNCE_MS)
  )
}

/** Немедленная запись: закрытие окна и выход из приложения. */
export function persistWorkspaceWindowsSync(wsId: string, excludeKey?: string): void {
  const pending = timers.get(wsId)
  if (pending) {
    clearTimeout(pending)
    timers.delete(wsId)
  }
  writeNow(wsId, captureWorkspace(wsId, excludeKey))
}

/** Слепок из кэша процесса: нужен диагностике и списку недавних окон. */
export function cachedWorkspaceWindows(wsId: string): SnapshotWindow[] {
  return fileCache.get(wsId) ?? readWorkspaceWindows(wsId)
}

// --- План восстановления ------------------------------------------------

/**
 * Что открывать при старте пространства.
 *
 * `rememberTabs: false` выключает восстановление вкладок: приходит одно
 * окно со стартовой страницей. `rememberBounds: false` сохраняет вкладки,
 * но ставит окно по умолчанию.
 */
export function planWorkspaceWindows(wsId: string): SnapshotWindow[] {
  const settings = getSettingsSync(wsId)
  if (settings.rememberTabs === false) return []
  const saved = readWorkspaceWindows(wsId)
  if (saved.length === 0) return []
  const withBounds = settings.rememberBounds !== false
  return saved.map((w) => ({
    ...w,
    // Позиция берётся из слепка: settings.windowBounds — общий слот, и при
    // нескольких окнах он описывает только последнее.
    bounds: withBounds ? w.bounds : undefined,
    maximized: withBounds ? w.maximized : false
  }))
}

/** Размер окна по умолчанию, если слепка нет. */
export function defaultWindowSize(): { width: number; height: number } {
  return { width: 1600, height: 900 }
}

/** Смещение нового окна, чтобы оно не легло ровно на предыдущее. */
export function offsetBounds(
  base: { x: number; y: number; width: number; height: number } | undefined,
  index: number
): { x?: number; y?: number } {
  if (!base) return {}
  return { x: base.x + index * 32, y: base.y + index * 32 }
}

/** Проверка «это окно ещё живо» — для списка недавно закрытых (шаг 6). */
export function findLiveWindow(wsId: string, key: string): BrowserWindow | undefined {
  for (const ws of windows.values()) {
    if (ws.workspaceId !== wsId || ws.key !== key) continue
    if (ws.window && !ws.window.isDestroyed()) return ws.window
  }
  return undefined
}
