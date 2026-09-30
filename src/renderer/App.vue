<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useTabs, isIncognito } from './core/useTabs'
import { useLayoutInsets } from './core/layoutEngine'
import { effectiveTheme, roundedCorners, loadTheme } from './core/useTheme'
import TabStrip from './components/stdlib/TabStrip.vue'
import BookmarksBar from './components/stdlib/BookmarksBar.vue'
import AddressBar from './components/stdlib/AddressBar.vue'
import DropdownMenu from './components/stdlib/DropdownMenu.vue'
import WindowControls from './components/stdlib/WindowControls.vue'

// Корневой layout-SFC. Пользователь правит этот файл: порядок,
// позиция, стили компонентов. WebContentsView занимает остаток окна.
// Инкогнито-окно красится через класс .incognito на shell.
// Верхняя строка — кастомный заголовок: вкладки слева, гарантированный
// прямоугольник кнопок справа (меню браузера + свернуть/развернуть/закрыть).
// Пустая область строки тащит окно (-webkit-app-region: drag).
useTabs()

const topPanel = ref<HTMLElement | null>(null)
const bottomPanel = ref<HTMLElement | null>(null)
const isMaximized = ref(false)
// F11: в fullscreen скругление тоже снимаем, как в maximize.
const isFullscreen = ref(false)
// Контентный fullscreen: панели прячутся, view растягивается на все окно.
const isContentFullscreen = ref(false)

useLayoutInsets({ top: topPanel, bottom: bottomPanel })

// Скругление углов только в оконном режиме: в maximize/fullscreen — прямые.
// Начальное состояние читаем явно: пуш из main приходит только на изменения.
async function refreshMaximized() {
  try {
    isMaximized.value = await window.browserAPI.isMaximized()
  } catch {
    isMaximized.value = false
  }
}

// Ctrl+F из фокуса shell (адресная строка, панели): открываем панель поиска.
// F11 из фокуса shell: Chromium не отдает клавишу сайту, тогглим через main.
function onKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  const isF = e.key.toLowerCase() === 'f' || e.code === 'KeyF'
  if (mod && !e.shiftKey && !e.altKey && isF) {
    e.preventDefault()
    void window.browserAPI.openFind()
    return
  }
  if (e.key === 'F11' && !mod && !e.shiftKey && !e.altKey) {
    e.preventDefault()
    void window.browserAPI.toggleFullscreen()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onMounted(() => {
  void refreshMaximized()
  void loadTheme()
  const unsubSettings = window.browserAPI.onSettingsChanged(() => void loadTheme())
  const unsubMax = window.browserAPI.onMaximizedChanged((v) => {
    isMaximized.value = v
  })
  const unsubFs = window.browserAPI.onFullscreenChanged((v) => {
    isFullscreen.value = v
  })
  const unsubContentFs = window.browserAPI.onContentFullscreenChanged((v) => {
    isContentFullscreen.value = v
  })
  onUnmounted(() => {
    unsubSettings()
    unsubMax()
    unsubFs()
    unsubContentFs()
  })
})
onUnmounted(() => window.removeEventListener('keydown', onKey))

// Клик по shell мимо открытого меню закрывает это меню. Меню живёт в
// отдельном прозрачном окне поверх WebContentsView, поэтому клик по
// вкладке или адресной строке его не гасит — а пользователь ждёт, что
// гасит, как в обычных браузерах.
//
// Ловим click, а не mousedown: mousedown, который открыл меню, успевает
// долететь до shell уже ПОСЛЕ появления окна, и только что открытое меню
// закрывалось тем же кликом. К моменту click это уже другой момент
// времени, эха не будет.
//
// Клик по САМОМУ триггеру (☰ меню браузера) гасить нельзя — иначе
// toggle сломался бы: открытие меню и его закрытие пришли бы в одном
// кадре. Проверяем по классу .menu-trigger на цели клика.
//
// Диалоги и панель поиска сюда НЕ попадают: main закрывает только kind
// 'menu'. В частности клик по shell не сносит открытый диалог иконки.
onMounted(() => {
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return
    const t = e.target
    if (t instanceof Element && t.closest('.menu-trigger')) return
    window.browserAPI.dismissMenuOnShellClick()
  }
  document.addEventListener('click', onDown, true)
  onUnmounted(() => document.removeEventListener('click', onDown, true))
})
</script>

<template>
  <div class="shell" :class="{ incognito: isIncognito, maximized: isMaximized || isFullscreen, rounded: roundedCorners, 'content-fs': isContentFullscreen }" :data-theme="effectiveTheme">
    <!-- Кастомный заголовок: вкладки + кнопки окна на одном уровне. -->
    <div v-if="!isContentFullscreen" ref="topPanel" class="panel-top">
      <div class="titlebar">
        <span v-if="isIncognito" class="incognito-badge" title="Incognito window">🕵️</span>
        <TabStrip class="grow" />
        <WindowControls class="controls">
          <template #menu>
            <DropdownMenu title="☰" class="menu" />
          </template>
        </WindowControls>
      </div>
      <BookmarksBar v-if="!isIncognito" />
      <AddressBar />
    </div>

    <!-- Центр пустой: здесь живет WebContentsView (сайт). -->

    <!-- Нижняя панель пустая: адресная строка переехала наверх. -->
    <div v-if="!isContentFullscreen" ref="bottomPanel" class="panel-bottom" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100vh; min-height: 100vh; color: var(--text); }
/* Скругленные углы окна в оконном режиме. Окно transparent, фон красит shell. */
/* По дефолту выключено (класс .rounded): низ скругляется только через
   прозрачную полосу panel-bottom под WebContentsView. */
/* Контентный fullscreen: панелей нет, view на все окно, скругления нет. */
.shell { background: var(--shell-bg); overflow: hidden; }
.shell.rounded:not(.maximized):not(.content-fs) { border-radius: 12px; }
.shell.incognito { background: #1a1030; color: #eee; }
.panel-top { display: flex; flex-direction: column; flex-shrink: 0; min-height: 60px; z-index: 10; background: var(--panel-bg); }
/* Кастомный заголовок: вкладки и кнопки окна на одной линии по центру,
   одинаковая высота (32px), разрыв 8px между панелью и кнопками —
   вкладка больше не упирается в кнопку меню. */
.titlebar { display: flex; align-items: center; gap: 4px; padding: 0px 0px; -webkit-app-region: drag; }
.titlebar .grow { flex: 1; min-width: 0; display: flex; }
/* Панель вкладок отдает свои отступы заголовку: иначе двойной паддинг
   (6px стрипа + 6px заголовка) делает вкладки выше кнопок. */
.titlebar .grow :deep(.tabstrip) { flex: 1; padding: 0; }
.titlebar .controls { flex-shrink: 0; display: flex; align-items: center; }
.titlebar .menu { display: flex; align-items: center; }
.panel-bottom { display: none; }
.shell.rounded:not(.maximized):not(.content-fs) .panel-bottom { display: flex; flex-direction: column; flex-shrink: 0; height: 12px; min-height: 12px; z-index: 10; background: transparent; }
.incognito-badge { align-self: center; font-size: 18px; padding: 0 4px 0 8px; }
/* Инкогнито-окно: темный фиолетовый акцент панелей. */
.shell.incognito .panel-top { background: #1a1030; }
.shell.incognito .panel-bottom { background: #1a1030; }
</style>
