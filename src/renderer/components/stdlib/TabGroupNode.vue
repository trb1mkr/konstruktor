<script setup lang="ts">
import { computed, ref } from 'vue'
import { tabs, activeTabId, openGroups, savedGroups } from '../../core/useTabs'
import { faviconIsEmoji, faviconEmoji, shortTitle, iconIsUrl, groupIconText, wheelDelta } from './tabShared'

// Рекурсивный узел группы: заголовок слева, содержимое справа в одну линию.
// Вложенные группы рисуются тем же компонентом через <TabGroupNode>.
// Вкладки и DnD-хуки приходят пропсами от TabStrip, чтобы не дублировать логику.
const props = defineProps<{
  instanceId: string
  depth: number
  dragOverId: number | null
  renamingId: number | null
  renameValue: string
}>()

const emit = defineEmits<{
  (e: 'activate', id: number): void
  (e: 'close', payload: { id: number; ev: Event }): void
  (e: 'toggle-pin', payload: { id: number; ev: Event }): void
  (e: 'open-context', payload: { id: number; ev: MouseEvent }): void
  (e: 'open-group-menu', payload: { instanceId: string; ev: MouseEvent }): void
  (e: 'toggle-group', instanceId: string): void
  (e: 'drag-start', payload: { id: number; ev: DragEvent }): void
  (e: 'drag-over', payload: { id: number; ev: DragEvent }): void
  (e: 'drag-leave'): void
  (e: 'drop', payload: { id: number; ev: DragEvent }): void
  (e: 'drag-end', ev: DragEvent): void
  (e: 'group-drag-over', ev: DragEvent): void
  (e: 'group-drop', payload: { instanceId: string; ev: DragEvent }): void
  // DnD единого ряда: перетаскивание самого узла группы по панели.
  (e: 'group-drag-start', payload: { instanceId: string; ev: DragEvent }): void
  (e: 'group-drag-end', ev: DragEvent): void
  (e: 'strip-item-drag-over', ev: DragEvent): void
  (e: 'strip-item-drop', ev: DragEvent): void
  (e: 'rename-key', ev: KeyboardEvent): void
  (e: 'rename-input', value: string): void
  (e: 'cancel-rename'): void
  (e: 'register-input', el: HTMLInputElement | null): void
}>()

const inst = computed(() => openGroups.value.find((g) => g.instanceId === props.instanceId))
const saved = computed(() => {
  const s = inst.value?.savedId
  return s ? savedGroups.value.find((g) => g.id === s) : undefined
})
const color = computed(() => saved.value?.color ?? '#888888')
const ownTabs = computed(() => tabs.value.filter((t) => t.groupId === props.instanceId))
// Дети по открытым экземплярам: parentInstanceId указывает на этот узел.
const childGroups = computed(() =>
  openGroups.value.filter((g) => g.parentInstanceId === props.instanceId)
)

// Колесо над телом группы: листает вкладки группы горизонтально,
// не трогая скролл всей панели. Скроллбара нет, листание — только так.
const body = ref<HTMLElement | null>(null)

function onBodyWheel(e: WheelEvent) {
  const el = body.value
  if (!el) return
  const dx = wheelDelta(e)
  if (dx === 0) return
  // Листаем только если внутри есть куда: иначе отдаем панели.
  const can = el.scrollWidth > el.clientWidth + 1
  if (!can) return
  const atStart = el.scrollLeft <= 0 && dx < 0
  const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && dx > 0
  if (atStart || atEnd) return
  e.preventDefault()
  e.stopPropagation()
  el.scrollLeft += dx
}
</script>

