import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import { registerStdlib } from './components/stdlib'
import { installRegistry } from './core/registry'
import { initI18n, installI18n } from './i18n'
import { resolveLocale } from '../shared/i18n'

registerStdlib()

const app = createApp(App)
installRegistry(app)

// Язык: настройка locale ('auto' -> navigator.language) -> init -> mount.
// Монтировать до init нельзя: i18next-vue отдаёт '' для неготового
// i18next, и первый кадр показал бы пустые тултипы.
async function boot(): Promise<void> {
  let lang = 'en'
  try {
    const settings = await window.browserAPI.getSettings()
    lang = resolveLocale(settings.locale, navigator.language)
  } catch {
    // Мост недоступен — остаёмся на английском.
  }
  await initI18n(lang)
  installI18n(app)
  app.mount('#app')
}

void boot()
