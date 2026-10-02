<script setup lang="ts">
import type { MenuItem } from '../../shared/overlay-types'
import MenuList from './components/MenuList.vue'

// Меню окна: ПКМ по кнопкам навигации (свернуть/развернуть/закрыть).
//
// Отдельный компонент, а не BrowserMenu с пропом, потому что отличается
// не только источник пунктов: у меню окна есть разделители (в системном
// их три), и они меняют высоту карточки. Если бы разделители жили в
// общем MenuList, они бы достались и контекстным меню, где их нет.
//
// Форма пункта — та же, что везде в проекте (MenuItem), вёрстка пункта —
// тоже (MenuList). Держать здесь копию разметки было бы ровно тем, что
// уже устранено шагом «единый MenuList».
defineProps<{
  items: MenuItem[]
  align?: 'start' | 'end'
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
}>()
</script>

<template>
  <MenuList
    class="window-menu"
    :class="{ 'align-start': align === 'start' }"
    :items="items"
    @select="emit('select', $event)"
  />
</template>

<style scoped>
/* Положение карточки внутри окна: координаты считает main (geometry.ts),
   здесь только отступ от края окна до меню. */
.window-menu {
  margin: 4px 4px 0 0;
}
/* Меню окна открывается по левому краю точки вызова (align: 'anchor'). */
.window-menu.align-start {
  margin: 4px 0 0 4px;
}
</style>