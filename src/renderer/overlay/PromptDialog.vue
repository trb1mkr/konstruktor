<script setup lang="ts">
import DialogForm from './components/DialogForm.vue'

// Обёртка над DialogForm. Модальный диалог с полем ввода: значение уходит
// через overlay:submit, кнопки присылает main (например URL / Local file /
// Cancel).
//
// Отдельный компонент нужен только из-за формы submit: DialogForm отдаёт
// пару (buttonId, value), а контракт overlay:submit ждёт строку
// "buttonId::text". Разбор формата — здесь, в одном месте.
const props = defineProps<{
  sessionId?: number
  dialog: {
    title: string
    placeholder?: string
    initial?: string
    buttons: { id: string; label: string }[]
  }
}>()

const emit = defineEmits<{
  (e: 'submit', value: string): void
  (e: 'dismiss'): void
}>()

function onSubmit(buttonId: string, value: string): void {
  emit('submit', buttonId + '::' + value)
}
</script>

<template>
  <DialogForm
    :title="dialog.title"
    :placeholder="dialog.placeholder"
    :initial="dialog.initial"
    :buttons="dialog.buttons"
    :session-id="props.sessionId"
    @submit="onSubmit"
    @dismiss="emit('dismiss')"
  />
</template>
