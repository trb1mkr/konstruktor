import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { writeFileSync, mkdirSync } from 'fs'
import { parseAccelerator } from '../../shared/hotkeys'
import { HOTKEY_ACTIONS, type HotkeyOverrides } from '../../shared/hotkey-actions'

// Настройки браузера: JSON в userData, читаются внутренними страницами
// и адресной строкой (поисковик). Один источник истины в main.
export interface BrowserSettings {
  searchEngine: string
  homepage: string
  devtools: boolean
  // Secure DNS: off | cloudflare | google | custom. При custom — dnsCustom.
  dnsMode: string
  dnsCustom: string
  // Язык интерфейса: 'auto' (локаль системы) | код из LANGUAGES.
  // Резолв — shared/i18n.resolveLocale, смена — через settings:save.
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

let filePath = ''
let cache: BrowserSettings | null = null

async function load(): Promise<BrowserSettings> {
  if (cache) return cache
  let next: BrowserSettings = { ...DEFAULTS }
  try {
    const raw = await readFile(filePath || join(app.getPath('userData'), 'settings.json'), 'utf-8')
    next = { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // Нет файла или битый JSON — дефолты.
  }
  cache = next
  return next
}

export async function getSettings(): Promise<BrowserSettings> {
  return { ...(await load()) }
}

// Синхронное чтение для showOverlay: без await и без задержки
// перед открытием меню. Возвращает кэш или дефолты.
export function getSettingsSync(): BrowserSettings {
  return { ...(cache ?? DEFAULTS) }
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

export async function saveSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings> {
  const current = await load()
  const next: BrowserSettings = normalizeSettings({ ...current, ...patch })
  cache = next
  filePath = filePath || join(app.getPath('userData'), 'settings.json')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8')
  return { ...next }
}

// Синхронная запись для хука 'close' окна: асинхронный saveSettings до
// выхода процесса не доживает. Цепочка закрытия — 'close' окна →
// 'window-all-closed' → app.quit() → выход процесса, и незавершённый
// writeFile теряется вместе с ним. Замер: на Linux это единственный путь
// сохранения геометрии (события 'resized'/'moved' туда не приходят),
// поэтому терялась она всегда. Кэш обновляется до записи: значения
// доступны синхронно даже если запись не удалась.
export function saveSettingsSync(patch: Partial<BrowserSettings>): void {
  const next: BrowserSettings = normalizeSettings({ ...(cache ?? DEFAULTS), ...patch })
  cache = next
  filePath = filePath || join(app.getPath('userData'), 'settings.json')
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8')
  } catch {
    // Диск или права — выход из-за этого срывать нельзя.
  }
}
