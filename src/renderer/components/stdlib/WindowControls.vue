<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

// Кнопки кастомного заголовка: меню браузера + свернуть/развернуть/закрыть.
// Гарантированный прямоугольник справа, на одном уровне с вкладками.
const maximized = ref(false)

async function refresh() {
  try {
    maximized.value = await window.browserAPI.isMaximized()
  } catch {
    maximized.value = false
  }
}

let unsubMax: (() => void) | null = null
let unsubFs: (() => void) | null = null

onMounted(() => {
  void refresh()
  // Состояние maximize/fullscreen пушит main — опроса раз в секунду больше нет.
  unsubMax = window.browserAPI.onMaximizedChanged((v) => {
    maximized.value = v
  })
  unsubFs = window.browserAPI.onFullscreenChanged((v) => {
    if (v) maximized.value = true
    else void refresh()
  })
})

onUnmounted(() => {
  unsubMax?.()
  unsubFs?.()
})

async function minimize() {
  await window.browserAPI.minimizeWindow()
}
async function toggleMax() {
  maximized.value = await window.browserAPI.toggleMaximize()
}
async function close() {
  await window.browserAPI.closeWindow()
}
</script>

<template>
  <div class="window-controls">
    <slot name="menu" />
    <button class="wc-btn" title="Minimize" @click="minimize">─</button>
    <button class="wc-btn" :title="maximized ? 'Restore' : 'Maximize'" @click="toggleMax">
      {{ maximized ? '❐' : '☐' }}
    </button>
    <button class="wc-btn close" title="Close" @click="close">✕</button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  /* Кнопки не тащат окно — клики идут в Vue. */
  -webkit-app-region: no-drag;
  padding: 2px 2px 2px 0;
}
.wc-btn {
  width: 36px;
  height: 32px;
  min-height: 0;
  background: transparent;
  border: none;
  border-radius: 8px;
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.wc-btn:hover { background: var(--btn-hover-bg); color: var(--text); }
.wc-btn.close:hover { background: #c42b1c; color: #fff; }
</style>
