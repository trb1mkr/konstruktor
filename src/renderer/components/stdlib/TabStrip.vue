<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { tabs, activeTabId } from '../../core/useTabs'

// Панель вкладок: DnD-перестановка, detach в новое окно, pin, favicon.
// Закрепленные всегда слева, только иконка сайта без лишних меток.
// Правый клик — контекстное меню (оверлей-окно): pin, duplicate,
// rename (инлайн в самой вкладке), set-icon (диалог по центру окна),
// copy URL, reload, close.
const strip = ref<HTMLElement | null>(null)
const dragId = ref<number | null>(null)
const dragOverId = ref<number | null>(null)
// true пока чужой drag (из другого окна) висит над панелью — подсветка слияния.
const mergeHover = ref(false)

const pinnedTabs = computed(() => tabs.value.filter((t) => t.pinned))
const normalTabs = computed(() => tabs.value.filter((t) => !t.pinned))

async function activate(id: number) {
  await window.browserAPI.activateTab(id)
}
async function add() {
  await window.browserAPI.createTab()
}
async function close(id: number, e: Event) {
  e.stopPropagation()
  await window.browserAPI.closeTab(id)
}
async function togglePin(id: number, e: Event) {
  e.stopPropagation()
  const t = tabs.value.find((x) => x.id === id)
  if (t) await window.browserAPI.pinTab(id, !t.pinned)
}

// Правый клик по вкладке: оверлей-меню в точке курсора.
// Координаты оконные (от content-области), как у кнопки ☰.
function openContext(id: number, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  void activate(id)
  window.browserAPI.tabContextMenu(id, {
    x: Math.round(e.clientX),
    y: Math.round(e.clientY)
  })
}

// Правый клик по самой панели (мимо вкладок): меню панели —
// создать вкладку, закрыть все. Клик по вкладке сюда не доходит:
// openContext делает stopPropagation.
function openStripMenu(e: MouseEvent) {
  e.preventDefault()
  window.browserAPI.tabStripContextMenu({
    x: Math.round(e.clientX),
    y: Math.round(e.clientY)
  })
}

// Колесо над панелью: вертикальное колесо листает вкладки
// горизонтально. Скроллбара нет (скрыт в CSS), листание — только так.
function onWheel(e: WheelEvent) {
  const el = strip.value
  if (!el) return
  // Горизонтальное колесо (тачпад) — как есть, вертикальное — вбок.
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (dx === 0) return
  e.preventDefault()
  el.scrollLeft += dx
}

// Переименование инлайн: текст вкладки становится полем ввода,
// геометрия вкладки не меняется. main шлет 'tabs:tab-action' с rename.
const renamingId = ref<number | null>(null)
const renameValue = ref('')
const renameInput = ref<HTMLInputElement | null>(null)

function startRename(id: number) {
  const t = tabs.value.find((x) => x.id === id)
  renamingId.value = id
  renameValue.value = t ? shortTitle(t) : ''
  void nextTick(() => {
    renameInput.value?.focus()
    renameInput.value?.select()
  })
}

async function confirmRename() {
  if (renamingId.value === null) return
  await window.browserAPI.renameTab(renamingId.value, renameValue.value)
  renamingId.value = null
  renameValue.value = ''
}

function cancelRename() {
  renamingId.value = null
  renameValue.value = ''
}

// Клик не по целевой вкладке — отмена без сохранения.
// Клик по сайту (WebContentsView) сюда не доходит, но blur поля
// при потере фокуса тоже отменяет — см. @blur в шаблоне.
function onGlobalPointer(e: PointerEvent) {
  if (renamingId.value === null) return
  const el = e.target instanceof Element ? e.target : null
  const tab = el?.closest('.tab')
  // Целевая вкладка содержит .tab-rename — клик по ней игнорим.
  if (tab?.querySelector('.tab-rename')) return
  cancelRename()
}

// Esc в любом фокусе shell — отмена переименования.
function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && renamingId.value !== null) {
    e.stopPropagation()
    cancelRename()
  }
}

// Единый обработчик клавиш переименования: Enter — сохранить, Esc — выйти.
function onRenameKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    cancelRename()
  } else if (e.key === 'Enter') {
    confirmRename()
  }
}

let unsubAction: (() => void) | null = null

onMounted(() => {
  unsubAction = window.browserAPI.onTabAction(({ id, action }) => {
    // Rename — инлайн в самой вкладке. set-icon обрабатывает
    // центральный диалог в main, сюда ничего не приходит.
    if (action === 'rename') startRename(id)
  })
  // Capture: клик по любому элементу shell мимо поля — отмена.
  window.addEventListener('pointerdown', onGlobalPointer, true)
  window.addEventListener('keydown', onGlobalKey, true)
})

