<script setup lang="ts">
import { ref, computed } from 'vue'
import DialogForm from './components/DialogForm.vue'

// Диалог иконки для вкладок и групп: одно поле ввода + 4 кнопки (URL,
// локальный файл, emoji, отмена). В поле вводится любой из трёх источников,
// main верифицирует тип при нажатии (verifyIconSource).
//
// error приходит из модели (overlay:update). Раньше ошибка верификации
// возвращалась как false из submitIcon и показывалась локально, а ошибка
// конвертации файла — отдельным executeJavaScript, который правил
// .dialog-error по селектору. Два пути для одного значения разошлись, и
// правка второго ничего не говорила о первом.
//
// sessionId — токен сессии для команд. Диалог меняет favicon ЗАМКНАНИЕМ
// конкретной вкладки, поэтому запоздалая команда из устаревшей сессии
// опасна: применила бы иконку к уже другой записи.
const props = defineProps<{
  icon: { title: string; placeholder?: string; initial?: string; error?: string }
  sessionId?: number
}>()

// Локальный текст для отказа верификации: main его не присылает, потому
// что он зависит только от нажатой кнопки. Ошибка конвертации файла
// приходит из модели, и оба текста показываются в одном месте.
const localError = ref('')

const error = computed(() => localError.value || props.icon.error || '')

async function onSubmit(buttonId: string, value: string): Promise<void> {
  localError.value = ''
  const ok = await window.overlayAPI.submitIcon(
    buttonId,
    value,
    props.sessionId
  )
  // false = main отклонил источник: показываем ошибку, диалог жив.
  if (!ok) localError.value = 'Enter a URL, file path or emoji'
}

async function onDismiss(): Promise<void> {
  localError.value = ''
  await window.overlayAPI.dismiss(props.sessionId)
}
</script>

<template>
  <DialogForm
    :title="icon.title"
    :placeholder="icon.placeholder"
    :initial="icon.initial"
    :error="error"
    :buttons="[
      { id: 'url', label: 'URL', icon: '🔗', title: 'Use input as image URL', group: 'sources' },
      { id: 'file', label: 'File', icon: '📁', title: 'Pick local image file', group: 'sources' },
      { id: 'emoji', label: 'Emoji', icon: '😀', title: 'Use input as emoji', group: 'sources' },
      { id: '__cancel__', label: 'Cancel' }
    ]"
    :session-id="props.sessionId"
    @submit="onSubmit"
    @dismiss="onDismiss"
  />
</template>
