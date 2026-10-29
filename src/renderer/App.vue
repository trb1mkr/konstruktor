<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useTabs, isIncognito, activeTabId } from './core/useTabs'
import { parseAccelerator, matchesInput, type HotkeyInput } from '../shared/hotkeys'
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  type HotkeyActionId
} from '../shared/hotkey-actions'
import { useLayoutInsets } from './core/layoutEngine'
import { effectiveTheme, roundedCorners, loadTheme } from './core/useTheme'
import { changeLanguage } from './i18n'
import { resolveLocale } from '../shared/i18n'
import TabStrip from './components/stdlib/TabStrip.vue'
import BookmarksBar from './components/stdlib/BookmarksBar.vue'
import AddressBar from './components/stdlib/AddressBar.vue'
import DropdownMenu from './components/stdlib/DropdownMenu.vue'
import WindowControls from './components/stdlib/WindowControls.vue'
import ExtensionActions from './components/stdlib/ExtensionActions.vue'
import ExtensionsButton from './components/stdlib/ExtensionsButton.vue'

// Корневой layout-SFC. Пользователь правит этот файл: порядок,
// позиция, стили компонентов. WebContentsView занимает остаток окна.
// Приватное окно не перекрашивается: признак приватности — бейдж перед
// кнопкой меню браузера, панель закладок в нём скрыта.
// Верхняя строка — кастомный заголовок: вкладки слева, гарантированный
// прямоугольник кнопок справа (меню браузера + свернуть/развернуть/закрыть).
//
// Пустая область строки тащит окно. Раньше это делал -webkit-app-region:
// drag, но на Windows drag-область перехватывает ПРАВЫЙ клик и отдаёт
// его системному меню окна: событие до renderer не доходит, отменить
// его нечем. Из-за этого контекстное меню панели открывалось только на
// кнопке "+" (она no-drag), а «своего» меню окна не существовало вовсе.
//
// Теперь тащит startWindowDrag ниже: тот же жест, но событие остаётся
// в renderer, поэтому ПКМ доступен на всей длине панели. Обратная сторона
// — теряется прилипание к краям экрана, его даёт ОС на drag-области.
useTabs()

const topPanel = ref<HTMLElement | null>(null)
const bottomPanel = ref<HTMLElement | null>(null)
const isMaximized = ref(false)
// Пространство этого окна: иконка и имя для значка в заголовке. Пусто до
// ответа main — тогда значок не рисуется (мигать заглушкой незачем).
const workspaceIcon = ref('')
const workspaceName = ref('')
// Приватная вкладка пространству не принадлежит: в приватном режиме значок
// пространства заменяется значком инкогнито, и подсказка тоже другая.
const badgeIcon = computed(() => (isIncognito.value ? '🕵️' : workspaceIcon.value))
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

// Значок пространства в заголовке: иконка принадлежит окну, а не странице,
// и читается один раз при старте shell. Смена иконки на странице пространств
// применится к уже открытым окнам только при следующем открытии окна —
// отдельного пуша для этого нет, а держать подписку ради одного эмодзи
// дороже, чем перезапустить окно.
async function loadWorkspaceBadge(): Promise<void> {
  try {
    const info = await window.browserAPI.workspaceInfo()
    workspaceIcon.value = info?.icon || ''
    workspaceName.value = info?.name || ''
  } catch {
    workspaceIcon.value = ''
    workspaceName.value = ''
  }
}

// Ctrl+F из фокуса shell (адресная строка, панели): открываем панель поиска.
// F11 из фокуса shell: Chromium не отдает клавишу сайту, тогглим через main.
// F12 из фокуса shell: DevTools активной вкладки. Точка дублирует
// before-input-event окна, а не заменяет его: в main решается, что именно
// докнуто, и там же состояние уходит в tabs:state.
//
// Ctrl+R / Ctrl+W / Ctrl+T — та же дублирующая точка для действий над
// вкладками (обновить, закрыть, создать). Разбор по e.code (физическая
// клавиша), как в main: раскладка не должна влиять. Дубль не даёт
// двойного срабатывания — main первым гасит событие через preventDefault,
// и до renderer оно доходит только там, где обработчик окна не выстрелил.
//
// Сочетания берутся из настроек: реестр действий и их разрешённые значения
// общие с main (shared/hotkey-actions), иначе переназначенная в настройках
// клавиша работала бы, а старая продолжала бы срабатывать здесь.
const hotkeys = ref<Record<HotkeyActionId, string>>({ ...DEFAULT_HOTKEYS })

