<script setup lang="ts">
import { ref, onMounted } from 'vue'

// Модальный диалог с полем ввода в оверлей-окне: центрируется
// overlayManager (kind 'dialog'), значение уходит через overlay:submit.
// Кнопки присылает main (например URL / Local file / Cancel).
const props = defineProps<{
  dialog: { title: string; placeholder?: string; initial?: string; buttons: { id: string; label: string }[] }
}>()

const emit = defineEmits<{
  (e: 'submit', value: string): void
}>()

const value = ref(props.dialog.initial ?? '')
const input = ref<HTMLInputElement | null>(null)

onMounted(() => {
  input.value?.focus()
  input.value?.select()
})

async function choose(id: string) {
  // Кнопка Cancel — просто закрыть без submit.
  if (id === '__cancel__') {
    await window.overlayAPI.dismiss()
    return
  }
  emit('submit', `${id}::${value.value}`)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') void choose(props.dialog.buttons[0]?.id ?? '__cancel__')
  if (e.key === 'Escape') void window.overlayAPI.dismiss()
}
</script>

<template>
  <div class="dialog-root">
    <div class="dialog" @mousedown.stop>
      <div class="dialog-title">{{ dialog.title }}</div>
      <input
        ref="input"
        v-model="value"
        class="dialog-input"
        :placeholder="dialog.placeholder ?? ''"
        spellcheck="false"
        @keydown="onKey"
      />
      <div class="dialog-actions">
        <button
          v-for="b in dialog.buttons"
          :key="b.id"
          class="dialog-btn"
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
.dialog-actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.dialog-btn {
  background: var(--ov-btn-bg);
  color: var(--ov-text);
  border: none;
  border-radius: 8px;
  padding: 6px 14px;
  cursor: pointer;
}
.dialog-btn:hover { background: var(--ov-btn-hover); }
</style>
