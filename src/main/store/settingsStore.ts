import { readFileSync } from 'fs'
import { writeJsonAtomic, writeJsonAtomicSync } from '../workspaces/atomic'
import { globalSettingsFile, workspaceFile } from '../workspaces/paths'
import { bootWorkspaceId, listWorkspaces } from '../workspaces/registry'
import { parseAccelerator } from '../../shared/hotkeys'
import { HOTKEY_ACTIONS, type HotkeyOverrides } from '../../shared/hotkey-actions'

// Настройки браузера: JSON в каталоге рабочего пространства, читаются
// внутренними страницами и адресной строкой (поисковик). Один источник
// истины в main.
//
// Пространство изолирует всё, что меняет пользователь. Исключение
// вынужденное, а не вкусовое: dnsMode/dnsCustom ставятся switches'ами в
// командную строку до ready и действуют на процесс целиком. Эти два поля
// лежат в settings-global.json и общие для всех пространств; при чтении
// они накладываются поверх настроек пространства, поэтому вызывающий код
// видит одну плоскую структуру, как раньше.
export interface BrowserSettings {
  searchEngine: string
  homepage: string
  devtools: boolean
  // Secure DNS: off | cloudflare | google | custom. При custom — dnsCustom.
  dnsMode: string
  dnsCustom: string
  // Язык интерфейса: 'auto' (локаль системы) | код из LANGUAGES.
  // Резолв — shared/i18n.resolveLocale. Настройка ПРОСТРАНСТВА: переводчик
  // на нужный язык отдаёт i18next.getFixedT, поэтому окна разных
  // пространств могут быть на разных языках одновременно.
  locale: string
  // Анимации оверлея (меню/диалоги/тосты). false = открывать моментально.
  animations: boolean
  // Тема shell: dark | light | system | slate. Оверлей читает для своих панелей.
  theme: string
  // Базовая тема веб-контента (сайты + окна расширений):
  // follow | dark | light | system. 'follow' — база темы браузера
  // (см. browserTheme.THEME_SCHEME), остальное — прямой override.
  // Внутренних страниц konstruktor:// не касается.
  webContentTheme: string
  // Скругление углов окна в оконном режиме. По дефолту выключено:
  // низ скругляется только через прозрачную полосу под WebContentsView.
  roundedCorners: boolean
  // Сценарий F11: 'window' — весь браузер со всеми панелями,
  // 'content' — только WebContentsView, панели прячутся.
  fullscreenMode: string
  // Запоминать размер/позицию окна при закрытии и восстанавливать при старте.
  rememberBounds: boolean
  // Запоминать открытые вкладки и восстанавливать при старте.
  rememberTabs: boolean
  // Режим зума страницы: 'origin' — per-origin (как Chrome: общий для
  // всех вкладок одного сайта и переживающий перезапуск), 'tab' —
  // per-webContents через setZoomMode('isolated'): зум принадлежит
  // вкладке, не наследуется по URL, а закрытие вкладки обнуляет его.
  zoomMode: string
  // Единый зум на все вкладки: любое изменение применяется ко всем
  // вкладкам всех окон, новые открываются с последнего процента.
  zoomSync: boolean
  // Расширения включены глобально. false — все выгружаются из сессии.
  extensionsEnabled: boolean
  // Режим разработчика на странице расширений: показывает пути и ошибки.
  extensionsDevMode: boolean
  // --- Видимость частей пункта меню (все меню приложения) ---
  // Иконка, текст и подпись горячей клавиши. Инвариант «хотя бы одна
  // часть видна» держит normalizeMenuParts: пункт без всех трёх
  // неотличим от разделителя.
  menuShowIcons: boolean
  menuShowText: boolean
  menuShowHotkeys: boolean
  // Подписи хоткеев видны только при наведении мыши или выборе стрелками.
  menuHotkeysOnHover: boolean
  // Переопределения горячих клавиш: разреженная карта «действие ->
  // акселератор» (см. shared/hotkey-actions). Отсутствие ключа или пустая
  // строка = значение по умолчанию.
  hotkeys: HotkeyOverrides
  // Последняя геометрия обычного (не maximized/fullscreen) окна.
  windowBounds?: { x: number; y: number; width: number; height: number }
  windowMaximized?: boolean
  // Последняя сессия обычных (не инкогнито) вкладок: url + активная.
  sessionTabs?: { url: string; active: boolean }[]
}

