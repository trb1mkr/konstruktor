<script setup lang="ts">
import { ref, watch } from 'vue'
import { tabs, activeTabId } from '../../core/useTabs'

// Адресная строка. Стили полностью переопределяемые через CSS.
const input = ref('')

// Синхронизация поля с URL активной вкладки.
watch(
  [tabs, activeTabId],
  () => {
    const current = tabs.value.find((t) => t.id === activeTabId.value)
    if (current) input.value = current.url === 'about:blank' ? '' : current.url
  },
  { immediate: true }
)

async function go() {
  if (activeTabId.value === null || !input.value.trim()) return
  await window.browserAPI.navigate(activeTabId.value, input.value.trim())
}

async function back() {
  await window.browserAPI.goBack()
}
async function forward() {
  await window.browserAPI.goForward()
}
async function reload() {
  await window.browserAPI.reload()
}
</script>

<template>
  <div class="addressbar">
    <button class="nav-btn" title="Back" @click="back">←</button>
    <button class="nav-btn" title="Forward" @click="forward">→</button>
    <button class="nav-btn" title="Reload" @click="reload">⟳</button>
    <input
      v-model="input"
      class="url-input"
      placeholder="Enter URL or search query"
      spellcheck="false"
      @keydown.enter="go"
    />
    <button class="go-btn" title="Go" @click="go">🔍</button>
    <slot />
  </div>
</template>

<style scoped>
.addressbar {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  background: var(--panel-bottom-bg);
}
.url-input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  outline: none;
}
.nav-btn, .go-btn {
  background: var(--btn-bg);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
}
.nav-btn:hover, .go-btn:hover { background: var(--btn-hover-bg); }
</style>