function applyHotkeyOverrides(overrides?: Record<string, string>): void {
  const next = { ...DEFAULT_HOTKEYS }
  if (overrides) {
    for (const action of HOTKEY_ACTIONS) {
      const value = overrides[action.id]
      // Строка — всегда состояние: пустая = сочетание снято (не дефолт),
      // разбор её не находит, и действие не срабатывает.
      if (typeof value === 'string') next[action.id] = value.trim()
    }
  }
  hotkeys.value = next
}

function matchedAction(input: HotkeyInput): HotkeyActionId | null {
  for (const action of HOTKEY_ACTIONS) {
    const parsed = parseAccelerator(hotkeys.value[action.id])
    if (parsed && matchesInput(input, parsed)) return action.id
  }
  return null
}

function onKey(e: KeyboardEvent) {
  const action = matchedAction({
    code: e.code,
    control: e.ctrlKey,
    meta: e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey
  })
  if (!action) return
  e.preventDefault()
  if (action === 'reload') {
    void window.browserAPI.reload()
  } else if (action === 'new-tab') {
    void window.browserAPI.createTab()
  } else if (action === 'reopen-closed') {
    void window.browserAPI.reopenClosedTab()
  } else if (action === 'close-tab') {
    if (activeTabId.value !== null) void window.browserAPI.closeTab(activeTabId.value)
  } else if (action === 'find') {
    void window.browserAPI.openFind()
  } else if (action === 'devtools') {
    void window.browserAPI.toggleDevTools()
  } else if (action === 'fullscreen') {
    void window.browserAPI.toggleFullscreen()
  }
}

// --- Ручное перетаскивание окна ---
//
// Захват идёт по mousedown с ПРИНУЖДЕНИЕМ на ЛКМ: без него правый клик
// по панели вкладок начинал бы перетаскивание, а не открывал меню.
// Повторный mousedown без отпускания (т.е. dblclick) НЕ начинает drag:
// двойной клик по пустой области заголовка разворачивает окно, как
// в обычных окнах, и два перетаскивания подряд мешали бы этому.
//
// screenX/screenY, а не clientX/clientY: окно двигается по экрану,
// а client отсчитывается от области содержимого. Это разные системы.
function onTitleMouseDown(e: MouseEvent) {
  // Только ЛКМ. contextmenu разбираем отдельно.
  if (e.button !== 0) return
  // Вкладка и кнопки окна сами обрабатывают свои клики.
  //
  // .strip-filler в списке исключений НЕТ намеренно: это и есть пустая
  // часть панели, за которую окно обязано таскаться (раньше это делала
  // drag-область на самом .tabstrip). Сам @contextmenu на .strip-filler
  // отменяется через @contextmenu.prevent, и наведение мыши сюда
  // добраться может только при ЛКМ, то есть конфликта с drag нет.
  const target = e.target
  if (target instanceof Element) {
    if (target.closest('.tab, .tab-add, .window-controls')) return
    // Текст и поля ввода — не точка хвата.
    if (target.closest('input, textarea, button, a')) return
  }
  // Окно развёрнуно или в fullscreen: тащить нечего.
  if (isMaximized.value || isFullscreen.value || isContentFullscreen.value) return
  // Двойной клик = разворот, не drag.
  if (e.detail > 1) return
  if (!window.browserAPI.startWindowDrag({ x: e.screenX, y: e.screenY })) return
  // Пока кнопка зажата, курсор должен остаться «перетаскивающим», а окно
  // ехать за ним. Слушатели — на document с capture, иначе захват
  // теряется, когда курсор уходит с окна вниз или вбок.
  const onMove = (ev: MouseEvent) => {
    if (ev.button !== 0) return
    window.browserAPI.moveWindowDrag({ x: ev.screenX, y: ev.screenY })
  }
  const onUp = (ev: MouseEvent) => {
    if (ev.button !== 0) return
    window.browserAPI.endWindowDrag()
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mouseup', onUp, true)
  }
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('mouseup', onUp, true)
}

// Двойной клик по пустой области заголовка — развернуть/свернуть.
// Системное поведение frameless-окна, которое мы потеряли вместе с
// drag-областью.
function onTitleDblClick(e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.target
  if (target instanceof Element && target.closest('.tab, .tab-add, .window-controls')) return
  // Fullscreen (F11) и контентный fullscreen не трогаем: там разворот
  // бессмыслен, выход — Esc/F11. Развёрнутое окно разворачиваем И
  // сворачиваем: toggleMaximize в main сам решает по isMaximized().
  if (isFullscreen.value || isContentFullscreen.value) return
  void window.browserAPI.toggleMaximize()
}