// Поля, живущие в settings-global.json. Остальное принадлежит пространству.
//
// Язык здесь БОЛЬШЕ НЕ ЛЕЖИТ: переводчик умеет отдавать переводчик на
// заданный язык (`getFixedT`), поэтому язык стал настройкой пространства —
// меню и страницы собираются в языке СВОЕГО окна (см. main/i18n.ts).
// Глобальными остаются только поля, которые нельзя разделить технически:
// DNS ставится switches'ами командной строки до ready и действует на
// процесс целиком.
const GLOBAL_KEYS = ['dnsMode', 'dnsCustom'] as const
type GlobalKey = (typeof GLOBAL_KEYS)[number]

/** Кэш настроек по пространствам: у каждого свой файл. */
const caches = new Map<string, BrowserSettings>()

/** Кэш общих настроек процесса. */
let globalCache: BrowserSettings | null = null

const DEFAULTS: BrowserSettings = {
  searchEngine: 'https://www.google.com/search?q=%s',
  homepage: 'konstruktor://start',
  // DevTools при старте выключены. Включить: меню браузера -> Settings,
  // либо env KONSTRUKTOR_DEVTOOLS=1, либо флаг --devtools.
  devtools: false,
  dnsMode: 'off',
  dnsCustom: '',
  locale: 'auto',
  animations: true,
  theme: 'dark',
  webContentTheme: 'follow',
  roundedCorners: false,
  fullscreenMode: 'window',
  rememberBounds: true,
  rememberTabs: true,
  zoomMode: 'origin',
  zoomSync: false,
  extensionsEnabled: true,
  extensionsDevMode: false,
  menuShowIcons: true,
  menuShowText: true,
  menuShowHotkeys: true,
  menuHotkeysOnHover: false,
  hotkeys: {}
}

function settingsPathOf(wsId: string): string {
  return workspaceFile(wsId, 'settings.json')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Общие настройки процесса: читаются один раз и держатся в кэше.
 *
 * Файл создаётся миграцией; если его нет (удалили руками), берём значения
 * из настроек пространства по умолчанию, чтобы DNS не сбросился молча.
 */
function loadGlobal(): BrowserSettings {
  if (globalCache) return globalCache
  const stored = readJson(globalSettingsFile())
  const source = stored ?? readJson(settingsPathOf(bootWorkspaceId()))
  const next: BrowserSettings = { ...DEFAULTS }
  if (source) {
    for (const key of GLOBAL_KEYS) {
      const value = source[key]
      if (typeof value === typeof DEFAULTS[key]) {
        ;(next as unknown as Record<string, unknown>)[key] = value
      }
    }
  }
  globalCache = next
  return next
}

/** Накладывает общие настройки поверх настроек пространства. */
function withGlobal(base: BrowserSettings): BrowserSettings {
  const global = loadGlobal()
  return { ...base, dnsMode: global.dnsMode, dnsCustom: global.dnsCustom }
}

/** Настройки без глобальных полей — ровно то, что пишется в пространство. */
function withoutGlobal(s: BrowserSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s }
  for (const key of GLOBAL_KEYS) delete out[key]
  return out
}

function splitGlobal(patch: Partial<BrowserSettings>): {
  global: Partial<Record<GlobalKey, string>>
  rest: Partial<BrowserSettings>
} {
  const global: Partial<Record<GlobalKey, string>> = {}
  const rest: Partial<BrowserSettings> = { ...patch }
  for (const key of GLOBAL_KEYS) {
    const value = patch[key]
    if (typeof value === 'string') global[key] = value
    delete rest[key]
  }
  return { global, rest }
}

/**
 * Создаёт settings-global.json при первом запуске, забирая DNS из
 * настроек пространства по умолчанию.
 *
 * Синхронно и до создания первого окна: DNS применяется switches'ами в
 * начале процесса, и читать его из ещё не созданного файла было бы нечем.
 */
