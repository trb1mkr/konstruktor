<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { tabs, activeTabId, isIncognito, savedGroups, openGroups } from '../../core/useTabs'

// Панель закладок: звезда, закладки, закрепленные группы вкладок.
// Незакрепленная группа здесь не показывается — она живет только
// на панели вкладок, пока открыта. Закрепленная видна всегда,
// даже когда все ее вкладки закрыты.
interface Bookmark {
  title: string
  url: string
  favicon: string
}

const KEY = 'konstruktor.bookmarks.v1'
const bookmarks = ref<Bookmark[]>([])
const bar = ref<HTMLElement | null>(null)

function load() {
  try {
    bookmarks.value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    bookmarks.value = []
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(bookmarks.value))
}

function addCurrent() {
  // В инкогнито закладки не пишем.
  if (isIncognito.value) return
  const current = tabs.value.find((t) => t.id === activeTabId.value)
  if (!current || !current.url || current.url === 'about:blank') return
  // Внутренние страницы (konstruktor://) тоже можно в закладки:
  // открываются через navigate в активной вкладке, как обычные URL.
  // Тоггл: повторный клик по закрашенной звезде снимает закладку.
  if (bookmarks.value.some((b) => b.url === current.url)) {
    remove(current.url)
    return
  }
  bookmarks.value.push({
    title: current.title || current.url,
    url: current.url,
    favicon: current.favicon ?? ''
  })
  save()
}

// Закрашенная звезда = текущая страница уже в закладках.
const isBookmarked = computed(() => {
  const current = tabs.value.find((t) => t.id === activeTabId.value)
  if (!current?.url) return false
  return bookmarks.value.some((b) => b.url === current.url)
})

function remove(url: string) {
  bookmarks.value = bookmarks.value.filter((b) => b.url !== url)
  save()
}

async function open(url: string) {
  if (activeTabId.value !== null) await window.browserAPI.navigate(activeTabId.value, url)
}

// Только закрепленные шаблоны: незакрепленные на панели закладок не живут.
const pinnedGroups = computed(() => savedGroups.value.filter((g) => g.pinned))

// Открыть шаблон группы: новый экземпляр, можно несколько одинаковых.
async function openSavedGroup(savedId: string) {
  await window.browserAPI.openGroup(savedId)
}

// Сколько экземпляров шаблона сейчас открыто (бейдж на кнопке).
function openCount(savedId: string) {
  return openGroups.value.filter((g) => g.savedId === savedId).length
}

// Меню шаблона на панели закладок больше нет: ЛКМ открывает экземпляр,
// ПКМ удаляет шаблон (открытые экземпляры разгруппировываются, вкладки живут).
async function deleteSavedGroup(savedId: string) {
  await window.browserAPI.deleteGroup(savedId)
  await window.browserAPI.listGroups().then((groups) => {
    savedGroups.value = groups
  }).catch(() => undefined)
}

// Колесо над панелью: вертикальное колесо листает закладки
// горизонтально. Скроллбара нет (скрыт в CSS), листание — только так.
function onWheel(e: WheelEvent) {
  const el = bar.value
  if (!el) return
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (dx === 0) return
  e.preventDefault()
  el.scrollLeft += dx
}

onMounted(load)
</script>

<template>
  <div ref="bar" class="bookmarks" @wheel.prevent="onWheel($event)">
    <button
      class="bm-add"
      :class="{ active: isBookmarked }"
      :title="isBookmarked ? $t('bookmarks.remove') : $t('bookmarks.add')"
      @click="addCurrent"
    >{{ isBookmarked ? '★' : '☆' }}</button>
    <button
      v-for="b in bookmarks"
      :key="b.url"
      class="bm-item"
      :title="b.url"
      @click="open(b.url)"
      @contextmenu.prevent="remove(b.url)"
    >
      <img v-if="b.favicon" class="bm-fav" :src="b.favicon" alt="" draggable="false" />
      <span v-else class="bm-fav fallback">◉</span>
      {{ b.title }}
    </button>
    <!-- Закрепленные группы: ЛКМ открывает экземпляр, ПКМ удаляет шаблон. -->
    <button
      v-for="g in pinnedGroups"
      :key="g.id"
      class="bm-item bm-group"
      :style="{ '--group-color': g.color }"
      :title="$t('bookmarks.groupTabs', { name: g.name, count: g.urls.length })"
      @click="openSavedGroup(g.id)"
      @contextmenu.prevent="deleteSavedGroup(g.id)"
    >
      <span class="bm-group-dot" />
      <img v-if="g.icon && !g.icon.startsWith('emoji:')" class="bm-fav" :src="g.icon" alt="" draggable="false" />
      <span v-else class="bm-fav fallback">{{ g.icon.replace(/^emoji:/, '') || '📁' }}</span>
      {{ g.name }}
      <span v-if="openCount(g.id) > 0" class="bm-group-count">{{ openCount(g.id) }}</span>
    </button>
    <slot />
  </div>
</template>

<style scoped>
.bookmarks {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px 8px;
  background: var(--panel-bg);
  /* Переполнение — только колесом: скроллбары скрыты всегда,
     даже при сотне закладок или экстремально узком окне. */
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.bookmarks::-webkit-scrollbar { display: none; }
.bm-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 4px 8px;
  border-radius: 6px;
  white-space: nowrap;
  flex-shrink: 0;
}
.bm-item:hover { background: var(--btn-hover-bg); color: var(--text); }
.bm-fav { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }
.bm-fav.fallback { font-size: 10px; color: #888; }
.bm-add {
  background: transparent;
  border: none;
  border-radius: 8px;
  margin: 2px;
  color: #888;
  cursor: pointer;
  font-size: 16px;
  padding: 4px 10px;
  flex-shrink: 0;
}
.bm-add:hover { background: var(--btn-hover-bg); color: var(--text); }
/* Закрашенная звезда = страница в закладках. */
.bm-add.active { color: #ffd75e; }
/* Сохраненная группа: цветная точка + счетчик открытых экземпляров. */
.bm-group { border: 1px solid color-mix(in srgb, var(--group-color, #888888) 45%, transparent); }
.bm-group-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--group-color, #888888);
  flex-shrink: 0;
}
.bm-group-count {
  font-size: 11px;
  color: var(--text-faint);
  background: var(--btn-bg);
  border-radius: 8px;
  padding: 0 6px;
}
</style>
