<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { tabs, activeTabId, openGroups, stripOrder, pinnedStripOrder } from '../../core/useTabs'
import TabGroupNode from './TabGroupNode.vue'
import { faviconIsEmoji, faviconEmoji, shortTitle } from './tabShared'
import { createStripDrag, stripItemDragOver, gapWidthFor as gapWidth, resetStripDrag } from './useStripDrag'

// Панель вкладок: DnD-перестановка, detach в новое окно, pin, favicon.
// Закрепленные всегда слева, только иконка сайта без лишних меток.
// Единый ряд: вкладки и корневые группы одного ранга — таб и группа
// чередуются свободно по stripOrder/pinnedStripOrder из main.
// Группы: горизонтальный узел (заголовок слева, вкладки справа),
// вложенность через parentInstanceId, сворачивание, pin.
// Правый клик — контекстное меню (оверлей-окно): pin, duplicate,
// rename (инлайн в самой вкладке), set-icon (диалог по центру окна),
// copy URL, reload, close. Клик по заголовку группы — меню группы.
const strip = ref<HTMLElement | null>(null)
// DnD единого ряда вынесен в useStripDrag: липкий токен + зазор.
const stripDrag = createStripDrag()
const dragId = stripDrag.dragId
// Перетаскиваемая корневая группа (единый ряд): instanceId.
const dragGroupId = stripDrag.dragGroupId
const dragOverId = ref<number | null>(null)
// Подсветка дропа группы: токен ряда 't:<id>' или 'g:<instanceId>'.
const dragOverToken = stripDrag.dragOverToken
// Примерная ширина перетаскиваемого элемента: на неё сдвигается цель,
// освобождая место под дроп. Замеряем в dragstart по реальному DOM.
const dragWidth = stripDrag.dragWidth
// true пока чужой drag (из другого окна) висит над панелью — подсветка слияния.
const mergeHover = ref(false)

// Карты для быстрого поиска по токенам ряда.
const tabById = computed(() => new Map(tabs.value.map((t) => [t.id, t])))
const groupByInstance = computed(() => new Map(openGroups.value.map((g) => [g.instanceId, g])))

// Единый ряд закрепленной зоны: только закрепленные группы.
// Minimize вкладок не двигает их: свернутые остаются в общем ряду на месте.
const pinnedStrip = computed<string[]>(() => {
  if (pinnedStripOrder.value.length > 0) return pinnedStripOrder.value.filter((t) => t.startsWith('g:'))
  return openGroups.value.filter((g) => g.pinned && !g.parentInstanceId).map((g) => `g:${g.instanceId}`)
})

// Единый ряд обычной зоны: все вкладки без группы (включая minimize) + обычные группы.
const normalStrip = computed<string[]>(() => {
  if (stripOrder.value.length > 0) return stripOrder.value
  const groups = openGroups.value.filter((g) => !g.pinned && !g.parentInstanceId).map((g) => `g:${g.instanceId}`)
  const tbs = tabs.value.filter((t) => !t.groupId).map((t) => `t:${t.id}`)
  return [...groups, ...tbs]
})

// Заголовок группы: клик — свернуть/развернуть, правый клик — меню группы.
function toggleGroup(instanceId: string) {
  void window.browserAPI.toggleGroupCollapse(instanceId)
}

function openGroupMenu(instanceId: string, e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  window.browserAPI.groupContextMenu(instanceId, {
    x: Math.round(e.clientX),
    y: Math.round(e.clientY)
  })
}