onUnmounted(() => {
  unsubAction?.()
  window.removeEventListener('pointerdown', onGlobalPointer, true)
  window.removeEventListener('keydown', onGlobalKey, true)
})

function shortTitle(t: { title: string; url: string }) {
  return t.title || t.url || 'New Tab'
}

function onDragStart(id: number, e: DragEvent) {
  dragId.value = id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Формат метки свой: чужие окна отличают наш drag от файлов/текста.
    e.dataTransfer.setData('application/x-konstruktor-tab', String(id))
    e.dataTransfer.setData('text/plain', `konstruktor-tab:${id}`)
  }
  void activate(id)
}

function onDragOver(id: number, e: DragEvent) {
  e.preventDefault()
  if (dragId.value === null || dragId.value === id) return
  dragOverId.value = id
}

function onDragLeave() {
  dragOverId.value = null
}

async function onDrop(id: number, e: DragEvent) {
  e.preventDefault()
  const from = dragId.value
  dragOverId.value = null
  dragId.value = null
  if (from === null || from === id) return
  // Закрепленные и обычные не смешиваются: дроп только внутри своей группы.
  const fromPinned = tabs.value.find((t) => t.id === from)?.pinned ?? false
  const toPinned = tabs.value.find((t) => t.id === id)?.pinned ?? false
  if (fromPinned !== toPinned) return
  const group = (fromPinned ? pinnedTabs.value : normalTabs.value).map((t) => t.id)
  const fromIdx = group.indexOf(from)
  const toIdx = group.indexOf(id)
  if (fromIdx < 0 || toIdx < 0) return
  group.splice(toIdx, 0, ...group.splice(fromIdx, 1))
  // Склеиваем обратно: закрепленные всегда слева.
  const other = fromPinned ? normalTabs.value.map((t) => t.id) : pinnedTabs.value.map((t) => t.id)
  const next = fromPinned ? [...group, ...other] : [...other, ...group]
  await window.browserAPI.reorderTabs(next)
}

// Вынос за окно: если pointerup случился вне панели — detach в новое окно.
// Отслеживаем через dragend + координаты курсора относительно панели.
async function onDragEnd(e: DragEvent) {
  const id = dragId.value
  dragId.value = null
  dragOverId.value = null
  mergeHover.value = false
  if (id === null || !strip.value) return
  // dropEffect 'none' = дроп приняли в другом окне (merge) — новое не создаем.
  if (e.dataTransfer && e.dataTransfer.dropEffect !== 'none') return
  const r = strip.value.getBoundingClientRect()
  // Курсор в экранных координатах: client + screen offset.
  const sx = e.screenX
  const sy = e.screenY
  const insideX = e.clientX >= r.left - 8 && e.clientX <= r.right + 8
  const insideY = e.clientY >= r.top - 40 && e.clientY <= r.bottom + 40
  if ((!insideX || !insideY) && sx !== 0 && sy !== 0) {
    await window.browserAPI.detachTab(id, { x: sx, y: sy })
  }
}

// --- Слияние окон: прием чужой вкладки из другого окна ---

function dragHasTab(e: DragEvent): boolean {
  const types = Array.from(e.dataTransfer?.types ?? [])
  return types.includes('application/x-konstruktor-tab') || types.includes('text/plain')
}