export function ensureGlobalSettingsSync(): void {
  const stored = readJson(globalSettingsFile())
  if (stored) {
    migrateLegacyLocale(stored)
    loadGlobal()
    return
  }
  const source = readJson(settingsPathOf(bootWorkspaceId()))
  const next: Record<GlobalKey, string> = {
    dnsMode: typeof source?.dnsMode === 'string' ? String(source.dnsMode) : DEFAULTS.dnsMode,
    dnsCustom:
      typeof source?.dnsCustom === 'string' ? String(source.dnsCustom) : DEFAULTS.dnsCustom
  }
  writeJsonAtomicSync(globalSettingsFile(), next)
  globalCache = { ...DEFAULTS, ...next }
}

/**
 * Перенос языка из общего файла в пространства (миграция этапа 8).
 *
 * Раньше `locale` лежал в `settings-global.json` и был один на процесс.
 * Теперь это настройка пространства, и без переноса после обновления
 * интерфейс молча вернулся бы к `auto`, то есть к языку системы, — у всех,
 * кто выбрал язык руками.
 *
 * Значение кладётся в каждое пространство, где своего языка ещё нет:
 * «общий» язык и был применён ко всем, поэтому перенос сохраняет то, что
 * пользователь видел. Сразу после переноса поле из общего файла удаляется,
 * так что миграция одноразовая и сама себя выключает.
 */
function migrateLegacyLocale(stored: Record<string, unknown>): void {
  const legacy = typeof stored.locale === 'string' ? stored.locale : ''
  if (!legacy) return
  for (const meta of listWorkspaces()) {
    const file = settingsPathOf(meta.id)
    const data = readJson(file)
    if (data && typeof data.locale === 'string') continue
    try {
      writeJsonAtomicSync(file, { ...(data ?? {}), locale: legacy })
    } catch {
      // Права или диск: язык останется 'auto' у одного пространства —
      // срывать из-за этого старт браузера нельзя.
    }
  }
  const next: Record<string, unknown> = { ...stored }
  delete next.locale
  try {
    writeJsonAtomicSync(globalSettingsFile(), next)
  } catch {
    // Не записалось — миграция просто повторится на следующем старте.
  }
}

/** Общие настройки без ожидания: DNS читается до first ready. */
export function getGlobalSettingsSync(): { dnsMode: string; dnsCustom: string } {
  const g = loadGlobal()
  return { dnsMode: g.dnsMode, dnsCustom: g.dnsCustom }
}

async function load(wsId: string): Promise<BrowserSettings> {
  const cached = caches.get(wsId)
  if (cached) return cached
  const stored = readJson(settingsPathOf(wsId))
  const next = normalizeSettings(withGlobal({ ...DEFAULTS, ...(stored ?? {}) }))
  caches.set(wsId, next)
  return next
}

export async function getSettings(wsId = bootWorkspaceId()): Promise<BrowserSettings> {
  return { ...(await load(wsId)) }
}

// Синхронное чтение для showOverlay (без await перед открытием меню),
// хука 'close' окна и горячих клавиш. Если кэш ещё пуст, читает файл с
// диска: на холодном старте первый же вызов обязан видеть сохранённое, а
// не дефолты — иначе окно берёт чужую геометрию, а порог зума чужой
// процент.
export function getSettingsSync(wsId = bootWorkspaceId()): BrowserSettings {
  const cached = caches.get(wsId)
  if (cached) return { ...cached }
  const stored = readJson(settingsPathOf(wsId))
  const next = normalizeSettings(withGlobal({ ...DEFAULTS, ...(stored ?? {}) }))
  caches.set(wsId, next)
  return { ...next }
}

/**
 * Чтение файла настроек пространства без кэша — для холодного старта окна,
 * которое вызывается раньше первого getSettings().
 */
export function readSettingsFileSync(wsId = bootWorkspaceId()): Record<string, unknown> {
  return readJson(settingsPathOf(wsId)) ?? {}
}

/** Сброс кэша настроек: удаление пространства и диагностика. */
export function resetSettingsCache(wsId?: string): void {
  if (wsId) caches.delete(wsId)
  else caches.clear()
}

/**
 * Инвариант видимости частей пункта меню: включена хотя бы одна из
 * ИДЕНТИФИЦИРУЮЩИХ частей — иконка или текст.
 *
 * Хоткей в инвариант НЕ входит: он не идентифицирует пункт, а лишь
 * подсказывает сочетание клавиш. Поэтому выключить разом иконку и текст
 * нельзя (пункт станет безымянным и неотличимым от разделителя), а
 * хоткей включается и выключается свободно.
 *
 * Нормализация здесь, а не только в форме настроек: значение меняют и
 * другие входы (IPC `settings:save`), и полагаться на то, что страница
 * пришлёт корректный набор, нельзя. При нарушении включаем текст: он есть
 * у каждого пункта и читается без иконки.
 */
