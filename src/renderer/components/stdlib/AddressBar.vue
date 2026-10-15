<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { tabs, activeTabId } from '../../core/useTabs'

// Адресная строка. Стили полностью переопределяемые через CSS.
const input = ref('')

// Масштаб активной вкладки в процентах. Реактивен «бесплатно»: зум-действия
// (клавиши, колесо, попап) пушат tabs:state, а поле zoom читает main
// опросом webContents — badge не может разойтись со страницей.
const zoomPercent = computed(() => {
  const current = tabs.value.find((t) => t.id === activeTabId.value)
  return current?.zoom ?? 100
})

const zoomBtn = ref<HTMLButtonElement | null>(null)
const permBtn = ref<HTMLButtonElement | null>(null)

// Корень панели: его левый нижний угол — точка вызова промпта разрешения.
const root = ref<HTMLElement | null>(null)
let anchorObserver: ResizeObserver | null = null

// Сообщает main точку под адресной строкой. Пресеты кладут панель и
// сверху, и снизу (ClassicTop/Minimal), поэтому положение знает только
// shell — main берёт его отсюда, а не угадывает по инсетам.
function reportAnchor(): void {
  const el = root.value
  if (!el || !window.browserAPI?.reportAddressAnchor) return
  const rect = el.getBoundingClientRect()
  window.browserAPI.reportAddressAnchor({
    x: Math.round(rect.left),
    y: Math.round(rect.bottom)
  })
}

// Синхронизация поля с URL активной вкладки.
watch(
  [tabs, activeTabId],
  () => {
    const current = tabs.value.find((t) => t.id === activeTabId.value)
    if (current) input.value = current.url === 'about:blank' ? '' : current.url
  },
  { immediate: true }
)

async function go() {
  if (activeTabId.value === null || !input.value.trim()) return
  await window.browserAPI.navigate(activeTabId.value, input.value.trim())
}

// Бейдж разрешений сайта: одна кнопка на всё, что сайт получил и что прямо
// сейчас использует. Раньше это были две кнопки рядом (значки решений и
// индикатор захвата) — вместе они занимали полстроки и читались как два
// разных управления. Иконка ✅ постоянная, а захват добавляется к ней:
// 📷/🎤/🖥️ показывают, что доступ не просто выдан, а работает сейчас.
const permissions = computed(
  () => tabs.value.find((t) => t.id === activeTabId.value)?.permissions ?? []
)
const capture = computed(() => tabs.value.find((t) => t.id === activeTabId.value)?.capturing)
const permissionBadge = computed(() => {
  const cap = capture.value
  const live: string[] = []
  if (cap?.video) live.push('📷')
  if (cap?.audio) live.push('🎤')
  if (cap?.screen) live.push('🖥️')
  return '✅' + live.join('')
})
const hasPermissionBadge = computed(() => permissions.value.length > 0 || !!capture.value)

async function openPermissionsMenu() {
  const rect = permBtn.value?.getBoundingClientRect()
  window.browserAPI.permissionsMenu(
    rect ? { x: Math.round(rect.right), y: Math.round(rect.bottom) } : { x: 0, y: 0 }
  )
}

onMounted(() => {
  reportAnchor()
  // Панель меняет положение при смене пресета и контентном fullscreen:
  // наблюдаем и за самой панелью, и за телом документа (высота меняется,
  // когда панели скрываются или появляются).
  anchorObserver = new ResizeObserver(reportAnchor)
  if (root.value) anchorObserver.observe(root.value)
  anchorObserver.observe(document.body)
  window.addEventListener('resize', reportAnchor)
  requestAnimationFrame(reportAnchor)
})

onUnmounted(() => {
  anchorObserver?.disconnect()
  anchorObserver = null
  window.removeEventListener('resize', reportAnchor)
})

async function back() {
  await window.browserAPI.goBack()
}
async function forward() {
  await window.browserAPI.goForward()
}
async function reload() {
  await window.browserAPI.reload()
}

// Попап масштаба: якорь — правый НИЖНИЙ угол бейджа. Паттерн DropdownMenu:
// меню живёт в отдельном overlay-окне, DOM-выпадашка ушла бы под
// WebContentsView (в пресете Minimal адресная строка вообще снизу).
function openZoomPopup() {
  const rect = zoomBtn.value?.getBoundingClientRect()
  if (rect) {
    window.browserAPI.zoomPopup({
      x: Math.round(rect.right),
      y: Math.round(rect.bottom)
    })
  } else {
    window.browserAPI.zoomPopup({ x: 0, y: 0 })
  }
}
</script>

<template>
  <div ref="root" class="addressbar">
    <button class="nav-btn" :title="$t('addressBar.back')" @click="back">←</button>
    <button class="nav-btn" :title="$t('addressBar.forward')" @click="forward">→</button>
    <button class="nav-btn" :title="$t('addressBar.reload')" @click="reload">⟳</button>
    <input
      v-model="input"
      class="url-input"
      :placeholder="$t('addressBar.placeholder')"
      spellcheck="false"
      @keydown.enter="go"
    />
    <button class="go-btn" :title="$t('addressBar.go')" @click="go">🔍</button>
    <!-- Бейдж масштаба: виден только при проценте != 100. При исчезновении
         url-input снова занимает ширину через flex: 1 — инсеты layout
         (высота панели) от ширины бейджа не зависят. Класс menu-trigger
         гасит dismiss по клику: закрытие/открытие попапа делает toggle
         по toggleKey, иначе клик закрыл бы его же и открыл обратно. -->
    <button
      v-if="zoomPercent !== 100"
      ref="zoomBtn"
      class="zoom-badge menu-trigger"
      :title="$t('zoom.badge')"
      @click="openZoomPopup"
    >🔬 {{ zoomPercent }}%</button>
    <!-- Бейдж разрешений: одна кнопка на решения сайта и на активный
         захват. Клик — меню со списком решений и сбросом. -->
    <button
      v-if="hasPermissionBadge"
      ref="permBtn"
      class="perm-badge menu-trigger"
      :class="{ 'perm-badge--live': !!capture }"
      :title="capture ? $t('permissions.capturing') : $t('permissions.badge')"
      @click="openPermissionsMenu"
    >{{ permissionBadge }}</button>
    <slot />
  </div>
</template>

<style scoped>
.addressbar {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 8px;
  background: var(--panel-bottom-bg);
}
.url-input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  outline: none;
}
.nav-btn, .go-btn {
  background: var(--btn-bg);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  cursor: pointer;
}
.nav-btn:hover, .go-btn:hover { background: var(--btn-hover-bg); }
/* Бейдж масштаба: та же пилюля, что и кнопки навигации, но компактнее.
   Числа табличные (font-variant-numeric), иначе "100%" -> "110%" дёргает
   ширину бейджа и рядом дёргается url-input. */
.zoom-badge {
  background: var(--btn-bg);
  color: var(--text);
  border: none;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.zoom-badge:hover { background: var(--btn-hover-bg); }
/* Бейдж разрешений сайта: те же габариты, что у бейджа масштаба. Рамка
   акцента появляется только при активном захвате — по ней видно, что
   доступ не просто выдан, а работает прямо сейчас. */
.perm-badge {
  background: var(--btn-bg);
  color: var(--text);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.perm-badge:hover { background: var(--btn-hover-bg); }
.perm-badge--live { border-color: #4a8cf7; }
</style>