// Дроп вкладки на заголовок группы: положить вкладку в группу.
// Перетаскивание групп (dragGroupId) сюда не относится — им занимается
// единый ряд (onStripItemDrop), поэтому групповой drag игнорим и даем
// событию всплыть до корня узла для reorder.
function onGroupDragOver(e: DragEvent) {
  if (dragGroupId.value !== null) return
  if (dragId.value === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

async function onGroupDrop(instanceId: string, e: DragEvent) {
  if (dragGroupId.value !== null) return
  e.preventDefault()
  e.stopPropagation()
  const from = dragId.value
  resetStripDrag(stripDrag)
  dragOverId.value = null
  // Чужой дроп на заголовок группы: втягиваем и кладем в группу.
  if (from === null) {
    const fid = extractForeignTabId(e)
    mergeHover.value = false
    if (fid === null) return
    await window.browserAPI.attachTab(fid)
    await window.browserAPI.addTabToGroup(fid, instanceId)
    return
  }
  await window.browserAPI.addTabToGroup(from, instanceId)
}

// --- DnD единого ряда: вкладки и группы одного ранга ---

// Старт перетаскивания корневой группы: метка своя, как у вкладок.
function onGroupDragStart(instanceId: string, e: DragEvent) {
  dragGroupId.value = instanceId
  dragId.value = null
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  dragWidth.value = el?.offsetWidth || 160
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-konstruktor-group', instanceId)
    e.dataTransfer.setData('text/plain', `konstruktor-group:${instanceId}`)
  }
}

// Подсветка позиции дропа в едином ряду — в useStripDrag (липкий токен).
// Чужой drag (из другого окна): токена нет, только разрешаем дроп
// и подсвечиваем панель тем же пунктиром, дроп разберут токены/полоса.
function onStripItemDragOver(token: string, e: DragEvent) {
  if (dragId.value === null && dragGroupId.value === null) {
    if (!dragHasTab(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    mergeHover.value = true
    return
  }
  stripItemDragOver(stripDrag, token, e)
}

// Общий коммит перестановки единого ряда: вставить moving ПЕРЕД target.
// Возвращает false если двигать нечего (чуждая зона, тот же индекс).
async function commitStripOrder(target: string, moving: string): Promise<boolean> {
  const pinned = pinnedStrip.value.includes(target)
  const arr = [...(pinned ? pinnedStrip.value : normalStrip.value)]
  if (!arr.includes(moving)) return false
  const fromIdx = arr.indexOf(moving)
  let toIdx = arr.indexOf(target)
  if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return false
  // Движение вперед: после вырезки индексы левеют — целимся перед целью.
  const [item] = arr.splice(fromIdx, 1)
  if (fromIdx < toIdx) toIdx -= 1
  arr.splice(toIdx, 0, item)
  const next = pinned
    ? { pinned: arr, normal: [...normalStrip.value] }
    : { pinned: [...pinnedStrip.value], normal: arr }
  await window.browserAPI.reorderStrip([...next.pinned, ...next.normal])
  return true
}

// Дроп на элемент единого ряда: вставляем перетаскиваемое ПЕРЕД целью.
// Вкладка на вкладку/группу, группа на группу/вкладку — ранг одинаковый.
// Цель берем из липкого токена: после сдвига курсор уже не над целью
// (над зазором/исходником), а событие drop приходит элементу под курсором.
async function onStripItemDrop(token: string, e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  const fromTab = dragId.value
  const fromGroup = dragGroupId.value
  const target = dragOverToken.value ?? token
  resetStripDrag(stripDrag)
  dragOverId.value = null
  // Чужой дроп на элемент ряда: втягиваем вкладку в это окно.
  if (fromTab === null && fromGroup === null) {
    const fid = extractForeignTabId(e)
    mergeHover.value = false
    if (fid === null) return
    await window.browserAPI.attachTab(fid)
    return
  }
  const moving = fromTab !== null ? `t:${fromTab}` : `g:${fromGroup!}`
  await commitStripOrder(target, moving)
}

// Ширина плейсхолдера — в useStripDrag (прозрачный элемент перед целью).
function gapWidthFor(token: string): number {
  return gapWidth(stripDrag, token)
}
function onGroupDragEnd(e: DragEvent) {
  const gid = dragGroupId.value
  resetStripDrag(stripDrag)
  mergeHover.value = false
  if (gid === null || !strip.value) return
  // Группы не detach'атся — просто сбрасываем состояние.
}

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

function onDragStart(id: number, e: DragEvent) {
  dragId.value = id
  dragGroupId.value = null
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  dragWidth.value = el?.offsetWidth || 160
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
  // Зазор НЕ сбрасываем: margin сдвигает цель вправо, курсор оказывается
  // в зазоре -> dragleave -> сброс -> возврат -> dragover -> цикл прыгания.
  // Токен живет до дропа/dragend/ухода с панели, поэтому сдвиг стабилен.
  dragOverId.value = null
}

async function onDrop(id: number, e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  const from = dragId.value
  dragOverId.value = null
  resetStripDrag(stripDrag)
  dragId.value = null
  if (from === id) return
  // Чужой дроп на вкладку: втягиваем вкладку в это окно.
  if (from === null) {
    const fid = extractForeignTabId(e)
    mergeHover.value = false
    if (fid === null) return
    await window.browserAPI.attachTab(fid)
    return
  }
  // Единый ряд: дроп вкладки на вкладку = вставка перед целью.
  // Minimize зону не меняет: все вкладки в обычном ряду, двигаются свободно.
  const arr = [...normalStrip.value]
  const moving = `t:${from}`
  const target = `t:${id}`
  const fromIdx = arr.indexOf(moving)
  const toIdx = arr.indexOf(target)
  if (fromIdx < 0 || toIdx < 0) return
  arr.splice(toIdx, 0, ...arr.splice(fromIdx, 1))
  await window.browserAPI.reorderStrip([...pinnedStrip.value, ...arr])
}

// Вынос за окно: если pointerup случился вне панели — detach в новое окно.
// Отслеживаем через dragend + координаты курсора относительно панели.
async function onDragEnd(e: DragEvent) {
  const id = dragId.value
  resetStripDrag(stripDrag)
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

// Id чужой вкладки из dataTransfer. null = свой таб уже здесь или не таб.
function extractForeignTabId(e: DragEvent): number | null {
  const raw =
    e.dataTransfer?.getData('application/x-konstruktor-tab') ??
    e.dataTransfer?.getData('text/plain') ??
    ''
  const m = raw.match(/(\d+)/)
  if (!m) return null
  const id = Number(m[1])
  if (tabs.value.some((t) => t.id === id)) return null
  return id
}

function onStripDragOver(e: DragEvent) {
  // Свой drag над зазором между элементами (после сдвига цели курсор
  // уже не над целью): разрешаем дроп, иначе браузер его заблокирует.
  // Подсветку слияния при этом не включаем — это не чужое окно.
  if (dragId.value !== null || dragGroupId.value !== null) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    return
  }
  if (!dragHasTab(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  mergeHover.value = true
}

function onStripDragLeave(e: DragEvent) {
  if (strip.value && e.relatedTarget instanceof Node && strip.value.contains(e.relatedTarget)) return
  mergeHover.value = false
  // Ушли с панели целиком — зазор больше не нужен.
  dragOverToken.value = null
}

async function onStripDrop(e: DragEvent) {
  mergeHover.value = false
  // Свой drag, отпущенный в зазоре между элементами (мимо всех токенов):
  // дроп идет по липкому токену — иначе перестановка терялась бы.
  if (dragId.value !== null || dragGroupId.value !== null) {
    e.preventDefault()
    const target = dragOverToken.value
    const moving =
      dragId.value !== null ? `t:${dragId.value}` : `g:${dragGroupId.value!}`
    resetStripDrag(stripDrag)
    dragOverId.value = null
    if (target) await commitStripOrder(target, moving)
    return
  }
  // Чужой дроп на пустое место полосы: втягиваем вкладку в это окно.
  e.preventDefault()
  const fid = extractForeignTabId(e)
  if (fid === null) return
  await window.browserAPI.attachTab(fid)
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
    <!-- Единый ряд закрепленной зоны: вкладки и группы одного ранга.
         Токен 't:<id>' — вкладка-иконка, 'g:<instanceId>' — узел группы. -->
    <template v-for="token in pinnedStrip" :key="token">
      <!-- Плейсхолдер зазора: прозрачный элемент перед целью дропа.
           Держит место в layout — цель не возвращается назад, пока
           курсор над зазором. Dragover/drop на нём = тот же токен. -->
      <div
        v-if="gapWidthFor(token) > 0"
        class="drop-gap"
        :style="{ width: gapWidthFor(token) + 'px' }"
        @dragover="onStripItemDragOver(token, $event)"
        @drop="onStripItemDrop(token, $event)"
      />
      <TabGroupNode
        v-if="token.startsWith('g:') && groupByInstance.has(token.slice(2))"
        :instance-id="token.slice(2)"
        :depth="0"
        :drag-over-id="dragOverId"
        :renaming-id="renamingId"
        :rename-value="renameValue"
        :class="{ 'strip-dragover': dragOverToken === token }"
        draggable="true"
        @activate="activate($event)"
        @close="close($event.id, $event.ev)"
        @toggle-pin="togglePin($event.id, $event.ev)"
        @open-context="openContext($event.id, $event.ev)"
        @open-group-menu="openGroupMenu($event.instanceId, $event.ev)"
        @toggle-group="toggleGroup($event)"
        @drag-start="onDragStart($event.id, $event.ev)"
        @drag-over="onDragOver($event.id, $event.ev)"
        @drag-leave="onDragLeave()"
        @drop="onDrop($event.id, $event.ev)"
        @drag-end="onDragEnd($event)"
        @group-drag-over="onGroupDragOver($event)"
        @group-drop="onGroupDrop($event.instanceId, $event.ev)"
        @group-drag-start="onGroupDragStart($event.instanceId, $event.ev)"
        @group-drag-end="onGroupDragEnd($event)"
        @strip-item-drag-over="onStripItemDragOver(token, $event)"
        @strip-item-drop="onStripItemDrop(token, $event)"
        @rename-key="onRenameKey($event)"
        @rename-input="renameValue = $event"
        @cancel-rename="cancelRename()"
        @register-input="renameInput = $event"
      />
      <div
        v-else-if="token.startsWith('t:') && tabById.has(Number(token.slice(2)))"
        class="tab"
        :class="{ active: Number(token.slice(2)) === activeTabId, dragover: Number(token.slice(2)) === dragOverId, 'strip-dragover': dragOverToken === token, minimized: tabById.get(Number(token.slice(2)))!.pinned }"
        :title="shortTitle(tabById.get(Number(token.slice(2)))!)"
        draggable="true"
        @click="activate(Number(token.slice(2)))"
        @dblclick="togglePin(Number(token.slice(2)), $event)"
        @contextmenu.prevent="openContext(Number(token.slice(2)), $event)"
        @dragstart="onDragStart(Number(token.slice(2)), $event)"
        @dragover="onStripItemDragOver(token, $event)"
        @dragleave="onDragLeave"
        @drop="onStripItemDrop(token, $event)"
        @dragend="onDragEnd($event)"
      >
        <img v-if="tabById.get(Number(token.slice(2)))!.favicon && !faviconIsEmoji(tabById.get(Number(token.slice(2)))!.favicon)" class="favicon" :src="tabById.get(Number(token.slice(2)))!.favicon" alt="" draggable="false" />
        <span v-else-if="faviconIsEmoji(tabById.get(Number(token.slice(2)))!.favicon)" class="favicon fallback">{{ faviconEmoji(tabById.get(Number(token.slice(2)))!.favicon) }}</span>
        <span v-else class="favicon fallback">◉</span>
        <!-- Minimize: только иконка, вкладка остается на своём месте. -->
        <template v-if="!tabById.get(Number(token.slice(2)))!.pinned">
          <span v-if="renamingId !== Number(token.slice(2))" class="tab-title">{{ shortTitle(tabById.get(Number(token.slice(2)))!) }}</span>
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
          <button class="tab-close" @click="close(Number(token.slice(2)), $event)">×</button>
        </template>
      </div>
    </template>
    <!-- Единый ряд обычной зоны: вкладка, потом группа — любой порядок. -->
    <template v-for="token in normalStrip" :key="token">
      <div
        v-if="gapWidthFor(token) > 0"
        class="drop-gap"
        :style="{ width: gapWidthFor(token) + 'px' }"
        @dragover="onStripItemDragOver(token, $event)"
        @drop="onStripItemDrop(token, $event)"
      />
      <TabGroupNode
        v-if="token.startsWith('g:') && groupByInstance.has(token.slice(2))"
        :instance-id="token.slice(2)"
        :depth="0"
        :drag-over-id="dragOverId"
        :renaming-id="renamingId"
        :rename-value="renameValue"
        :class="{ 'strip-dragover': dragOverToken === token }"
        draggable="true"
        @activate="activate($event)"
        @close="close($event.id, $event.ev)"
        @toggle-pin="togglePin($event.id, $event.ev)"
        @open-context="openContext($event.id, $event.ev)"
        @open-group-menu="openGroupMenu($event.instanceId, $event.ev)"
        @toggle-group="toggleGroup($event)"
        @drag-start="onDragStart($event.id, $event.ev)"
        @drag-over="onDragOver($event.id, $event.ev)"
        @drag-leave="onDragLeave()"
        @drop="onDrop($event.id, $event.ev)"
        @drag-end="onDragEnd($event)"
        @group-drag-over="onGroupDragOver($event)"
        @group-drop="onGroupDrop($event.instanceId, $event.ev)"
        @group-drag-start="onGroupDragStart($event.instanceId, $event.ev)"
        @group-drag-end="onGroupDragEnd($event)"
        @strip-item-drag-over="onStripItemDragOver(token, $event)"
        @strip-item-drop="onStripItemDrop(token, $event)"
        @rename-key="onRenameKey($event)"
        @rename-input="renameValue = $event"
        @cancel-rename="cancelRename()"
        @register-input="renameInput = $event"
      />
      <div
        v-else-if="token.startsWith('t:') && tabById.has(Number(token.slice(2)))"
        class="tab"
        :class="{ active: Number(token.slice(2)) === activeTabId, dragover: Number(token.slice(2)) === dragOverId, 'strip-dragover': dragOverToken === token, minimized: tabById.get(Number(token.slice(2)))!.pinned }"
        draggable="true"
        @click="activate(Number(token.slice(2)))"
        @dblclick="togglePin(Number(token.slice(2)), $event)"
        @contextmenu.prevent="openContext(Number(token.slice(2)), $event)"
        @dragstart="onDragStart(Number(token.slice(2)), $event)"
        @dragover="onStripItemDragOver(token, $event)"
        @dragleave="onDragLeave"
        @drop="onStripItemDrop(token, $event)"
        @dragend="onDragEnd($event)"
      >
        <img v-if="tabById.get(Number(token.slice(2)))!.favicon && !faviconIsEmoji(tabById.get(Number(token.slice(2)))!.favicon)" class="favicon" :src="tabById.get(Number(token.slice(2)))!.favicon" :title="tabById.get(Number(token.slice(2)))!.url" alt="" draggable="false" />
        <span v-else-if="faviconIsEmoji(tabById.get(Number(token.slice(2)))!.favicon)" class="favicon fallback" :title="tabById.get(Number(token.slice(2)))!.url">{{ faviconEmoji(tabById.get(Number(token.slice(2)))!.favicon) }}</span>
        <span v-else class="favicon fallback" :title="tabById.get(Number(token.slice(2)))!.url">◉</span>
        <!-- Minimize: только иконка, вкладка остается на своём месте. -->
        <template v-if="!tabById.get(Number(token.slice(2)))!.pinned">
          <span v-if="renamingId !== Number(token.slice(2))" class="tab-title">{{ shortTitle(tabById.get(Number(token.slice(2)))!) }}</span>
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
          <button class="tab-close" @click="close(Number(token.slice(2)), $event)">×</button>
        </template>
      </div>
    </template>
    <button class="tab-add" title="New tab" @click="add()">+</button>
    <!-- Заполнитель от кнопки + до кнопок окна: правый клик открывает
         меню панели. no-drag обязателен: на drag-области Windows отдает
         правый клик системному меню окна и renderer его не получает
         (поэтому меню открывалось только на кнопке +). -->
    <div class="strip-filler" @contextmenu.prevent="openStripMenu($event)" />
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
/* Подсветка позиции дропа в едином ряду: перетаскиваемое встанет перед этим элементом. */
.strip-dragover { outline: none; }
/* Плейсхолдер зазора: прозрачный элемент перед целью, держит место.
   Курсор над зазором попадает в него, а не в соседа — цель не прыгает. */
.drop-gap {
  flex: 0 0 auto;
  align-self: stretch;
  border-radius: 8px;
  background: transparent;
  border: 1px dashed var(--text-faint);
  opacity: 0.55;
  -webkit-app-region: no-drag;
  animation: gap-grow 120ms ease;
}
@keyframes gap-grow {
  from { opacity: 0; }
}
/* Зона слияния: тот же пунктир, что у зазора внутри окна (.drop-gap). */
.tabstrip.merge-target { outline: 1px dashed var(--text-faint); outline-offset: -4px; background: transparent; }
/* Minimize: вкладка схлопывается до иконки, но остается на своём месте. */
.tab.minimized { max-width: 64px; padding: 6px 8px; }
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
/* Заполнитель пустого места панели до кнопок окна: правый клик открывает
   меню панели. no-drag обязателен: на drag-области Windows отдает
   правый клик системному меню окна и renderer его не получает.
   Тащить окно можно за пустое пространство табстрипа (слева от filler)
   или за заголовок окна (titlebar). */
.strip-filler {
  flex: 1;
  align-self: stretch;
  min-width: 12px;
  -webkit-app-region: no-drag;
}
</style>
