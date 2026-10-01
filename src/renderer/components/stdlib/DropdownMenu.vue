<script setup lang="ts">
// Кнопка меню браузера. Само меню — DOM-оверлей в прозрачном окне
// поверх всего (см. src/main/overlay/ + src/renderer/overlay/).
// Системный Menu.popup не используем: на Windows он светлый и не стилизуется.
import { ref } from 'vue'

defineProps<{
  title?: string
}>()

const emit = defineEmits<{
  (e: 'select', action: string): void
}>()

const btn = ref<HTMLButtonElement | null>(null)

function toggle() {
  // Координаты кнопки ОТНОСИТЕЛЬНО CONTENT-ОБЛАСТИ окна (CSS-пиксели).
  // menu.popup в main ждет именно оконные координаты — перевод в экранные
  // не нужен, Electron маппит сам. Шлем правый край, чтобы меню равнялось
  // по правой стороне кнопки и не вылезало за окно.
  const rect = btn.value?.getBoundingClientRect()
  if (rect) {
    window.browserAPI.popupMenu({
      x: Math.round(rect.right),
      y: Math.round(rect.bottom)
    })
  } else {
    window.browserAPI.popupMenu({ x: 0, y: 0 })
  }
  emit('select', '__native__')
}
</script>

<template>
  <div class="dropdown">
    <button
      ref="btn"
      class="dropdown-toggle menu-trigger"
      title="Browser menu"
      @click="toggle"
    >{{ title ?? '☰' }}</button>
  </div>
</template>

<style scoped>
.dropdown { position: relative; display: flex; align-items: center; }
.dropdown-toggle {
  width: 36px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text-dim);
  border: none;
  border-radius: 8px;
  margin: 0;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.dropdown-toggle:hover { background: var(--btn-hover-bg); color: var(--text); }
</style>
