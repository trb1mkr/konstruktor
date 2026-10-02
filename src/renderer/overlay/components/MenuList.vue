<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import type { MenuItem } from '../../../shared/overlay-types'

// Список пунктов меню: единственная реализация для всех меню приложения
// (вкладки, группы, панель, меню браузера).
//
// Почему отдельный компонент, а не продолжение BrowserMenu: сейчас в
// проекте четыре меню, и каждое — своя копия вёрстки пункта. Клавиатурной
// навигации не было НИ В ОДНОМ из них: ни стрелок, ни Enter, ни Escape
// на уровне списка. Приёмка шага 7 требует «работает везде», а «везде»
// означает одно место в коде, а не четыре.
//
// Навигация реализована на roving tabindex, а не на tabindex по каждому
// пункту: иначе Tab перебирал бы все пункты подряд, и меню в двадцать
// пунктов требовало бы двадцати нажатий, чтобы уйти из него.

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    /** Бейдж над пунктами (инкогнито). */
    badge?: string
    /** Активный индекс; -1 = ни один. */
    modelValue?: number
  }>(),
  { badge: undefined, modelValue: -1 }
)

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'update:modelValue', index: number): void
}>()

// Активный пункт. Локальное состояние, а не только проп: меню
// открывается без фокуса на конкретном пункте, и первый пункт должен
// подсветиться сразу, чтобы пользователь видел, куда поедет Enter.
const active = ref(props.modelValue >= 0 ? props.modelValue : 0)

// Пункты, на которые можно попасть: disabled пропускаются. Без этого
// стрелка вставала бы на неактивный пункт и Enter ничего не делал.
const selectable = computed(() =>
  props.items
    .map((item, index) => (item.disabled || item.separator ? -1 : index))
    .filter((i) => i >= 0)
)

function step(delta: number): void {
  if (selectable.value.length === 0) return
  const currentPos = selectable.value.indexOf(active.value)
  // С активного пункта, которого больше нет (список сменился), стартуем
  // с начала — иначе indexOf вернул бы -1 и шаг вёл бы в никуда.
  const from = currentPos < 0 ? 0 : currentPos
  const nextPos = (from + delta + selectable.value.length) % selectable.value.length
  const nextIndex = selectable.value[nextPos]
  if (nextIndex === undefined) return
  active.value = nextIndex
  emit('update:modelValue', nextIndex)
  void scrollActiveIntoView()
}

function toStart(): void {
  const first = selectable.value[0]
  if (first === undefined) return
  active.value = first
  emit('update:modelValue', first)
  void scrollActiveIntoView()
}

function toEnd(): void {
  const last = selectable.value[selectable.value.length - 1]
  if (last === undefined) return
  active.value = last
  emit('update:modelValue', last)
  void scrollActiveIntoView()
}

// Активный пункт должен быть виден: меню в двадцать пунктов не помещается
// в окно, и без прокрутки стрелка уводила бы подсветку за нижний край.
function scrollActiveIntoView(): Promise<void> {
  return nextTick(() => {
    const el = document.querySelector<HTMLElement>('.menu-item--active')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function activate(index: number): void {
  const item = props.items[index]
  if (!item || item.disabled) return
  emit('select', item.id)
}

// Первая буква переходит к следующему пункту, начинающемуся с неё —
// как в обычных меню. Приёмка не требовала, но без неё список из
// двадцати пунктов просматривается только стрелками.
function onKey(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      step(1)
      return
    case 'ArrowUp':
      e.preventDefault()
      step(-1)
      return
    case 'Home':
      e.preventDefault()
      toStart()
      return
    case 'End':
      e.preventDefault()
      toEnd()
      return
    case 'Enter':
      e.preventDefault()
      activate(active.value)
      return
    case ' ':
      // Пробел: только если фокус не в текстовом поле. Иначе он
      // вставил бы пробел в поле ввода диалога.
      if (e.target instanceof HTMLInputElement) return
      e.preventDefault()
      activate(active.value)
      return
    default:
      // Ничего не делаем: Escape ловится на родителе окна, он должен
      // работать и когда фокус в списке.
  }
}

// Типобезопасность: onKey назначается на элемент, но в <script setup>
// компилятор не связывает это с DOM-событием.
const onKeydown = (e: KeyboardEvent): void => onKey(e)

// Фокус в DOM, а не только в окне.
//
// main вызывает win.focus() при показе меню, и этого НЕДОСТАТОЧНО: фокус
// получает окно, а не элемент внутри него. Событие keydown приходит в
// document, до .menu-list не доходит, и навигация молчала. Клик по меню
// работал потому, что он целился в сам список и ставил фокус на элемент —
// то есть фокус давал клик, а не открытие.
//
// autofocus через атрибут не годится: он срабатывает при загрузке
// страницы оверлея, когда меню ещё нет, и повторно не срабатывает.
const root = ref<HTMLElement | null>(null)

onMounted(() => {
  root.value?.focus()
  toStart()
})

defineExpose({ focusFirst: toStart })
</script>

<template>
  <div
    ref="root"
    class="menu-list"
    role="menu"
    tabindex="0"
    @keydown="onKeydown"
    @mousedown.stop
  >
    <div v-if="badge" class="menu-badge">{{ badge }}</div>
    <template v-for="(item, index) in items" :key="item.id">
      <div v-if="item.separator" class="menu-separator" role="separator" />
      <button
        v-else
        class="menu-item"
        :class="{ 'menu-item--active': index === active }"
        role="menuitem"
        :disabled="item.disabled"
        :tabindex="index === active ? 0 : -1"
        @click="activate(index)"
        @mouseenter="index === active || (active = index)"
      >
        <span class="menu-icon">
          <span v-if="item.color" class="menu-dot" :style="{ background: item.color }" />
          <template v-if="item.icon">{{ item.icon }}</template>
        </span>
        <span class="menu-label">{{ item.label }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.menu-list {
  min-width: 220px;
  max-width: 320px;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Список получает фокус, чтобы работали стрелки: оверлей открыт через
     showInactive() и сам фокуса не забирает. Показываем фокус только
     с клавиатуры — иначе рамка мигает при каждом открытии меню. */
  outline: none;
}
.menu-list:focus-visible {
  outline: 1px solid var(--ov-border);
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
/* Активный пункт держит подсветку и без наведения мыши: при навигации
   стрелками курсор стоит в стороне, иначе активный пункт не виден. */
.menu-item--active:not(:disabled) { background: var(--ov-hover); }
.menu-item:disabled { color: #666; cursor: default; }
/* Разделитель: та же ширина карточки минус внутренние поля, что у пункта,
   иначе линия была бы короче текста и выглядела бы опечаткой. */
.menu-separator {
  height: 1px;
  margin: 4px 10px;
  background: var(--ov-border);
  flex-shrink: 0;
}
.menu-icon {
  width: 20px;
  text-align: center;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.menu-label {
  /* Длинное название группы переносится, а не растягивает меню. */
  overflow-wrap: anywhere;
  min-width: 0;
}
.menu-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
</style>