<template>
  <div
    v-if="inst"
    class="tabgroup"
    :class="{ collapsed: inst.collapsed }"
    :style="{ '--group-color': color, '--group-depth': depth }"
    draggable="true"
    @dragstart.stop="emit('group-drag-start', { instanceId, ev: $event })"
    @dragover="emit('strip-item-drag-over', $event)"
    @drop="emit('strip-item-drop', $event)"
    @dragend.stop="emit('group-drag-end', $event)"
    @contextmenu.prevent="emit('open-group-menu', { instanceId, ev: $event })"
  >
    <div
      class="tabgroup-head"
      :title="saved?.name ?? 'Group'"
      @click="emit('toggle-group', instanceId)"
      @contextmenu.prevent="emit('open-group-menu', { instanceId, ev: $event })"
      @dragover="emit('group-drag-over', $event)"
      @drop="emit('group-drop', { instanceId, ev: $event })"
    >
      <img v-if="iconIsUrl(saved?.icon)" class="tabgroup-icon" :src="saved?.icon" alt="" draggable="false" />
      <span v-else class="tabgroup-icon fallback">{{ groupIconText(saved?.icon) }}</span>
      <span class="tabgroup-name">{{ saved?.name ?? 'Group' }}</span>
      <span class="tabgroup-count">{{ ownTabs.length }}</span>
    </div>
    <!-- Тело развёрнутой группы: пустое место под вкладками. ПКМ здесь
         открывает меню группы, а не панели. -->
    <div
      v-if="!inst.collapsed"
      ref="body"
      class="tabgroup-body"
      @wheel="onBodyWheel($event)"
      @contextmenu.prevent="emit('open-group-menu', { instanceId, ev: $event })"
    >
      <div
        v-for="t in ownTabs"
        :key="t.id"
        class="tab"
        :class="{ active: t.id === activeTabId, dragover: t.id === dragOverId, minimized: t.pinned }"
        draggable="true"
        @click="emit('activate', t.id)"
        @dblclick="emit('toggle-pin', { id: t.id, ev: $event })"
        @contextmenu.prevent="emit('open-context', { id: t.id, ev: $event })"
        @dragstart.stop="emit('drag-start', { id: t.id, ev: $event })"
        @dragover="emit('drag-over', { id: t.id, ev: $event })"
        @dragleave="emit('drag-leave')"
        @drop="emit('drop', { id: t.id, ev: $event })"
        @dragend.stop="emit('drag-end', $event)"
      >
        <img v-if="t.favicon && !faviconIsEmoji(t.favicon)" class="favicon" :src="t.favicon" :title="t.url" alt="" draggable="false" />
        <span v-else-if="faviconIsEmoji(t.favicon)" class="favicon fallback" :title="t.url">{{ faviconEmoji(t.favicon) }}</span>
        <span v-else class="favicon fallback" :title="t.url">◉</span>
        <!-- Minimize: только иконка, место в группе сохраняется. -->
        <template v-if="!t.pinned">
          <span v-if="renamingId !== t.id" class="tab-title">{{ shortTitle(t) }}</span>
          <input
            v-else
            :ref="(el) => emit('register-input', el as HTMLInputElement | null)"
            :value="renameValue"
            class="tab-rename"
            spellcheck="false"
            @click.stop
            @input="emit('rename-input', ($event.target as HTMLInputElement).value)"
            @keydown="emit('rename-key', $event)"
            @blur="emit('cancel-rename')"
          />
          <button class="tab-close" @click="emit('close', { id: t.id, ev: $event })">×</button>
        </template>
      </div>
      <TabGroupNode
        v-for="child in childGroups"
        :key="child.instanceId"
        :instance-id="child.instanceId"
        :depth="depth + 1"
        :drag-over-id="dragOverId"
        :renaming-id="renamingId"
        :rename-value="renameValue"
        @activate="emit('activate', $event)"
        @close="emit('close', $event)"
        @toggle-pin="emit('toggle-pin', $event)"
        @open-context="emit('open-context', $event)"
        @open-group-menu="emit('open-group-menu', $event)"
        @toggle-group="emit('toggle-group', $event)"
        @drag-start="emit('drag-start', $event)"
        @drag-over="emit('drag-over', $event)"
        @drag-leave="emit('drag-leave')"
        @drop="emit('drop', $event)"
        @drag-end="emit('drag-end', $event)"
        @group-drag-over="emit('group-drag-over', $event)"
        @group-drop="emit('group-drop', $event)"
        @group-drag-start="emit('group-drag-start', $event)"
        @group-drag-end="emit('group-drag-end', $event)"
        @strip-item-drag-over="emit('strip-item-drag-over', $event)"
        @strip-item-drop="emit('strip-item-drop', $event)"
        @rename-key="emit('rename-key', $event)"
        @rename-input="emit('rename-input', $event)"
        @cancel-rename="emit('cancel-rename')"
        @register-input="emit('register-input', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
/* Горизонтальная группа: заголовок слева, вкладки и дети справа в линию.
   Высота узла как у обычной вкладки: внешних вертикальных отступов нет,
   высоту задают сами .tab и .tabgroup-head (одинаковый padding).
   Ширина — по содержимому (последнему элементу), до max-width: 100%;
   дальше тело листается колесом, скроллбар скрыт. */
