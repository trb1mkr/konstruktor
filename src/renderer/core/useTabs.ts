import { ref, onMounted, onUnmounted } from 'vue'
import type { TabInfo, OpenGroupInfo, SavedGroupInfo } from '../../preload/shell/index'

// Общее состояние вкладок для всех SFC-компонентов.
export const tabs = ref<TabInfo[]>([])
export const activeTabId = ref<number | null>(null)
// true если текущее окно инкогнито — UI красит shell в темный акцент.
export const isIncognito = ref(false)
// Открытые экземпляры групп этого окна (порядок = порядок на панели).
export const openGroups = ref<OpenGroupInfo[]>([])
// Шаблоны групп из groups.json (панель закладок, переживают закрытие).
export const savedGroups = ref<SavedGroupInfo[]>([])
// Единый ряд панели: 't:<id>' вкладка, 'g:<instanceId>' корневая группа.
// Группы того же ранга, что вкладки — таб и группа чередуются свободно.
export const stripOrder = ref<string[]>([])
export const pinnedStripOrder = ref<string[]>([])

let unsubState: (() => void) | null = null
let unsubNav: (() => void) | null = null
let unsubGroups: (() => void) | null = null

export function useTabs() {
  async function refresh() {
    const state = await window.browserAPI.listTabs()
    tabs.value = state.tabs
    activeTabId.value = state.activeTabId
    isIncognito.value = state.incognito
    openGroups.value = state.openGroups ?? []
    stripOrder.value = state.stripOrder ?? []
    pinnedStripOrder.value = state.pinnedStripOrder ?? []
  }

  async function refreshGroups() {
    try {
      savedGroups.value = await window.browserAPI.listGroups()
    } catch {
      savedGroups.value = []
    }
  }

  onMounted(async () => {
    if (!window.browserAPI) {
      console.error('[renderer] browserAPI missing — preload did not load')
      return
    }
    await refresh()
    await refreshGroups()
    unsubState = window.browserAPI.onTabsState((state) => {
      tabs.value = state.tabs
      activeTabId.value = state.activeTabId
      isIncognito.value = state.incognito
      openGroups.value = state.openGroups ?? []
      stripOrder.value = state.stripOrder ?? []
      pinnedStripOrder.value = state.pinnedStripOrder ?? []
    })
    // Моментальный синк шаблонов: цвет/имя/иконка обновляются сразу,
    // без закрытия и повторного открытия группы.
    unsubGroups = window.browserAPI.onGroupsChanged((groups) => {
      savedGroups.value = groups
    })
    unsubNav = window.browserAPI.onNavigated(() => {
      void refresh()
    })
    // Вкладку создает main после did-finish-load. Здесь только ждем пуш состояния.
  })

  onUnmounted(() => {
    unsubState?.()
    unsubNav?.()
    unsubGroups?.()
  })

  return { tabs, activeTabId, isIncognito, openGroups, savedGroups, stripOrder, pinnedStripOrder, refresh, refreshGroups }
}