onMounted(() => window.addEventListener('keydown', onKey))
onMounted(() => {
  void refreshMaximized()
  void loadTheme()
  void loadWorkspaceBadge()
  // Стартовые сочетания: переопределения из настроек поверх дефолтов.
  void window.browserAPI
    .getSettings()
    .then((s?: { hotkeys?: Record<string, string> }) => applyHotkeyOverrides(s?.hotkeys))
    .catch(() => undefined)
  const unsubSettings = window.browserAPI.onSettingsChanged((info) => {
    void loadTheme()
    // Язык: main шлёт сырое значение настройки, резолв тем же,
    // что и при старте. Неизменённый язык в changeLanguage — no-op.
    if (info?.locale) void changeLanguage(resolveLocale(info.locale, navigator.language))
    // Хоткеи: смена в настройках приходит тем же каналом.
    if (info?.hotkeys) applyHotkeyOverrides(info.hotkeys)
  })
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
      <div
        class="titlebar"
        @mousedown="onTitleMouseDown"
        @dblclick="onTitleDblClick"
      >
        <TabStrip class="grow" />
        <WindowControls class="controls">
          <template #menu>
            <!-- Значок принадлежности окна перед кнопкой меню браузера.
                 Обычный режим — иконка рабочего пространства (у каждого
                 своя), приватный — 🕵️: приватная вкладка работает в
                 in-memory партиции и пространству не принадлежит. Раньше
                 здесь был только значок инкогнито, и о том, в каком
                 пространстве открыто окно, приходилось догадываться. -->
            <span
              v-if="badgeIcon"
              class="workspace-badge"
              :class="{ private: isIncognito }"
              :title="isIncognito ? $t('shell.incognito') : workspaceName"
            >{{ badgeIcon }}</span>
            <DropdownMenu title="☰" class="menu" />
          </template>
        </WindowControls>
      </div>
      <BookmarksBar v-if="!isIncognito" />
      <!-- Значки расширений и кнопка-пазл — в строке адреса, справа
           от кнопки поиска: так они стоят в Chrome и Яндекс Браузере,
           и не теряются, когда панель вкладок заполнена. -->
      <AddressBar>
        <ExtensionActions />
        <ExtensionsButton />
      </AddressBar>
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
/* Приватное окно НЕ перекрашивается. Признак приватности — бейдж у
   кнопки меню браузера, а не цвет панелей: перекраска ломала
   пользовательскую тему и читалась как отдельный «режим оформления», а
   не как приватность. Класс .incognito на shell остаётся для этого
   бейджа и для скрытия панели закладок. */
.panel-top { display: flex; flex-direction: column; flex-shrink: 0; min-height: 60px; z-index: 10; background: var(--panel-bg); }
/* Кастомный заголовок: вкладки и кнопки окна на одной линии по центру,
   одинаковая высота (32px), разрыв 8px между панелью и кнопками —
   вкладка больше не упирается в кнопку меню. */
/* Заголовок больше НЕ drag-область: на Windows она перехватывала
   правый клик и отдавала его системному меню окна. Окно тащит
   onTitleMouseDown — событие остаётся в renderer, поэтому ПКМ доступен
   на всей длине панели вкладок и у кнопок навигации. */
.titlebar { display: flex; align-items: center; gap: 4px; padding: 0px 0px; }
.titlebar .grow { flex: 1; min-width: 0; display: flex; }
/* Панель вкладок отдает свои отступы заголовку: иначе двойной паддинг
   (6px стрипа + 6px заголовка) делает вкладки выше кнопок. */
.titlebar .grow :deep(.tabstrip) { flex: 1; padding: 0; }
.titlebar .controls { flex-shrink: 0; display: flex; align-items: center; }
.titlebar .menu { display: flex; align-items: center; }
.panel-bottom { display: none; }
.shell.rounded:not(.maximized):not(.content-fs) .panel-bottom { display: flex; flex-direction: column; flex-shrink: 0; height: 12px; min-height: 12px; z-index: 10; background: transparent; }
/* Значок окна: та же высота и выравнивание, что у кнопок окна, иначе
   строка заголовка стала бы выше 32px. Один класс на два состояния —
   иконка пространства и значок инкогнито; .private только гасит
   прозрачность, чтобы приватный режим читался как «другой» и не спорил
   с иконкой пространства. */
.workspace-badge {
  display: flex;
  align-items: center;
  height: 32px;
  font-size: 15px;
  padding: 0 4px;
  cursor: default;
  user-select: none;
}
.workspace-badge.private { opacity: 0.75; }

</style>
