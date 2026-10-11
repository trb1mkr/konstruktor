<script setup lang="ts">
import { ref } from 'vue'

// Кнопка меню расширений (пазл). Список рисует overlay-вид 'extensions';
// здесь только якорь — правый нижний угол кнопки в координатах
// content-области окна, как у кнопки ☰.
const btn = ref<HTMLButtonElement | null>(null)

function toggle(): void {
  const rect = btn.value?.getBoundingClientRect()
  window.browserAPI.extensionsMenu({
    x: Math.round(rect?.right ?? 0),
    y: Math.round(rect?.bottom ?? 0)
  })
}
</script>

<template>
  <button
    ref="btn"
    class="ext-menu-btn menu-trigger"
    type="button"
    :title="$t('extensions.menu')"
    @click="toggle"
  >
    🧩
  </button>
</template>

<style scoped>
.ext-menu-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-dim);
  border: none;
  border-radius: 8px;
  padding: 0;
  font-size: 15px;
  cursor: pointer;
}
.ext-menu-btn:hover { background: rgba(255, 255, 255, 0.12); }
</style>
