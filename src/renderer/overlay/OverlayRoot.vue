<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
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
  align?: 'start' | 'end'
  // Токен сессии от main. Нужен для подтверждения готовности: main держит
  // окно прозрачным, пока renderer не сообщит, что этот токен отрисован.
  token?: number
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: { title: string; placeholder?: string; initial?: string; buttons: { id: string; label: string }[] }
  icon?: { title: string; placeholder?: string; initial?: string }
  find?: { query?: string }
}

const payload = ref<OverlayPayload | null>(null)
const error = ref('')
// Парковка: main уводит окно и просит убрать содержимое из рендера.
// Прозрачности и увода за экран НЕДОСТАТОЧНО: на Linux с несколькими
// мониторами координаты клампятся в рабочую область, и оверлей оказывается
// видимым на соседнем мониторе. Пустой DOM не виден нигде, поэтому
// содержимое убираем через v-if — это основная защита, а не setOpacity.
const contentUnmounted = ref(true)
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
// Флаг анимаций — на <html>, не на .overlay-root. Причина: CSS-анимация
// overlay-fade на .browser-menu стартует в тот же кадр, когда Vue монтирует
// компонент. Если вешать no-anim реактивно на .overlay-root, класс успевает
// примениться ПОСЛЕ старта анимации — и fade проигрывается даже при
// animations: false. На <html> класс стоит до первой отрисовки, поэтому
// анимация не начинается вовсе. Работает и при первом открытии (prewarm грузит
// страницу без payload — флаг сразу false), и при переиспользовании окна.
document.documentElement.classList.toggle('no-anim', payload.value?.animations === false)

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

// Диагностика анимаций: сообщаем в main, какие CSS-анимации реально
// запустились на элементах оверлея. Нужно, чтобы отличить нашу
// overlay-fade от системной анимации появления окна в OS.
function traceAnimations(tag: string): void {
  requestAnimationFrame(() => {
    const html = document.documentElement
    const anims = document.getAnimations().map((a) => {
      const t = (a as unknown as { animationName?: string }).animationName
      return t ?? a.constructor.name
    })
    window.overlayAPI?.trace(
      `${tag} no-anim=${html.classList.contains('no-anim')} ` +
        `anims=[${anims.join(',')}] count=${anims.length}`
    )
  })
}

// Подтверждает main, что текущий payload применён. Main держит окно
// прозрачным до этого сигнала — иначе между setOpacity(1) и обновлением
// DOM пользователь видит пункты предыдущего меню (однокадровая вспышка).
//
// Кадра композитора здесь ждать не нужно: за отрисовку отвечает
// отдельная фаза painted, а от ready требуется только факт применения
// payload в JS. Раньше здесь стоял requestAnimationFrame, и именно на
// него приходилась вся разница между первым и последующими открытиями
// (2–16 мс, при 60 Гц один кадр = 16.7 мс). На первом открытии кадр
// приходил с задержкой, потому что окно только что переехало между
// дисплеями и композитор ещё не построил поверхность для целевого.
function reportReady(tag: string): void {
  const token = payload.value?.token
  void nextTick(() => {
    if (token === undefined) {
      // Prewarm: payload ещё нет, подтверждать нечего.
      return
    }
    window.overlayAPI?.ready(token)
    window.overlayAPI?.trace(`ready(${tag}) token=${token}`)
  })
}

