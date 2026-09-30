<script setup lang="ts">
import { onMounted } from 'vue'

// Стек уведомлений: тосты поверх сайта в том же оверлей-окне.
// Автозакрытие по timeout, клик — dismiss.
const props = defineProps<{
  toast: { title: string; body?: string; timeout?: number }
}>()

onMounted(() => {
  const ms = props.toast.timeout ?? 4000
  if (ms > 0) {
    window.setTimeout(() => void window.overlayAPI.dismiss(), ms)
  }
})

async function close() {
  await window.overlayAPI.dismiss()
}
</script>

<template>
  <div class="toast-stack" @mousedown.stop>
    <div class="toast" @click="close">
      <div class="toast-title">{{ toast.title }}</div>
      <div v-if="toast.body" class="toast-body">{{ toast.body }}</div>
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-end;
  padding: 12px;
}
.toast {
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  color: var(--ov-text);
  /* Текст не должен вылезать за пределы карточки: длинный заголовок
     или URL переносится, а не выходит за правый край. max-width в
     процентах от родителя (width: 100% + padding) и overflow-wrap
     рвут неразрывные строки. */
  max-width: 100%;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.toast:hover { background: var(--ov-hover); }
/* min-width: 0 позволяет flex-ребёнку сжиматься — без него карточка
   распирает контейнер длинным словом. */
.toast > * { min-width: 0; }
.toast-title {
  font-size: 14px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.toast-body {
  font-size: 13px;
  color: var(--ov-dim);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
</style>
