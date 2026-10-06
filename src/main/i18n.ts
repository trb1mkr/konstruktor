// i18n main-процесса: init до первого окна, смена языка из настроек,
// синхронный t() для меню, диалогов, тостов и счётчиков.
//
// После init() вызов t() синхронен — так и собираются контекстные меню
// (контекст требует синхронности, как у getSettingsSync()).
import { app } from 'electron'
import i18next from 'i18next'
import { getSettings } from './settingsStore'
import { i18nOptions, resolveLocale } from '../shared/i18n'

// Логи только в dev-сборке, общий префикс [i18n] (см. shared/i18n/I18N.md).
function devLog(message: string): void {
  if (import.meta.env.DEV) console.log(`[i18n] ${message}`)
}

// Init при старте: настройки -> резолв 'auto' по локали системы -> init.
// Вызывается в whenReady ДО первого createWindow и регистрации страниц.
export async function initI18n(): Promise<void> {
  const settings = await getSettings()
  const lang = resolveLocale(settings.locale, app.getLocale())
  await i18next.init(
    i18nOptions(lang, (key, languages) => devLog(`missing: ${key} (${languages})`)),
  )
  devLog(`init lang=${lang}`)
}

/**
 * Смена языка из settings:save. Возвращает фактический код: 'auto'
 * резолвится по локали системы, незнакомый код деградирует до 'en'.
 */
export async function setLocalePreference(pref: string): Promise<string> {
  const lang = resolveLocale(pref, app.getLocale())
  if (lang === i18next.language) return lang
  await i18next.changeLanguage(lang)
  devLog(`language -> ${lang}`)
  return lang
}

// Текущий язык: код для PushMessage.language и сборки внутренних страниц.
export function currentLang(): string {
  return i18next.language || 'en'
}

// bind + cast: сорванный с this вызов сломал бы резолв fallback'а,
// а cast сохраняет строгие типы ключей из CustomTypeOptions.
export const t = i18next.t.bind(i18next) as typeof i18next.t
