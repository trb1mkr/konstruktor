// Тема сайтов и внутренних страниц: резолв эффективной темы + пуш во все view.
// Выделено из index.ts (п.3 рефакторинга): чистые функции + один проход
// по пулу окон из browserState. Циклов нет — browserState никого не импортирует.
import { nativeTheme } from 'electron'
import { windows, type TabData } from './browserState'
import { buildPageThemeScript } from './findScripts'

export function effectiveColorScheme(theme: string): 'dark' | 'light' {
  if (theme === 'light') return 'light'
  if (theme === 'slate') return 'dark'
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return 'dark'
}

// Тема внутренних страниц konstruktor://: slate остается собой,
// system резолвится в dark/light через ОС.
export function effectivePageTheme(theme: string): 'dark' | 'light' | 'slate' {
  if (theme === 'slate') return 'slate'
  if (theme === 'light') return 'light'
  if (theme === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  return 'dark'
}

// Тема открытых сайтов: прокидываем color-scheme через CSS во все view.
// Работает только для сайтов, которые уважают prefers-color-scheme /
// color-scheme (GitHub, Wikipedia, MDN и т.п.). Сайты с захардкоженными
// цветами не изменятся — их палитра не зависит от браузера.
// 'system' — nativeTheme следует за ОС и рассылает обновления сам.
export function applyThemeToViews(theme: string): void {
  const scheme = effectiveColorScheme(theme)
  const pageTheme = effectivePageTheme(theme)
  const css = `:root { color-scheme: ${scheme} !important; }`
  for (const ws of windows.values()) {
    for (const rec of ws.tabs.values()) {
      rec.view.webContents
        .insertCSS(css, { cssOrigin: 'author' })
        .then((k) => {
          const prev = (rec as TabData & { themeKey?: string }).themeKey
          if (prev && prev !== k) {
            rec.view.webContents.removeInsertedCSS(prev).catch(() => undefined)
          }
          ;(rec as TabData & { themeKey?: string }).themeKey = k
        })
        .catch(() => undefined)
      // Внутренние страницы читают тему только при загрузке —
      // проставляем dataset.theme вживую без перезагрузки.
      if (rec.url.startsWith('konstruktor://')) {
        rec.view.webContents.executeJavaScript(buildPageThemeScript(pageTheme)).catch(() => undefined)
      }
      // Нативный фон view под тему: иначе при смене темы старая view
      // вспыхнет белым до первой отрисовки после переключения.
      try {
        rec.view.setBackgroundColor(viewBackgroundFor(theme))
      } catch {
        // Старый Electron без setBackgroundColor у View — игнорим.
      }
    }
  }
}

// Тема одной новой вкладки — сразу текущая, без ожидания смены настроек.
export type ThemeKeySetter = (k: string) => void

export function applyThemeToTab(rec: TabData, theme: string, setKey: ThemeKeySetter): void {
  try {
    const scheme = effectiveColorScheme(theme ?? 'dark')
    void rec.view.webContents
      .insertCSS(`:root { color-scheme: ${scheme} !important; }`, { cssOrigin: 'author' })
      .then((k) => setKey(k))
      .catch(() => undefined)
  } catch {
    // CSS еще не готов — применится при следующей смене темы.
  }
}

// Нативный фон view до первой отрисовки страницы: иначе новая вкладка
// на пару миллисекунд вспыхивает белым (#FFF по умолчанию).
// Цвет совпадает с --pg-bg внутренних страниц, чтобы переход был бесшовным.
export function viewBackgroundFor(theme: string): string {
  const page = effectivePageTheme(theme)
  if (page === 'light') return '#f2f2f2'
  if (page === 'slate') return '#232a35'
  return '#141414'
}
