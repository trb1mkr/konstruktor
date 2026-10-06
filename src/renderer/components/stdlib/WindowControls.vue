<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

// Кнопки кастомного заголовка: меню браузера + свернуть/развернуть/закрыть.
// Гарантированный прямоугольник справа, на одном уровне с вкладками.
const maximized = ref(false)

async function refresh() {
  try {
    maximized.value = await window.browserAPI.isMaximized()
  } catch {
    maximized.value = false
  }
}

let unsubMax: (() => void) | null = null
let unsubFs: (() => void) | null = null

onMounted(() => {
  void refresh()
  // Состояние maximize/fullscreen пушит main — опроса раз в секунду больше нет.
  unsubMax = window.browserAPI.onMaximizedChanged((v) => {
    maximized.value = v
  })
  unsubFs = window.browserAPI.onFullscreenChanged((v) => {
    if (v) maximized.value = true
    else void refresh()
  })
})

onUnmounted(() => {
  unsubMax?.()
  unsubFs?.()
})

async function minimize() {
  await window.browserAPI.minimizeWindow()
}
async function toggleMax() {
  maximized.value = await window.browserAPI.toggleMaximize()
}
async function close() {
  await window.browserAPI.closeWindow()
}

// ПКМ по кнопкам навигации — своё меню окна (restore/move/size/minimize/
// close + «Open new window»).
//
// Системное меню исчезло вместе с drag-областью заголовка: на Windows
// правый клик по ней отдавался ОС, мимо renderer, и оно появлялось само
// там, где пользователь не просил. Свое меню рисуется тем же оверлеем,
// что остальные контекстные меню, — иначе оно было бы светлым на
// тёмной панели.
//
// Точка вызова — координаты курсора, а не угол кнопок: правый клик по
// ПКМ в системном окне тоже открывает меню в точке курсора.
function openWindowMenu(e: MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  window.browserAPI.windowContextMenu({
    x: Math.round(e.clientX),
    y: Math.round(e.clientY)
  })
}
</script>

<!-- ПКМ по всей группе, а не по кнопке: у кнопок событие всплывало бы
     от нажатой, и меню открывалось бы в разных местах в зависимости от
     того, какая кнопка попала под курсор. -->
<template>
  <div class="window-controls" @contextmenu.prevent="openWindowMenu($event)">
    <slot name="menu" />
    <button class="wc-btn" :title="$t('window.menu.minimize')" @click="minimize">─</button>
    <button
      class="wc-btn"
      :title="maximized ? $t('window.menu.restore') : $t('window.menu.maximize')"
      @click="toggleMax"
    >
      {{ maximized ? '❐' : '☐' }}
    </button>
    <button class="wc-btn close" :title="$t('window.menu.close')" @click="close">✕</button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  /* Кнопки не тащат окно — клики идут в Vue. */
  -webkit-app-region: no-drag;
  padding: 0;
  /* Отступ справа = левый padding табстрипа (8px), чтобы кнопка закрытия
     не прилипала к краю окна. */
  margin-right: 8px;
}
.wc-btn {
  width: 36px;
  height: 32px;
  min-height: 0;
  background: transparent;
  border: none;
  border-radius: 8px;
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.wc-btn:hover { background: var(--btn-hover-bg); color: var(--text); }
.wc-btn.close:hover { background: #c42b1c; color: #fff; }
</style>