.tabgroup {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  /* Раскрытая: справа 6px, чтобы последняя вкладка не липла к краю.
     Свернутая (ниже): паддинга нет — край определяет бейдж, hover
     равномерный без светлой кромки справа (см. скриншот). */
  padding: 0 6px 0 0;
  background: color-mix(in srgb, var(--group-color, #888888) 14%, var(--panel-bg));
  /* Обводка НЕ через border: border растит высоту узла на 2px, и каждая
     вложенная группа сдвигала адресную строку вниз. Inset-тень рисует
     ту же рамку, но не влияет на layout — вложенные группы перекрывают
     её визуально, высота панели не меняется. */
  border: none;
  border-left: 3px solid var(--group-color, #888888);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--group-color, #888888) 45%, transparent);
  border-radius: 8px;
  flex-grow: 0;
  flex-shrink: 0;
  flex-basis: auto;
  width: auto;
  max-width: 100%;
  min-width: 0;
  -webkit-app-region: no-drag;
}
.tabgroup-head {
  display: flex;
  gap: 6px;
  align-items: center;
  align-self: stretch;
  /* Слева 4px вместо 8px: каретки ▸/▾ больше нет, иконка и название
     сдвигаются влево на освободившееся место. */
  padding: 6px 8px 6px 4px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
}
/* Свернутая группа — один только заголовок: паддинга у контейнера нет,
   край определяет бейдж, hover красит весь узел целиком через контейнер,
   чтобы справа не оставалось светлой кромки фона 14% (см. скриншот).
   Сам head при этом прозрачный. Правая/верхняя/нижняя faint-обводка
   (inset-тень 45%) убрана — остается только насыщенная полоса слева,
   иначе справа видна менее закрашенная кромка и hover ложится неровно. */
.tabgroup.collapsed { gap: 0; padding: 0; box-shadow: none; }
.tabgroup.collapsed .tabgroup-head { flex: 1; border-radius: 5px 8px 8px 5px; }
.tabgroup.collapsed:has(> .tabgroup-head:hover) {
  background: color-mix(in srgb, var(--group-color, #888888) 32%, var(--panel-bg));
}
.tabgroup.collapsed .tabgroup-head:hover { background: transparent; }
/* Развернутая: подсвечивается только сам заголовок. */
.tabgroup:not(.collapsed) .tabgroup-head:hover {
  background: color-mix(in srgb, var(--group-color, #888888) 32%, var(--tab-hover-bg));
}
.tabgroup-icon { width: 16px; height: 16px; border-radius: 3px; flex-shrink: 0; }
.tabgroup-icon.fallback { font-size: 12px; }
.tabgroup-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}
.tabgroup-count {
  font-size: 11px;
  font-weight: 700;
  /* Прозрачный фон: бейдж не оставляет серый прямоугольник,
     заголовок при hover красится равномерно. Цвет — цвет группы. */
  color: var(--group-color, #888888);
  background: transparent;
  padding: 0 2px;
}
/* Тело группы: та же строка, что и панель — вкладки выглядят
   как обычные .tab, но подкрашены цветом группы.
   Переполнение — только колесом внутрь: узел не сжимается (shrink: 0),
   поэтому при заполненной панели группа сохраняет размер, а лишнее
   уезжает в скролл панели, а не режет саму группу. */
.tabgroup-body {
  display: flex;
  gap: 4px;
  align-items: center;
  overflow-x: auto;
  overflow-y: visible;
  scrollbar-width: none;
  -ms-overflow-style: none;
  min-width: 0;
  flex: 0 0 auto;
  max-width: 60vw;
}
.tabgroup-body::-webkit-scrollbar { display: none; }
/* Копия .tab из TabStrip: scoped-стили TabStrip сюда не пробиваются,
   поэтому дублируем один в один + подкраска цветом группы. */
.tab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--group-color, #888888) 22%, var(--tab-bg));
  /* Та же причина, что у .tabgroup: рамка через inset-тень,
     чтобы высота вкладки не росла и не сдвигала адресную строку. */
  border: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--group-color, #888888) 40%, transparent);
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
.tab.active {
  background: color-mix(in srgb, var(--group-color, #888888) 30%, var(--tab-active-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--group-color, #888888) 65%, transparent);
}
.tab:not(.active):hover { background: color-mix(in srgb, var(--group-color, #888888) 32%, var(--tab-hover-bg)); }
.tab.active:hover { background: color-mix(in srgb, var(--group-color, #888888) 38%, var(--tab-hover-bg)); }
.tab.dragover { outline: 2px solid #fff; outline-offset: -2px; }
/* Minimize: только иконка, место в группе сохраняется. */
.tab.minimized { max-width: 64px; padding: 6px 8px; }
.favicon { width: 16px; height: 16px; flex-shrink: 0; border-radius: 3px; }
.favicon.fallback { font-size: 12px; color: #888; text-align: center; }
.tab-title { overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
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
</style>
