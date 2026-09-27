<script setup lang="ts">
import { ref, onMounted } from 'vue'
import BrowserMenu from './BrowserMenu.vue'
import ToastStack from './ToastStack.vue'
import PromptDialog from './PromptDialog.vue'
import IconDialog from './IconDialog.vue'
import FindBar from './FindBar.vue'

// Корень оверлей-окна. Main передает payload через ?payload= в hash URL:
// { kind: 'menu', anchor, items, incognito } или { kind: 'toast', ... }.
// Клик по прозрачной области = закрыть без выбора.
export interface MenuItem {
  id: string
  label: string
  icon: string
  color?: string
  disabled?: boolean
}

interface OverlayPayload {
  kind: 'menu' | 'toast' | 'dialog' | 'find' | 'icon'
  items?: MenuItem[]
  incognito?: boolean
  animations?: boolean
  theme?: string
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: { title: string; placeholder?: string; initial?: string; buttons: { id: string; label: string }[] }
  icon?: { title: string; placeholder?: string; initial?: string }
  find?: { query?: string }
}

const payload = ref<OverlayPayload | null>(null)
const error = ref('')
// Парсим синхронно до первого рендера: иначе .no-anim применится
// после старта анимации и fade при animations off всё равно проиграется.
// Тему кладем на <html> сразу — оверлей красится до монтирования.
payload.value = parsePayload()
// Эффективная тема: 'system' резолвится через matchMedia, остальные как есть.
const rawTheme = payload.value?.theme ?? 'dark'
const effTheme =
  rawTheme === 'system'
    ? window.matchMedia?.('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark'
    : rawTheme === 'slate' || rawTheme === 'light'
      ? rawTheme
      : 'dark'
document.documentElement.dataset.theme = effTheme

function parsePayload(): OverlayPayload | null {
  try {
    const hash = window.location.hash.replace(/^#/, '')
    const params = new URLSearchParams(hash)
    const raw = params.get('payload')
    if (!raw) return null
    return JSON.parse(decodeURIComponent(raw)) as OverlayPayload
  } catch {
    return null
  }
}

onMounted(() => {
  if (!payload.value) error.value = 'Empty overlay payload.'
  // Escape закрывает без выбора.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void window.overlayAPI.dismiss()
  })
})

async function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) await window.overlayAPI.dismiss()
}

async function onSelect(id: string) {
  await window.overlayAPI.select(id)
}

async function onSubmit(value: string) {
  await window.overlayAPI.submit(value)
}
</script>

<template>
  <div
    class="overlay-root"
    :class="{ 'no-anim': payload?.animations === false }"
    @mousedown="onBackdrop">
    <div v-if="error" class="overlay-error">{{ error }}</div>
    <BrowserMenu
      v-else-if="payload?.kind === 'menu'"
      :items="payload.items ?? []"
      :incognito="payload.incognito ?? false"
      @select="onSelect"
    />
    <ToastStack
      v-else-if="payload?.kind === 'toast' && payload.toast"
      :toast="payload.toast"
    />
    <PromptDialog
      v-else-if="payload?.kind === 'dialog' && payload.dialog"
      :dialog="payload.dialog"
      @submit="onSubmit"
    />
    <IconDialog
      v-else-if="payload?.kind === 'icon' && payload.icon"
      :icon="payload.icon"
    />
    <FindBar
      v-else-if="payload?.kind === 'find'"
      :initial="payload.find?.query ?? ''"
    />
  </div>
</template>

<style scoped>
.overlay-root {
  width: 100vw;
  height: 100vh;
  background: transparent;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 0;
}
/* Диалог — по центру окна, меню/тосты — как раньше. Без дим-подложки:
   окно оверлея ровно по размеру панели, затемнение по краям выглядело
   как полупрозрачная обводка. Теней (box-shadow) тоже нет. */
.overlay-root:has(.dialog-root) {
  justify-content: center;
  align-items: center;
  background: transparent;
}
.overlay-error { color: #888; font-size: 13px; padding: 16px; }
</style>
