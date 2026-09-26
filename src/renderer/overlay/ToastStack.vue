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
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-left: auto;
  max-width: 340px;
}
.toast {
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 12px 14px;
  cursor: pointer;
  color: var(--ov-text);
}
.toast:hover { background: var(--ov-hover); }
.toast-title { font-size: 14px; font-weight: 600; }
.toast-body { font-size: 13px; color: #aaa; margin-top: 4px; }
</style>
