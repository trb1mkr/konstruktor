import { ref, onMounted, onUnmounted } from 'vue'
import type { TabInfo } from '../../preload/index'

// Общее состояние вкладок для всех SFC-компонентов.
export const tabs = ref<TabInfo[]>([])
export const activeTabId = ref<number | null>(null)
// true если текущее окно инкогнито — UI красит shell в темный акцент.
export const isIncognito = ref(false)

let unsubState: (() => void) | null = null
let unsubNav: (() => void) | null = null

export function useTabs() {
  async function refresh() {
    const state = await window.browserAPI.listTabs()
    tabs.value = state.tabs
    activeTabId.value = state.activeTabId
    isIncognito.value = state.incognito
  }

  onMounted(async () => {
    if (!window.browserAPI) {
      console.error('[renderer] browserAPI missing — preload did not load')
      return
    }
    await refresh()
    unsubState = window.browserAPI.onTabsState((state) => {
      tabs.value = state.tabs
      activeTabId.value = state.activeTabId
      isIncognito.value = state.incognito
    })
    unsubNav = window.browserAPI.onNavigated(() => {
      void refresh()
    })
    // Вкладку создает main после did-finish-load. Здесь только ждем пуш состояния.
  })

  onUnmounted(() => {
    unsubState?.()
    unsubNav?.()
  })

  return { tabs, activeTabId, isIncognito, refresh }
}
