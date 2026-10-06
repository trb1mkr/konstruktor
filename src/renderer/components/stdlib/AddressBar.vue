<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { tabs, activeTabId } from '../../core/useTabs'

// Адресная строка. Стили полностью переопределяемые через CSS.
const input = ref('')

// Масштаб активной вкладки в процентах. Реактивен «бесплатно»: зум-действия
// (клавиши, колесо, попап) пушат tabs:state, а поле zoom читает main
// опросом webContents — badge не может разойтись со страницей.
const zoomPercent = computed(() => {
  const current = tabs.value.find((t) => t.id === activeTabId.value)
  return current?.zoom ?? 100
})

const zoomBtn = ref<HTMLButtonElement | null>(null)

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

// Попап масштаба: якорь — правый НИЖНИЙ угол бейджа. Паттерн DropdownMenu:
// меню живёт в отдельном overlay-окне, DOM-выпадашка ушла бы под
// WebContentsView (в пресете Minimal адресная строка вообще снизу).
function openZoomPopup() {
  const rect = zoomBtn.value?.getBoundingClientRect()
  if (rect) {
    window.browserAPI.zoomPopup({
      x: Math.round(rect.right),
      y: Math.round(rect.bottom)
    })
  } else {
    window.browserAPI.zoomPopup({ x: 0, y: 0 })
  }
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
    <!-- Бейдж масштаба: виден только при проценте != 100. При исчезновении
         url-input снова занимает ширину через flex: 1 — инсеты layout
         (высота панели) от ширины бейджа не зависят. Класс menu-trigger
         гасит dismiss по клику: закрытие/открытие попапа делает toggle
         по toggleKey, иначе клик закрыл бы его же и открыл обратно. -->
    <button
      v-if="zoomPercent !== 100"
      ref="zoomBtn"
      class="zoom-badge menu-trigger"
      title="Zoom"
      @click="openZoomPopup"
    >🔬 {{ zoomPercent }}%</button>
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
/* Бейдж масштаба: та же пилюля, что и кнопки навигации, но компактнее.
   Числа табличные (font-variant-numeric), иначе "100%" -> "110%" дёргает
   ширину бейджа и рядом дёргается url-input. */
.zoom-badge {
  background: var(--btn-bg);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.zoom-badge:hover { background: var(--btn-hover-bg); }
</style>
