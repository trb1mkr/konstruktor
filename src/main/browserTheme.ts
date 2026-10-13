// Тема сайтов, окон расширений и внутренних страниц: резолв схемы и
// единая точка применения к Chromium.
//
// Механик две, и они дополняют друг друга:
// - nativeTheme.themeSource переключает prefers-color-scheme (палитра
//   сайтов на media-запросах); смена доезжает до renderer асинхронно;
// - CSS color-scheme задает used-схему документа (скроллбар, формы,
//   канвас, ветка light-dark()/системных цветов) и применяется
//   инъекцией синхронно.
// Только первой механики мало: скроллбар остаётся светлым, а сайты на
// системных цветах не перекрашиваются. Только второй — не работают
// media-запросы, по которым выбирает палитру большинство сайтов.
import { nativeTheme } from 'electron'
import { windows, type TabData } from './windows/browserState'
import { getSettings } from './store/settingsStore'

// База темы браузера: во что тема превращается для веб-контента.
// Цветная тема обязана объявить базу явно — иначе новая тема молча
// получит dark и разойдется с собственной палитрой shell.
const THEME_SCHEME: Record<string, 'dark' | 'light' | 'system'> = {
  dark: 'dark',
  light: 'light',
  slate: 'dark',
  system: 'system'
}

export type WebContentScheme = 'dark' | 'light' | 'system'

// Отладка темы: THEME_DEBUG=1 печатает резолв схемы при старте и на
// каждой смене. Как остальная диагностика — только по флагу окружения,
// в проде ветки мертвы (см. docs/DIAGNOSTICS.md).
const THEME_DEBUG = process.env.THEME_DEBUG === '1'

function logTheme(message: string): void {
  if (THEME_DEBUG) console.log('[theme] ' + message)
}

// Настройки, влияющие на схему веб-контента. Структурный тип, а не
// BrowserSettings: модуль не должен тянуть весь стор ради двух полей.
export interface ThemeSettings {
  theme?: string
  webContentTheme?: string
}

// Тема ОС БЕЗ маскировки override'ом. nativeTheme.shouldUseDarkColors
// отражает themeSource, а не ОС, поэтому читать значение имеет смысл
// только когда override не стоит (themeSource === 'system').
let osDark = nativeTheme.shouldUseDarkColors

function readOsTheme(): void {
  if (nativeTheme.themeSource !== 'system') return
  osDark = nativeTheme.shouldUseDarkColors
}

// Живое перекрашивание внутренней страницы без перезагрузки.
export function buildPageThemeScript(pageTheme: string): string {
  return `document.documentElement.dataset.theme = ${JSON.stringify(pageTheme)}; true`
}

/**
 * Базовая тема веб-контента -> схема для Chromium.
 *
 * 'follow' берет базу темы браузера из THEME_SCHEME, остальные значения —
 * прямой override: она и определяет, какими видят себя сайты и окна
 * расширений, независимо от темы интерфейса браузера.
 */
export function webContentScheme(settings: ThemeSettings): WebContentScheme {
  const override = settings.webContentTheme ?? 'follow'
  if (override === 'light' || override === 'dark' || override === 'system') return override
  return THEME_SCHEME[settings.theme ?? 'dark'] ?? 'dark'
}

// Применяет схему веб-контента к Chromium. Без этого сайты и окна
// расширений следуют теме ОС, что бы ни стояло в настройках браузера.
// Вызывать при старте (до первого окна) и на каждое изменение темы.
export function applyWebContentScheme(settings: ThemeSettings): void {
  const next = webContentScheme(settings)
  if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next
  // Тема ОС читается ПОСЛЕ присвоения: только при 'system' она не
  // замаскирована, и значение готово сразу, без ожидания 'updated'.
  // Иначе переключение override->follow с темой браузера 'system'
  // отдало бы внутренним страницам устаревшую тему до прихода события.
  readOsTheme()
  logTheme(
    `web content: browser=${settings.theme ?? 'dark'} override=${settings.webContentTheme ?? 'follow'} -> ${next} (osDark=${osDark})`
  )
}

// Системная тема ОС: nativeTheme следит сам и шлет обновления.
// Перекрашиваем нативный фон view, когда за ОС следуем; предпочтения
// сайтов Chromium пересчитывает сам (событие 'updated' от themeSource
// сюда тоже приходит — повторный проход безвреден).
export function watchSystemTheme(): void {
  nativeTheme.on('updated', () => {
    readOsTheme()
    logTheme(`OS updated: osDark=${osDark} themeSource=${nativeTheme.themeSource}`)
    void getSettings()
      .then((s) => applyThemeToViews(s.theme ?? 'dark'))
      .catch(() => undefined)
  })
}

