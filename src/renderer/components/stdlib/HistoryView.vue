<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { isIncognito } from '../../core/useTabs'

interface HistoryEntry {
  url: string
  title: string
  visitedAt: number
}

const KEY = 'konstruktor.history.v1'
const entries = ref<HistoryEntry[]>([])

function load() {
  try {
    entries.value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    entries.value = []
  }
}

// История пополняется подпиской на навигацию.
// В инкогнито-окне ничего не пишем.
onMounted(() => {
  load()
  window.browserAPI.onNavigated(({ url }) => {
    if (isIncognito.value) return
    entries.value.unshift({ url, title: url, visitedAt: Date.now() })
    entries.value = entries.value.slice(0, 200)
    localStorage.setItem(KEY, JSON.stringify(entries.value))
  })
})

async function open(url: string) {
  await window.browserAPI.createTab(url)
}

function clear() {
  entries.value = []
  localStorage.removeItem(KEY)
}
</script>

<template>
  <div class="history">
    <div class="history-header">
      <span>History</span>
      <button class="history-clear" @click="clear">Clear</button>
    </div>
    <div class="history-list">
      <button
        v-for="e in entries"
        :key="e.visitedAt + e.url"
        class="history-item"
        @click="open(e.url)"
      >
        <span class="history-title">{{ e.title }}</span>
        <span class="history-url">{{ e.url }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.history { display: flex; flex-direction: column; background: #1e1e1e; padding: 12px; gap: 8px; }
.history-header { display: flex; justify-content: space-between; align-items: center; }
.history-clear { background: #3a3a3a; color: #eee; border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.history-list { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; }
.history-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  background: #2b2b2b;
  border: none;
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  color: #eee;
}
.history-item:hover { background: #3a3a3a; }
.history-url { font-size: 12px; color: #999; }
</style>
