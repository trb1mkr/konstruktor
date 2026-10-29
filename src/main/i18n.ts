// i18n main-процесса: init до первого окна и переводчицы ПРОСТРАНСТВА.
//
// Глобальной `t` у main больше нет намеренно: пространств может быть
// открыто несколько, и у каждого свой язык. Меню, диалоги и тосты зовут
// `tFor(wsId)`, внутренние страницы — `translatorFor(lang)`.
import { app } from 'electron'
import i18next from 'i18next'
import { getSettingsSync } from './store/settingsStore'
import { bootWorkspaceId } from './workspaces/registry'
import { i18nOptions, resolveLocale } from '../shared/i18n'

// Логи только в dev-сборке, общий префикс [i18n] (см. shared/i18n/I18N.md).
function devLog(message: string): void {
  if (import.meta.env.DEV) console.log(`[i18n] ${message}`)
}

// Init при старте: язык пространства, которое стартует, -> init.
// Вызывается в whenReady ДО первого createWindow и регистрации страниц.
// Язык инстанса — только база для `getFixedT`; сами поверхности берут
// язык своего пространства.
export async function initI18n(): Promise<void> {
  const lang = langFor()
  await i18next.init(
    i18nOptions(lang, (key, languages) => devLog(`missing: ${key} (${languages})`)),
  )
  devLog(`init lang=${lang}`)
}

/** Тип переводчика: общий и для глобальной `t`, и для фиксированной. */
export type Translator = typeof i18next.t

/**
 * Язык пространства: 'auto' резолвится по локали системы, незнакомый код
 * деградирует до 'en'. Читается синхронно — меню и страницы собираются
 * синхронно, как и настройки.
 */
export function langFor(wsId = bootWorkspaceId()): string {
  return resolveLocale(getSettingsSync(wsId).locale, app.getLocale())
}

/**
 * Переводчица на заданный язык.
 *
 * Нужна, чтобы язык был настройкой ПРОСТРАНСТВА: у i18next язык один на
 * инстанс, а пространств может быть открыто несколько. `getFixedT` отдаёт
 * функцию с тем же контрактом, что `t`, но со своим языком — поэтому
 * меню и страницы собираются в языке своего пространства, не трогая
 * глобальное состояние переводчика.
 *
 * Каталоги вшиты статически (i18nOptions), так что переключение не требует
 * загрузки ресурсов.
 */
export function translatorFor(lang: string): Translator {
  return i18next.getFixedT(lang) as Translator
}

/** Переводчица пространства. Меню и страницы зовут её. */
export function tFor(wsId = bootWorkspaceId()): Translator {
  return translatorFor(langFor(wsId))
}
