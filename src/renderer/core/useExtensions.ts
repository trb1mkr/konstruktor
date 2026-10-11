import { ref, onMounted, onUnmounted } from 'vue'
import type { ExtensionsState } from '../../shared/extensions-types'

// Состояние расширений для shell: main — единственный источник истины,
// здесь только последний присланный срез. Пуш приходит после любой
// операции (установка, тумблер, смена badge из фона расширения).
export const extensions = ref<ExtensionsState>({ list: [], enabled: true, devMode: false })

export function useExtensions() {
  async function refresh(): Promise<void> {
    try {
      extensions.value = await window.browserAPI.listExtensions()
    } catch {
      // Мост недоступен — оставляем прежний срез.
    }
  }

  let unsub: (() => void) | null = null

  onMounted(async () => {
    if (!window.browserAPI) return
    await refresh()
    unsub = window.browserAPI.onExtensionsChanged((state) => {
      extensions.value = state
    })
  })

  onUnmounted(() => {
    unsub?.()
  })

  return { extensions, refresh }
}