function onStripDragOver(e: DragEvent) {
  // Свой drag внутри панели обрабатывают onDragOver вкладок.
  if (dragId.value !== null) return
  if (!dragHasTab(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  mergeHover.value = true
}

function onStripDragLeave(e: DragEvent) {
  if (strip.value && e.relatedTarget instanceof Node && strip.value.contains(e.relatedTarget)) return
  mergeHover.value = false
}

async function onStripDrop(e: DragEvent) {
  mergeHover.value = false
  if (dragId.value !== null) return
  e.preventDefault()
  const raw =
    e.dataTransfer?.getData('application/x-konstruktor-tab') ??
    e.dataTransfer?.getData('text/plain') ??
    ''
  const m = raw.match(/(\d+)/)
  if (!m) return
  const id = Number(m[1])
  // Своя вкладка уже здесь — игнорим.
  if (tabs.value.some((t) => t.id === id)) return
  await window.browserAPI.attachTab(id)
}
</script>

<template>
  <div
    ref="strip"
    class="tabstrip"
    :class="{ 'merge-target': mergeHover }"
    @dragover="onStripDragOver($event)"
    @dragleave="onStripDragLeave($event)"
    @drop="onStripDrop($event)"
    @contextmenu.prevent="openStripMenu($event)"
    @wheel.prevent="onWheel($event)"
  >
    <!-- Закрепленные: только иконка сайта, слева -->
    <div
      v-for="t in pinnedTabs"
      :key="t.id"
      class="tab pinned"
      :class="{ active: t.id === activeTabId, dragover: t.id === dragOverId }"
      :title="shortTitle(t)"
      draggable="true"
      @click="activate(t.id)"
      @dblclick="togglePin(t.id, $event)"
      @contextmenu.prevent="openContext(t.id, $event)"
      @dragstart="onDragStart(t.id, $event)"
      @dragover="onDragOver(t.id, $event)"
      @dragleave="onDragLeave"
      @drop="onDrop(t.id, $event)"
      @dragend="onDragEnd($event)"
    >
      <img v-if="t.favicon" class="favicon" :src="t.favicon" alt="" draggable="false" />
      <span v-else class="favicon fallback">◉</span>
    </div>
    <!-- Обычные вкладки -->
    <div
      v-for="t in normalTabs"
      :key="t.id"
      class="tab"
      :class="{ active: t.id === activeTabId, dragover: t.id === dragOverId }"
      draggable="true"
      @click="activate(t.id)"
      @dblclick="togglePin(t.id, $event)"
      @contextmenu.prevent="openContext(t.id, $event)"
      @dragstart="onDragStart(t.id, $event)"
      @dragover="onDragOver(t.id, $event)"
      @dragleave="onDragLeave"
      @drop="onDrop(t.id, $event)"
      @dragend="onDragEnd($event)"
    >
      <img v-if="t.favicon" class="favicon" :src="t.favicon" :title="t.url" alt="" draggable="false" />
      <span v-else class="favicon fallback" :title="t.url">◉</span>
      <span v-if="renamingId !== t.id" class="tab-title">{{ shortTitle(t) }}</span>
      <input
        v-else
        ref="renameInput"
        v-model="renameValue"
        class="tab-rename"
        spellcheck="false"
        @click.stop
        @keydown="onRenameKey"
        @blur="cancelRename"
      />
      <button class="tab-close" @click="close(t.id, $event)">×</button>
    </div>
    <button class="tab-add" title="New tab" @click="add()">+</button>
    <slot />
  </div>
</template>

<style scoped>
.tabstrip {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 6px 8px;
  background: var(--panel-bg);
  /* Переполнение — только колесом: скроллбары скрыты всегда,
     даже при сотне вкладок или экстремально узком окне. */
  overflow-x: auto;
  overflow-y: visible;
  scrollbar-width: none;
  -ms-overflow-style: none;
  user-select: none;
  /* Пустая область панели тащит окно (frameless). Вкладки — нет. */
  -webkit-app-region: drag;
  position: relative;
}
.tabstrip::-webkit-scrollbar { display: none; }
.tab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  background: var(--tab-bg);
  color: var(--text);
  border-radius: 8px;
  cursor: grab;
  max-width: 220px;
  min-width: 40px;
  flex-shrink: 0;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}
.tab:active { cursor: grabbing; }
.tab.active { background: var(--tab-active-bg); }
.tab:not(.active):hover { background: var(--tab-hover-bg); }
.tab.active:hover { background: var(--tab-hover-bg); }
.tab.dragover { outline: 2px solid #fff; outline-offset: -2px; }
/* Зона слияния: окно подсвечивается когда чужую вкладку тащат над панелью. */
.tabstrip.merge-target { outline: 2px dashed #7dd87d; outline-offset: -4px; background: #2a332a; }
.tab.pinned { max-width: 64px; padding: 6px 8px; }
.favicon { width: 16px; height: 16px; flex-shrink: 0; border-radius: 3px; }
.favicon.fallback { font-size: 12px; color: #888; text-align: center; }
.tab-title { overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
/* Инлайн-переименование: поле наследует геометрию заголовка,
   вкладка не меняет размер — текст просто становится редактируемым. */
.tab-rename {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  padding: 0 2px;
  border: 1px solid var(--focus);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--text);
  outline: none;
}
.tab-close {
  background: transparent;
  border: none;
  color: #aaa;
  cursor: pointer;
  font-size: 14px;
}
.tab-close:hover { color: #fff; }
.tab-add {
  background: var(--tab-bg);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}
</style>
