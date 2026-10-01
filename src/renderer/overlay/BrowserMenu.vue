<script setup lang="ts">
import type { MenuItem } from './OverlayRoot.vue'
import MenuList from './components/MenuList.vue'

// Обёртка над MenuList. Существует ради выравнивания по краю меню:
// геометрия окна считается в main по align, и положение карточки внутри
// окна — это margin, который знает только этот компонент.
//
// Всё остальное (пункты, клавиатура, оформление) — в MenuList. Держать
// здесь копию вёрстки пункта было бы ровно тем, что шаг 7 убирает: четыре
// меню приложения, четыре копии, и ни в одной нет навигации стрелками.
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
  <MenuList
    class="browser-menu"
    :class="{ 'align-start': align === 'start' }"
    :items="items"
    :badge="incognito ? '🕵️ Incognito' : undefined"
    @select="emit('select', $event)"
  />
</template>

<style scoped>
/* Положение карточки внутри окна. Координаты считает main (geometry.ts),
   здесь только отступ от края окна до меню. */
.browser-menu {
  margin: 4px 4px 0 0;
}
/* Контекстное меню: левый край карточки в точке клика. */
.browser-menu.align-start {
  margin: 4px 0 0 4px;
}
</style>