// Схема сайтов и окон расширений. После выставленного themeSource это
// ровно shouldUseDarkColors: 'system' Chromium уже разрешил сам.
export function effectiveColorScheme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

// Тема внутренних страниц konstruktor://. Базовая тема веб-контента на
// них НЕ действует (иначе настройка «для сайтов» перекрашивала бы свои
// же страницы). slate остается собой, system резолвится по теме ОС.
export function effectivePageTheme(theme: string): 'dark' | 'light' | 'slate' {
  if (theme === 'slate') return 'slate'
  if (theme === 'light') return 'light'
  if (theme === 'system') return osDark ? 'dark' : 'light'
  return 'dark'
}

// Применяет тему к уже открытым view: used-схема, внутренние страницы и фон.
//
// Механики две и они дополняют друг друга:
// - prefers-color-scheme переключает nativeTheme.themeSource (выше), и это
//   асинхронно доезжает до renderer — палитра сайтов на media-запросах;
// - used-схему документа (скроллбар, формы, канвас, ветка light-dark() и
//   системных цветов) задает CSS-свойство color-scheme, и оно применяется
//   синхронно инъекцией. Без инъекции скроллбар остается светлым, а сайты
//   на системных цветах не перекрашиваются, даже если медиазапрос уже сменился.
// Сайты с захардкоженными цветами не изменятся ничем — их палитра
// не зависит от браузера.
export function applyThemeToViews(theme: string): void {
  for (const ws of windows.values()) {
    for (const rec of ws.tabs.values()) {
      applyThemeToTab(rec, theme)
      // Нативный фон view под тему: иначе при смене темы старая view
      // вспыхнет белым до первой отрисовки после переключения.
      try {
        rec.view.setBackgroundColor(viewBackgroundFor(rec.url, theme))
      } catch {
        // Старый Electron без setBackgroundColor у View — игнорим.
      }
    }
  }
}

// Схема used-цветов конкретной вкладки: у сайтов — базовая тема
// веб-контента, у внутренних страниц — их собственная (slate это dark).
function schemeForTab(rec: TabData, theme: string): 'dark' | 'light' {
  if (!rec.url.startsWith('konstruktor://')) return effectiveColorScheme()
  return effectivePageTheme(theme) === 'light' ? 'light' : 'dark'
}

// Инъекция used-схемы во вкладку. Ключ последнего insertCSS хранится в
// записи и снимается при замене: наложение старого color-scheme поверх
// нового оставило бы скроллбар и канвас от прежней темы.
function applyColorSchemeToTab(rec: TabData, scheme: 'dark' | 'light'): void {
  const wc = rec.view.webContents
  if (wc.isDestroyed()) return
  wc.insertCSS(`:root { color-scheme: ${scheme} !important; }`, { cssOrigin: 'author' })
    .then((k) => {
      if (rec.themeKey && rec.themeKey !== k) {
        wc.removeInsertedCSS(rec.themeKey).catch(() => undefined)
      }
      rec.themeKey = k
    })
    .catch(() => undefined)
}

// Тема одной вкладки: used-схема + dataset внутренней страницы.
// Вызывается при создании вкладки И на каждой загрузке документа —
// тогда первая же перезагрузка после смены темы даёт верную схему,
// а не несколько (инъекция синхронна, медиазапрос — нет).
export function applyThemeToTab(rec: TabData, theme: string): void {
  applyColorSchemeToTab(rec, schemeForTab(rec, theme))
  // Внутренние страницы читают тему только при загрузке —
  // проставляем dataset.theme вживую без перезагрузки.
  if (rec.url.startsWith('konstruktor://')) {
    rec.view.webContents
      .executeJavaScript(buildPageThemeScript(effectivePageTheme(theme)))
      .catch(() => undefined)
  }
}

// Фон сайтов и окон расширений — по схеме веб-контента.
// Служит и нативным фоном view, и backgroundColor окон расширений:
// без него попап стартует с белым #FFF и мигает при тёмной схеме.
export function webContentBackground(): string {
  return effectiveColorScheme() === 'light' ? '#f2f2f2' : '#141414'
}

// Нативный фон view до первой отрисовки страницы: иначе новая вкладка
// на пару миллисекунд вспыхивает белым (#FFF по умолчанию).
// У сайтов цвет от базовой темы веб-контента, у внутренних страниц — от
// палитры темы страницы (у slate свой фон), чтобы переход был бесшовным.
export function viewBackgroundFor(url: string, theme: string): string {
  if (url.startsWith('konstruktor://')) {
    const page = effectivePageTheme(theme)
    if (page === 'light') return '#f2f2f2'
    if (page === 'slate') return '#232a35'
    return '#141414'
  }
  return webContentBackground()
}