function normalizeMenuParts(s: BrowserSettings): BrowserSettings {
  if (!s.menuShowIcons && !s.menuShowText) {
    return { ...s, menuShowText: true }
  }
  return s
}

/**
 * Отбор допустимых переопределений горячих клавиш.
 *
 * Доверять форме настроек нельзя (тот же вход `settings:save` доступен из
 * любого окна), поэтому:
 *   - неизвестные действия отбрасываются;
 *   - нераспознаваемые сочетания отбрасываются;
 *   - сочетание из одной печатной клавиши без модификатора отбрасывается:
 *     иначе буква перехватывала бы ввод на странице;
 *   - дубликаты отбрасываются (первое по реестру остаётся): два действия
 *     с одним сочетанием делают второе недостижимым.
 * Отброшенное действие просто остаётся на значении по умолчанию.
 *
 * Пустая строка — не мусор, а состояние «сочетание снято» (Backspace в
 * таблице настроек): ключ остаётся с пустым значением, и действие
 * перестаёт перехватывать клавишу. Отсутствие ключа отличается от
 * пустого значения — там действует значение по умолчанию.
 */
function normalizeHotkeys(input: unknown): HotkeyOverrides {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: HotkeyOverrides = {}
  const used = new Set<string>()
  for (const action of HOTKEY_ACTIONS) {
    const raw = src[action.id]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) {
      out[action.id] = ''
      continue
    }
    const parsed = parseAccelerator(value)
    if (!parsed) continue
    const code = parsed.code ?? ''
    const printable = /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)
    if (printable && !(parsed.primary || parsed.ctrl || parsed.meta || parsed.alt)) continue
    const key = value.toLowerCase()
    if (used.has(key)) continue
    used.add(key)
    out[action.id] = value
  }
  return out
}

/** Все инварианты настроек в одном месте, перед записью на диск. */
function normalizeSettings(s: BrowserSettings): BrowserSettings {
  return { ...normalizeMenuParts(s), hotkeys: normalizeHotkeys(s.hotkeys) }
}

function saveGlobalPatch(patch: Partial<Record<GlobalKey, string>>): void {
  const next: BrowserSettings = normalizeSettings({ ...loadGlobal(), ...patch })
  globalCache = next
  try {
    writeJsonAtomicSync(globalSettingsFile(), {
      dnsMode: next.dnsMode,
      dnsCustom: next.dnsCustom
    })
  } catch {
    // Права или диск: значение уже в кэше, срывать запись из-за этого нельзя.
  }
}

export async function saveSettings(
  patch: Partial<BrowserSettings>,
  wsId = bootWorkspaceId()
): Promise<BrowserSettings> {
  const { global, rest } = splitGlobal(patch)
  if (Object.keys(global).length > 0) saveGlobalPatch(global)
  const current = await load(wsId)
  const next: BrowserSettings = normalizeSettings({ ...current, ...rest })
  caches.set(wsId, next)
  await writeJsonAtomic(settingsPathOf(wsId), withoutGlobal(next))
  return { ...next }
}

// Синхронная запись для хука 'close' окна: асинхронный saveSettings до
// выхода процесса не доживает. Цепочка закрытия — 'close' окна →
// 'window-all-closed' → app.quit() → выход процесса, и незавершённый
// writeFile теряется вместе с ним. Замер: на Linux это единственный путь
// сохранения геометрии (события 'resized'/'moved' туда не приходят),
// поэтому терялась она всегда. Кэш обновляется до записи: значения
// доступны синхронно даже если запись не удалась.
export function saveSettingsSync(
  patch: Partial<BrowserSettings>,
  wsId = bootWorkspaceId()
): void {
  const { global, rest } = splitGlobal(patch)
  if (Object.keys(global).length > 0) saveGlobalPatch(global)
  const next: BrowserSettings = normalizeSettings({ ...getSettingsSync(wsId), ...rest })
  caches.set(wsId, next)
  try {
    writeJsonAtomicSync(settingsPathOf(wsId), withoutGlobal(next))
  } catch {
    // Диск или права — выход из-за этого срывать нельзя.
  }
}
