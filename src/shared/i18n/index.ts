// Общая инфраструктура i18n: резолв языка, сборка ресурсов i18next,
// опции инициализации и типизация ключей. Один формат каталогов на все
// процессы: main, shell, overlay и внутренние страницы читают одни и те
// же файлы locales/*.json, вшитые в сборки (офлайн-работа сохраняется).
//
// Английский — язык-источник: en.json единственный источник истины,
// остальные каталоги сливаются поверх него (см. buildResources), поэтому
// непереведённый ключ показывает английский текст.
import type { InitOptions, Resource } from 'i18next'
import en from './locales/en.json'
import { LANGUAGES } from './languages'

export { LANGUAGES, langTag } from './languages'

// Английский каталог задаёт типы ключей: опечатка в t() роняет
// npm run typecheck (CustomTypeOptions читает i18next при каждом вызове).
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en }
    returnNull: false
    returnEmptyString: false
    strictKeyChecks: true
  }
}

type Tree = Record<string, unknown>

// Каталоги подключаются glob'ом: новый язык = файл в locales/, без правок
// этого модуля. eager — все каталоги вшиваются в бандл, файловое чтение
// в рантайме не нужно.
const localeModules = import.meta.glob('./locales/*.json', {
  eager: true,
}) as Record<string, { default: Tree }>

function deepMerge(base: Tree, patch: Tree): Tree {
  const out: Tree = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object'
        ? deepMerge(current as Tree, value as Tree)
        : value
  }
  return out
}

/**
 * Ресурсы i18next: `{ <код>: { translation: <каталог> } }`.
 *
 * Каждый язык предварительно сливаётся с английским: непереведённые ключи
 * берутся из en прямо в каталоге языка. Это даёт два эффекта: перевод
 * виден сразу при частичном каталоге, а missingKeyHandler срабатывает
 * только на реально отсутствующие ключи (опечатки), а не на каждый
 * непереведённый.
 */
export function buildResources(): Resource {
  const resources: Resource = {}
  for (const [path, mod] of Object.entries(localeModules)) {
    const file = path.slice(path.lastIndexOf('/') + 1)
    const code = file.replace(/\.json$/, '')
    resources[code] = { translation: deepMerge({ ...en }, mod.default) }
  }
  // Каталога en может не быть только если glob не нашёл файлов — страховка.
  if (!resources['en']) resources['en'] = { translation: { ...en } }
  return resources
}

/**
 * Резолв значения настройки locale в код языка.
 *
 * 'auto' (и любой незнакомый код) -> базовый код локали системы,
 * незнакомый язык -> 'en'. Системная локаль приходит аргументом:
 * shared не импортирует electron, её читает вызывающая сторона
 * (main — app.getLocale(), renderer — navigator.language).
 */
export function resolveLocale(pref: string | undefined, systemLocale: string): string {
  const known = (code: string): string | null =>
    LANGUAGES.some((l) => l.code === code) ? code : null
  if (pref && pref !== 'auto') return known(pref) ?? 'en'
  const base = (systemLocale || '').split(/[-_]/)[0].toLowerCase()
  return known(base) ?? 'en'
}

/**
 * Общие опции i18next для всех процессов.
 *
 * onMissing вызывается, когда ключ отсутствует во всех каталогах
 * (см. buildResources): в dev-сборке пишет строку `[i18n] missing: ...`.
 */
export function i18nOptions(
  lng: string,
  onMissing?: (key: string, languages: string) => void,
): InitOptions {
  return {
    resources: buildResources(),
    lng,
    fallbackLng: 'en',
    returnNull: false,
    // Пустая строка в каталоге = непереведённый ключ, а не пустой UI.
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    // Каталоги вшиты, бэкенда нет: init завершается сразу после await.
    saveMissing: true,
    missingKeyHandler: (lngs, _ns, key) => onMissing?.(key, [...lngs].join(',')),
  }
}
