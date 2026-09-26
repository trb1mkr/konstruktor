<script setup lang="ts">
import { ref, onMounted } from 'vue'

// Страница настроек конструктора: выбор layout-пресета, поисковик.
export interface BrowserSettings {
  preset: string
  searchEngine: string
  homepage: string
}

const KEY = 'konstruktor.settings.v1'

const settings = ref<BrowserSettings>({
  preset: 'classic-top',
  searchEngine: 'https://www.google.com/search?q=%s',
  homepage: 'https://example.com'
})

const emit = defineEmits<{
  (e: 'change', value: BrowserSettings): void
}>()

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) settings.value = { ...settings.value, ...JSON.parse(raw) }
  } catch {
    // Игнорируем битый JSON, остаются дефолты.
  }
}

function save() {
  localStorage.setItem(KEY, JSON.stringify(settings.value))
  emit('change', { ...settings.value })
}

onMounted(load)
</script>

<template>
  <div class="settings">
    <h2>Browser settings</h2>
    <label class="row">
      <span>Layout preset</span>
      <select v-model="settings.preset" @change="save">
        <option value="classic-top">Classic top</option>
        <option value="address-bottom">Address bottom</option>
        <option value="minimal">Minimal</option>
      </select>
    </label>
    <label class="row">
      <span>Search engine URL (%s = query)</span>
      <input v-model="settings.searchEngine" @change="save" spellcheck="false" />
    </label>
    <label class="row">
      <span>Homepage</span>
      <input v-model="settings.homepage" @change="save" spellcheck="false" />
    </label>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 12px; padding: 16px; background: #1e1e1e; }
.row { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
input, select {
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #2b2b2b;
  color: #eee;
}
</style>
