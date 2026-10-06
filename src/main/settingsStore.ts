import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

// Настройки браузера: JSON в userData, читаются внутренними страницами
// и адресной строкой (поисковик). Один источник истины в main.
export interface BrowserSettings {
  searchEngine: string
  homepage: string
  devtools: boolean
  // Secure DNS: off | cloudflare | google | custom. При custom — dnsCustom.
  dnsMode: string
  dnsCustom: string
  // Заглушка: UI-язык браузера. Пока только хранится, перевод позже.
  locale: string
  // Анимации оверлея (меню/диалоги/тосты). false = открывать моментально.
  animations: boolean
  // Тема shell: dark | light | system | slate. Оверлей читает для своих панелей.
  theme: string
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
  locale: 'en',
  animations: true,
  theme: 'dark',
  roundedCorners: false,
  fullscreenMode: 'window',
  rememberBounds: true,
  rememberTabs: true,
  zoomMode: 'origin',
  zoomSync: false
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

export async function saveSettings(patch: Partial<BrowserSettings>): Promise<BrowserSettings> {
  const current = await load()
  const next: BrowserSettings = { ...current, ...patch }
  cache = next
  filePath = filePath || join(app.getPath('userData'), 'settings.json')
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(filePath, JSON.stringify(next, null, 2), 'utf-8')
  return { ...next }
}