onMounted(() => {
  // error ставим только если payload реально отсутствует ПОСЛЕ монтирования.
  // При prewarm страница грузится без payload — это норма, не ошибка.
  error.value = payload.value ? '' : 'Empty overlay payload.'
  traceAnimations('mount')
  // Prod-путь: loadFile с payload = полный reload, payload уже применён
  // к моменту монтирования. Dev-путь переподтверждает в hashchange.
  reportReady('mount')
  // Парковка от main: содержимое убираем из рендера. Значение по
  // умолчанию true — окно приходит в парке, а не с готовым меню.
  //
  // При снятии парковки (false) подтверждаем main, что кадр реально
  // отдан: один requestAnimationFrame после nextTick. Main держит окно
  // прозрачным до этого сигнала — иначе между setOpacity(1) и отрисовкой
  // нового содержимого пользователь увидит вспышку предыдущего меню.
  //
  // Раньше здесь стояло два rAF подряд. Второй давал +16.7 мс к каждому
  // открытию (при 60 Гц кадр = 16.7 мс, и замеры 21–55 мс складывались
  // именно в эти два кадра). Один rAF здесь достаточен, потому что при
  // парковке контент РАЗМОНТИРОВАН через v-if: окно пустое и прозрачное,
  // показывать нечего, вспышка старых пунктов физически неоткуда взяться.
  // Если когда-то появится реальная вспышка — возвращать второй rAF.
  window.overlayAPI?.onContentMounted?.((v: boolean) => {
    contentUnmounted.value = v
    if (v) return
    const token = payload.value?.token
    if (token === undefined) return
    void nextTick(() => {
      requestAnimationFrame(() => {
        window.overlayAPI?.painted(token)
      })
    })
  })
  // В dev-режиме (Vite dev server) loadURL с новым hash не перезагружает страницу,
  // а просто меняет маршрут. Слушаем hashchange и перепарсим payload.
  // В prod это полный reload, и hashchange не нужен — но лишний слушатель
  // не мешает, а код остается один.
  window.addEventListener('hashchange', () => {
    payload.value = parsePayload()
    // error сбрасываем в обе стороны: prewarm грузит страницу БЕЗ payload
    // (error = 'Empty overlay payload.'), потом приходит реальный payload —
    // иначе v-if="error" перебьёт рендер меню. Обратный случай (payload
    // есть, потом исчез) — тоже должен показывать ошибку, а не пустоту.
    error.value = payload.value ? '' : 'Empty overlay payload.'
    // Обновляем тему, если она изменилась в новом payload
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
    // Синхронизируем флаг анимаций с новым payload — настройку могли
    // переключить, пока оверлей был в пуле.
    document.documentElement.classList.toggle('no-anim', payload.value?.animations === false)
    traceAnimations('hashchange')
    // Dev-путь: DOM обновлен — подтверждаем main, чтобы он снял прозрачность.
    reportReady('hashchange')
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
    :class="{ 'align-start': payload?.align === 'start', live: !contentUnmounted }"
    @mousedown="onBackdrop">
    <!-- contentUnmounted: содержимое убрано из рендера полностью. Это
         основная защита от «мусорного» оверлея: окно может оказаться в
         любой точке экрана, но пустой DOM не виден нигде.
         Прозрачности окна для этого недостаточно. -->
    <template v-if="!contentUnmounted">
      <div v-if="error" class="overlay-error">{{ error }}</div>
      <BrowserMenu
        v-else-if="payload?.kind === 'menu'"
        :items="payload.items ?? []"
        :incognito="payload.incognito ?? false"
        :align="payload.align ?? 'end'"
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
    </template>
  </div>
</template>

<style scoped>
/* contentUnmounted: корень перестаёт быть мишенью для мыши ВООБЩЕ.
   весь вьюпорт (100vw x 100vh), и при парковке содержимое убрано, но сам
   div остаётся — а пустой полноэкранный div всё равно ловит mousedown
   под собой. Из-за этого клик по вкладке или панели не доходил до
   shell, а вместо него уходил overlay:dismiss: меню съедало клик и
   тут же само себя закрывало. */
.overlay-root {
  width: 100vw;
  height: 100vh;
  background: transparent;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 0;
  /* В парке кликабельность выключена; при показе включается (см. шаблон). */
  pointer-events: none;
}
/* Показанное меню снова кликабельно, иначе пункты не нажать. */
.overlay-root.live {
  pointer-events: auto;
}
/* Контекстные меню (align=start): левый край меню в точке клика */
.overlay-root.align-start {
  justify-content: flex-start;
}
/* Тосты — правый нижний угол окна. Окно тоста и так ставится main в
   правый нижний угол родителя, но внутри окна контент по умолчанию
   прижат к верху, и карточка уезжает вверх от нижнего отступа. */
.overlay-root:has(.toast-stack) {
  align-items: flex-end;
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
