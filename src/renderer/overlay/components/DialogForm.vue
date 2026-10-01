<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

// Каркас диалога с полем ввода и кнопками. Общий для PromptDialog и
// IconDialog: оба — заголовок, одно поле, ряд кнопок.
//
// Почему общий компонент, а не два похожих: у PromptDialog есть Enter и
// Escape на поле, у IconDialog — Enter и отдельный dismiss по backdrop.
// Дублировать каркас означало бы дублировать и клавиатуру, а правки
// в одной копии не доезжали до другой — так уже было с обработчиком
// Escape в IconDialog, который дублировал корневой и давал два dismiss.

const props = withDefaults(
  defineProps<{
    title: string
    placeholder?: string
    initial?: string
    /** Подпись под полем: ошибка верификации, подсказка. */
    error?: string
    /** Кнопки под полем. icon — смайлик перед подписью, title — подсказка. */
    buttons: { id: string; label: string; icon?: string; title?: string; group?: 'sources' }[]
    sessionId?: number
  }>(),
  { placeholder: undefined, initial: undefined, error: undefined, sessionId: undefined }
)

const emit = defineEmits<{
  (e: 'submit', buttonId: string, value: string): void
  (e: 'dismiss'): void
}>()

const value = ref(props.initial ?? '')
const input = ref<HTMLInputElement | null>(null)

// Кнопка по умолчанию: первая не-отменяющая. Отмена всегда последняя
// (её так задаёт main), иначе Enter отправлял бы форму вместо выхода.
const defaultButton = computed(
  () => props.buttons.find((b) => b.id !== '__cancel__')?.id ?? props.buttons[0]?.id
)

// Раскладка на две группы: источники слева, отмена справа. Раньше это
// было двумя блоками в разметке, а перенос в общий каркас сшил кнопки в
// один ряд — смайлики исчезли, и отмена встала вплотную к источникам.
const sourceButtons = computed(() => props.buttons.filter((b) => b.group === 'sources'))
const otherButtons = computed(() => props.buttons.filter((b) => b.group !== 'sources'))

function choose(id: string): void {
  if (id === '__cancel__') {
    emit('dismiss')
    return
  }
  emit('submit', id, value.value)
}

function onKey(e: KeyboardEvent): void {
  // Escape не ловим: окно оверлея слушает его глобально и закрывает
  // сессию. Свой обработчик был лишним — на диалоге он давал два dismiss.
  if (e.key !== 'Enter') return
  e.preventDefault()
  if (defaultButton.value !== undefined) choose(defaultButton.value)
}

function onBackdrop(e: MouseEvent): void {
  // Клик по подложке (прозрачной области вокруг диалога) — отмена.
  // Без проверки target любой клик внутри .dialog-root считался бы
  // отменой, включая клики по самому диалогу.
  if (e.target === e.currentTarget) emit('dismiss')
}

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})
</script>

<template>
  <div class="dialog-root" @mousedown="onBackdrop">
    <div class="dialog" @mousedown.stop>
      <div class="dialog-title">{{ title }}</div>
      <input
        ref="input"
        v-model="value"
        class="dialog-input"
        :placeholder="placeholder ?? ''"
        spellcheck="false"
        @keydown="onKey"
      />      <div v-if="error" class="dialog-error">{{ error }}</div>
      <div class="dialog-actions">
        <!-- Кнопки-источники сгруппированы, отмена стоит отдельно: так
             они стояли до перехода на общий каркас, и развал на две
             группы повторяет исходную раскладку.
             tabindex нужен всем кнопкам подряд: нативный обход по Tab
             идёт по порядку в DOM, а Shift+Tab с последней кнопки
             ушёл бы на поле — и к отмене добраться было нельзя. -->
        <div class="dialog-actions-sources">
          <button
            v-for="b in sourceButtons"
            :key="b.id"
            class="dialog-btn"
            tabindex="0"
            :title="b.title"
            @click="choose(b.id)"
          ><span v-if="b.icon" class="dialog-btn-icon">{{ b.icon }}</span>{{ b.label }}</button>
        </div>
        <button
          v-for="b in otherButtons"
          :key="b.id"
          class="dialog-btn"
          tabindex="0"
          :class="{ 'dialog-btn--default': b.id === defaultButton }"
          @click="choose(b.id)"
        >{{ b.label }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dialog {
  width: 300px;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 16px;
  color: var(--ov-text);
}
.dialog-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.dialog-input {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ov-input-border);
  background: var(--ov-input-bg);
  color: var(--ov-text);
  outline: none;
}
.dialog-error {
  margin-top: 8px;
  font-size: 12px;
  color: #ff8a8a;
  /* Сообщение об ошибке не должно распирать диалог: URL бывает длинным. */
  overflow-wrap: anywhere;
  min-width: 0;
}
.dialog-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
}
.dialog-actions-sources { display: flex; gap: 6px; flex-wrap: wrap; }
.dialog-btn {
  background: var(--ov-btn-bg);
  color: var(--ov-text);
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}
/* Смайлик перед подписью. inline-flex с gap, иначе между смайликом и
   текстом нет зазора, а смайлик в системном шрифте уезжает по базовой
   линии. */
.dialog-btn-icon { margin-right: 4px; }
.dialog-btn:hover { background: var(--ov-btn-hover); }
/* Кнопка по умолчанию визуально выделена: Enter вызывает её, и без
   подсветки пользователь не знает, что произойдёт по Enter. */
.dialog-btn--default { background: var(--ov-btn-hover); }
</style>