import { createApp } from 'vue'
import OverlayRoot from './overlay/OverlayRoot.vue'
import './overlay/overlay.css'
import { initI18n, installI18n } from './i18n'

// До init монтировать нельзя: i18next-vue отдаёт '' для неготового
// i18next. Начальный язык 'en', актуальный приходит с первым push
// (PushMessage.language) — см. OverlayRoot.applyPayload.
async function boot(): Promise<void> {
  await initI18n('en')
  const app = createApp(OverlayRoot)
  installI18n(app)
  app.mount('#overlay')
}

void boot()
