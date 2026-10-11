<script setup lang="ts">
import { computed } from 'vue'
import { useExtensions, extensions } from '../../core/useExtensions'

// Кнопки расширений на панели. Показываются только закреплённые
// (значок 📌 в меню расширений): остальные остаются под кнопкой-пазлом,
// как в Chrome и Яндекс Браузере.
//
// Клик уходит в main: там решается, открыть попап расширения отдельным
// окном или отправить фону событие action.onClicked.
useExtensions()

const actions = computed(() =>
  extensions.value.list.filter((e) => e.enabled && e.pinned && e.action).map((e) => e.action!)
)

function click(id: string, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  void window.browserAPI.extensionActionClick(id, {
    x: Math.round(rect?.right ?? 0),
    y: Math.round(rect?.bottom ?? 0)
  })
}

// Правый клик по значку открывает меню расширений: так можно добраться
// до закрепления и страницы расширений, не ища кнопку-пазл.
function openMenu(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  window.browserAPI.extensionsMenu({
    x: Math.round(rect?.right ?? 0),
    y: Math.round(rect?.bottom ?? 0)
  })
}
</script>

<template>
  <!-- Пустая группа не рисуется вовсе. Контейнер с отступами без значков
       всё равно занимал бы ширину (padding + два gap строки адреса),
       и между кнопками поиска и пазла появлялся отступ вдвое больше
       обычного. Без закреплённых расширений между ними ровно один gap. -->
  <div v-if="actions.length" class="ext-actions">
    <button
      v-for="a in actions"
      :key="a.id"
      class="ext-btn"
      type="button"
      :title="a.title"
      @click="click(a.id, $event)"
      @contextmenu.prevent="openMenu"
    >
      <img v-if="a.icon" :src="a.icon" alt="" />
      <span v-else class="letter">{{ a.title.slice(0, 1).toUpperCase() }}</span>
      <span v-if="a.badge" class="badge" :style="a.badgeColor ? { background: a.badgeColor } : {}">
        {{ a.badge }}
      </span>
    </button>
  </div>
</template>

<style scoped>
.ext-actions { display: flex; align-items: center; gap: 4px; padding: 0 6px; }
.ext-btn {
  position: relative;
  width: 30px; height: 30px; border: none; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0;
}
.ext-btn:hover { background: rgba(255, 255, 255, 0.12); }
.ext-btn img { width: 18px; height: 18px; }
.letter { font-size: 13px; }
.badge {
  position: absolute; right: -1px; top: -1px;
  min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px;
  background: #666; color: #fff; font-size: 10px; line-height: 14px;
  text-align: center;
}
</style>
