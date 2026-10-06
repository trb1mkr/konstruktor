// i18n renderer-общий: одна фабрика для shell (main.ts) и overlay (overlay.ts).
//
// Порядок обязателен: init ДО app.mount — i18next-vue отдаёт пустую строку
// для неготового i18next (guard i18nextReady в $t), и первый кадр
// показал бы пустые тултипы.
import type { App } from 'vue'
import i18next from 'i18next'
import I18NextVue from 'i18next-vue'
import { i18nOptions } from '../shared/i18n'

function devLog(message: string): void {
  if (import.meta.env.DEV) console.log(`[i18n] ${message}`)
}

// Инициализация с заданным языком. Повторный вызов — смена языка
// (shell узнаёт о нём из settings:changed, overlay — из PushMessage.language).
export async function initI18n(lang: string): Promise<void> {
  if (i18next.isInitialized) {
    await changeLanguage(lang)
    return
  }
  await i18next.init(
    i18nOptions(lang, (key, languages) => {
      if (import.meta.env.DEV) console.warn(`[i18n] missing: ${key} (${languages})`)
    }),
  )
  devLog(`init lang=${lang}`)
}

// Смена языка без переинициализации. languageChanged срабатывает
// синхронно (каталоги вшиты), поэтому компоненты перерисовываются
// до следующего кадра — вспышки старого языка нет.
export async function changeLanguage(lang: string): Promise<void> {
  if (!i18next.isInitialized || lang === i18next.language) return
  await i18next.changeLanguage(lang)
  devLog(`language -> ${lang}`)
}

// Подключение к Vue: $t в шаблонах, useTranslation() в script setup.
export function installI18n(app: App): void {
  app.use(I18NextVue, { i18next })
}

// Тот же приём, что в main: bind сохраняет this, cast — строгие типы ключей.
export const t = i18next.t.bind(i18next) as typeof i18next.t
export { i18next }
