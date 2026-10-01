<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'

// Общий диалог иконки для вкладок и групп: одно поле ввода + 4 кнопки
// (URL, локальный файл, emoji, отмена). В поле вводится любой из трех
// источников, main верифицирует тип при нажатии (verifyIconSource).
// Ошибка верификации возвращается через icon-error и поле не закрывается.
// error приходит из модели (overlay:update). Раньше ошибка верификации
// возвращалась как false из submitIcon и показывалась локально, а ошибка
// конвертации файла — отдельным executeJavaScript, который правил
// .dialog-error по селектору. Два пути для одного значения разошлись, и
// правка второго ничего не говорила о первом.
// sessionId — токен сессии для команд. Диалог иконки меняет favicon
// ЗАМКНАНИЕМ конкретной вкладки, поэтому запоздалая команда из
// устаревшей сессии опасна: применила бы иконку к уже другой записи.
const props = defineProps<{
  icon: { title: string; placeholder?: string; initial?: string; error?: string }
  sessionId?: number
}>()

const value = ref(props.icon.initial ?? '')
// Локальный текст для отказа верификации: main его не присылает, потому что
// он зависит только от нажатой кнопки. Ошибка конвертации файла приходит
// из модели, и оба текста показываются в одном месте.
const localError = ref('')
// Ключ, по которому сбрасываем локальный текст: тот же sessionId, что и
// у overlay:update. Новый вызов submitIcon с тем же текстом ошибки обязан
// показать его снова, поэтому сброс идёт по смене значения, а не по факту
// нажатия.
const error = computed(() => localError.value || props.icon.error || '')
const input = ref<HTMLInputElement | null>(null)

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})

async function choose(id: string) {
  // Отмена — просто закрыть без submit.
  if (id === '__cancel__') {
    await window.overlayAPI.dismiss(props.sessionId)
    return
  }
  localError.value = ''
  const ok = await window.overlayAPI.submitIcon(id, value.value, props.sessionId)
  // false = main отклонил источник: показываем ошибку, диалог жив.
  if (!ok) localError.value = 'Enter a URL, file path or emoji'
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') void choose('url')
  // Окно оверлея глобально слушает Escape и вызывает dismiss. Свой
  // обработчик здесь НЕ нужен и был лишним: на диалоге он срабатывал
  // дублирующим dismiss вместе с корневым слушателем.
}

function onBackdrop(e: MouseEvent) {
  // Клик по подложке (прозрачной области вокруг диалога) — отмена.
  // Без проверки target любой клик внутри .dialog-root считался бы
  // отменой, включая клики по самому диалогу.
  if (e.target === e.currentTarget) void window.overlayAPI.dismiss(props.sessionId)
}
</script>

<template>
  <div class="dialog-root" @mousedown="onBackdrop">
    <div class="dialog" @mousedown.stop>
      <div class="dialog-title">{{ icon.title }}</div>
      <input
        ref="input"
        v-model="value"
        class="dialog-input"
        :placeholder="icon.placeholder ?? 'URL, file path or emoji'"
        spellcheck="false"
        @keydown="onKey"
      />
      <div v-if="error" class="dialog-error">{{ error }}</div>
      <div class="dialog-actions">
        <div class="dialog-actions-sources">
          <button class="dialog-btn" title="Use input as image URL" @click="choose('url')">🔗 URL</button>
          <button class="dialog-btn" title="Pick local image file" @click="choose('file')">📁 File</button>
          <button class="dialog-btn" title="Use input as emoji" @click="choose('emoji')">😀 Emoji</button>
        </div>
        <!-- Отмена — та же кнопка, что и источники: тот же фон, тот же
             размер, тот же шрифт. Отдельного приглушённого варианта
             больше нет — он выглядел как отдельный элемент управления,
             а не как кнопка этого диалога. -->
        <button class="dialog-btn" @click="choose('__cancel__')">Cancel</button>
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
  width: 320px;
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
.dialog-error { font-size: 12px; color: #e06c5b; margin-top: 6px; }
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
.dialog-btn:hover { background: var(--ov-btn-hover); }

</style>
