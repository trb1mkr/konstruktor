<script setup lang="ts">
import type { MenuItem } from './OverlayRoot.vue'

// Темное меню браузера: верстка наша, поверх WebContentsView за счет
// отдельного прозрачного окна. Пункты присылает main в payload.
defineProps<{
  items: MenuItem[]
  incognito: boolean
  align?: 'start' | 'end'
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
}>()
</script>

<template>
  <div class="browser-menu" @mousedown.stop :class="{ 'align-start': align === 'start' }">
    <div v-if="incognito" class="menu-badge">🕵️ Incognito</div>
    <button
      v-for="item in items"
      :key="item.id"
      class="menu-item"
      :disabled="item.disabled"
      @click="emit('select', item.id)"
    >
      <span class="menu-icon">
        <span v-if="item.color" class="menu-dot" :style="{ background: item.color }" />
        <template v-if="item.icon">{{ item.icon }}</template>
      </span>
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.browser-menu {
  min-width: 220px;
  max-width: 280px;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 6px;
  margin: 4px 4px 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* Контекстные меню: левый край меню в точке клика */
.browser-menu.align-start {
  margin: 4px 0 0 4px;
}
.menu-badge {
  font-size: 12px;
  color: #9d7bff;
  padding: 6px 10px 2px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: none;
  color: var(--ov-text);
  text-align: left;
  font-size: 14px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) { background: var(--ov-hover); }
.menu-item:disabled { color: #666; cursor: default; }
.menu-icon { width: 20px; text-align: center; flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; }
/* Цвет группы в Add to group: точка как на панели закладок. */
.menu-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>
