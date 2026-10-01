<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import BrowserMenu from './BrowserMenu.vue'
import ToastStack from './ToastStack.vue'
import PromptDialog from './PromptDialog.vue'
import IconDialog from './IconDialog.vue'
import FindBar from './FindBar.vue'

// Формы берёмся из контракта, а не дублируются здесь.
//
// Раньше типы были объявлены локально с оговоркой «в бандл renderer общий
// тип не попадает». Оговорка неверна: типы стираются при сборке, и
// `renderer/core/useTabs.ts` уже импортирует их из preload. Цена
// дублирования тут и проявилась: на шаге 4b в модель добавили
// `find.counter` и `icon.error`, локальная копия осталась без них, и
// `onUpdate` перестал компилироваться.
//
// Модель renderer остаётся плоской (все поля опциональны), а не union из
// контракта: шаблон читает `model.items` и `model.find` напрямую, и с
// union пришлось бы сузить тип по `view` в каждом месте. Переход на
// union — задача шага 7 вместе с реестром компонентов.
import type {
  DialogModel,
  FindModel,
  IconModel,
  MenuItem,
  ToastModel,
  UpdateMessage
} from '../../shared/overlay-types'

// `MenuItem` реэкспортируется: его импортирует BrowserMenu.vue. Экспорт
// из .vue оставлен, чтобы менять потребителей не пришлось.
export type { MenuItem }

interface OverlayModel {
  view: 'menu' | 'toast' | 'dialog' | 'find' | 'icon'
  items?: MenuItem[]
  badge?: string
  toast?: ToastModel
  dialog?: DialogModel
  icon?: IconModel
  find?: FindModel
}

// То, что приходит из main одним сообщением overlay:push. Форма задана
// контрактом PushMessage, но остаётся локальной копией: см. пояснение выше
// про дублирование форм.
interface OverlayPayload {
  // Токен сессии. Он же подтверждение отрисовки: main держит окно
  // прозрачным, пока renderer не вернёт sessionId через overlay:painted.
  //
  // Отдельного поля token не существует намеренно: в main sessionToken
  // уходит и как sessionId, и как токен. Два поля означали бы два
  // источника правды, которые однажды разойдутся.
  sessionId: number
  model: OverlayModel
  theme: 'dark' | 'light' | 'slate'
  animations: boolean
  // Меню прижато к левому краю якоря (align: 'start' в main).
  anchorLeft?: boolean
}

const payload = ref<OverlayPayload | null>(null)

// Типы берём из контракта, а не дублируем локально. Прежний комментарий
// утверждал, что общий тип в бандл renderer не попадает и его приходится
// дублировать — это неверно: типы стираются при сборке, и
// `renderer/core/useTabs.ts` уже импортирует их из preload. Локальная копия
// разошлась с общей на шаге 4b: counter и error добавились в модель, а
// локальный OverlayModel молча остался без них.
type OverlayUpdate = UpdateMessage

// Глубокий мерж патча в модель. Намеренно локальный: патчи всегда плоские
// (find.counter, icon.error), и общий deep-merge был бы лишней
// абстракцией.
//
// null и undefined НЕ перезаписывают поле — иначе нельзя было бы стереть
// сообщение об ошибке, не отправляя полную сессию заново.
function mergePatch<T extends object>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null) return base
  const out = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    const cur = out[key]
    const bothPlainObjects =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof cur === 'object' &&
      cur !== null &&
      !Array.isArray(cur)
    out[key] = bothPlainObjects
      ? mergePatch(cur as Record<string, unknown>, value)
      : value
  }
  return out as T
}
const error = ref('')
// Парковка: main уводит окно и просит убрать содержимое из рендера.
// Прозрачности и увода за экран НЕДОСТАТОЧНО: на Linux с несколькими
// мониторами координаты клампятся в рабочую область, и оверлей оказывается
// видимым на соседнем мониторе. Пустой DOM не виден нигде, поэтому
// содержимое убираем через v-if — это основная защита, а не setOpacity.
const contentUnmounted = ref(true)
// На старте данных нет: страница оверлея грузится ОДИН раз без payload,
// сессия приходит через overlay:push. Ставить тему и флаг анимаций здесь
// нечего — они применятся в applyPayload, до снятия парковки.
//
// До первого push красим в тёмную: так выглядит пустое прозрачное окно
// на старте, и переключение темы не мигает.
document.documentElement.dataset.theme = 'dark'

// Применяет сессию: данные, тема, флаг анимаций.
//
// Тема и no-anim ставятся на <html> СИНХРОННО, до обновления payload.
// Причина: CSS-анимация overlay-fade стартует в тот же кадр, когда Vue
// монтирует компонент. Класс на .overlay-root применился бы ПОСЛЕ старта
// анимации, и fade проигрался бы даже при animations: false.
//
// Порядок обязателен: сначала классы на <html>, потом payload — иначе
// компонент смонтируется со старой темой на кадр.
function applyPayload(msg: OverlayPayload): void {
  const html = document.documentElement
  html.dataset.theme = msg.theme
  html.classList.toggle('no-anim', msg.animations === false)
  // error сбрасываем в обе стороны: сессия может прийти с пустой моделью
  // (тогда показываем ошибку), а может сменить валидную на невалидную.
  error.value = msg.model ? '' : 'Empty overlay model.'
  payload.value = msg
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

onMounted(() => {
  // Парковка: main уводит окно и просит убрать содержимое из рендера.
  // Прозрачности и увода за экран НЕДОСТАТОЧНО: на Linux с несколькими
  // мониторами координаты клампятся в рабочую область, и оверлей оказывается
  // видимым на соседнем мониторе. Пустой DOM не виден нигде, поэтому
  // содержимое убираем через v-if — это основная защита, а не setOpacity.
  //
  // При снятии парковки (false) подтверждаем main, что кадр реально
  // отдан: один requestAnimationFrame после nextTick. Main держит окно
  // прозрачным до этого сигнала — иначе между setOpacity(1) и отрисовкой
  // нового содержимого пользователь увидит вспышку предыдущего меню.
  //
  // Раньше здесь стояло два rAF подряд. Второй давал +16.7 мс к каждому
  // открытию. Один rAF достаточен, потому что при парковке контент
  // РАЗМОНТИРОВАН через v-if: окно пустое и прозрачное, показывать нечего.
  window.overlayAPI?.onContentUnmounted?.((unmounted: boolean) => {
    contentUnmounted.value = unmounted
    if (unmounted) return
    // Пока содержимое размонтировано, измерять нечего — и нечего
    // сообщать: в main нет сессии с живым содержимым.
    observer?.disconnect()
    const sessionId = payload.value?.sessionId
    if (sessionId === undefined) return
    void nextTick(() => {
      // Наблюдатель — после того, как Vue снял v-if и элемент
      // поверхности появился в DOM. Раньше он ставился по факту push,
      // когда контента ещё не было: измерение возвращало 0, и окно
      // оставалось с запасным размером до следующего изменения.
      // Для окна у края экрана это значит мигание содержимого,
      // потому что размер менялся на кадр позже, чем стал виден.
      watchSurface()
      requestAnimationFrame(() => {
        window.overlayAPI?.painted(sessionId)
      })
    })
  })

  // Данные приходят через overlay:push. Страница загружена один раз и
  // больше не перезагружается, поэтому путь единственный — в отличие от
  // прежнего кода, где dev шёл через hashchange, а prod через полный
  // reload с разбором payload при монтировании.
  //
  // Ошибку в payload показываем только если main прислал пустую модель.
  // Отсутствие сессии на старте — норма (окно прогрето и ждёт), ошибкой
  // это не считается.
  // Тело обработчика вынесено в функцию, а не осталось в анонимной

  window.overlayAPI?.onPush?.((msg: OverlayPayload) => {
    // Запоздалый push от устаревшей сессии игнорируем. Окно из пула
    // одно, и main шлёт данные прямо в него: если сессия успела смениться
    // между отправкой и доставкой, на экране оказались бы пункты
    // предыдущего меню. Токен приходит в каждом push, поэтому сверка
    // точная.
    const current = payload.value
    if (current && current.sessionId > msg.sessionId) {
      window.overlayAPI?.trace(
        `STALE, dropped push: got ${msg.sessionId}, current ${current.sessionId}`
      )
      return
    }

    applyPayload(msg)
    // Наблюдатель пересоздаётся здесь, а не в onMounted: содержимое
    // сменилось, и старый наблюдатель смотрит на уже размонтированный узел.
    // Измерять здесь рано: содержимое ещё размонтировано (v-if стоит
    // на !contentUnmounted), элемента поверхности нет, и измерение
    // вернёт пустоту. Наблюдатель ставится после снятия парковки —
    // см. onContentUnmounted ниже.
    observer?.disconnect()
    observer = null
    traceAnimations(`push sessionId=${msg.sessionId}`)
  })

  // Точечные патчи живой сессии: счётчик поиска, ошибка валидации иконки.
  //
  // Патч МЕРДЖИТСЯ в текущую модель, а не заменяет её: пришёл счётчик —
  // значит view, тема и запрос остаются прежними. Замена целиком означала бы,
  // что каждый счётчик тащит всю сессию, и преимущество канала над push
  // исчезает.
  //
  // Раньше те же значения слались через executeJavaScript с querySelector по
  // .find-count и .dialog-error. Счётчик и ошибка не жили в модели, приходили
  // из main готовыми строками, и разметка с данными расходились при любом
  // переименовании класса. Теперь это поля модели, и изменить их иначе, чем
  // через патч, нельзя.
  window.overlayAPI?.onUpdate?.((msg: OverlayUpdate) => {
    const current = payload.value
    if (!current) return
    // Патч от устаревшей сессии отбрасываем: окно из пула у всех сессий
    // одно, и без сверки токена счётчик от прошлого поиска появился бы в
    // текуном.
    if (current.sessionId !== msg.sessionId) {
      window.overlayAPI?.trace(
        `STALE, dropped update: got ${msg.sessionId}, current ${current.sessionId}`
      )
      return
    }
    payload.value = {
      ...current,
      model: mergePatch(current.model, msg.patch)
    }
  })
})

// Токен сессии, для которой отправляется команда.
//
// Именно ТЕКУЩИЙ, а не тот, что пришёл с последним push: между кликом и
// ответом сессия могла смениться, и команда с новым токеном была бы
// отвергнута как запоздалая. С другой стороны, и со старым токеном команда
// бессмысленна — она относится к содержимому, которого на экране уже
// нет. Поэтому шлём текущий и полагаемся на main: он отсечёт команду, если
// её сессия уже не активна.

// Измерение содержимого — единственный источник правды по размеру.
//
// До шага 6 main считал высоту меню формулой MENU_PAD + N * MENU_ITEM_H,
// где MENU_ITEM_H = 40 не имело никакого отношения к CSS: пункт в
// реальности занимал 46 px (padding 9+9, строка 14, border 1), и каждый
// пункт съедал 6 px. Меню вкладки получало ~120 px пустоты внизу окна, а
// длинное название группы обрезалось по формуле, а не по содержимому.
//
// Теперь размер снимается с реального DOM. ResizeObserver, а не
// один замер на кадре: высота меняется при смене количества пунктов,
// при переносе длинного названия и при смене шрифта в системе.
//
// Отправляем bounding box ПЕРВОГО дочернего элемента, а не .overlay-root:
// корень растянут на 100vw x 100vh и меряет размеры ОКНА, а не
// содержимого. Размер окна main знает и без нас — это замкнутый круг,
// из-за которого размер никогда бы не сошёлся.
let lastSent = { w: 0, h: 0 }
let observer: ResizeObserver | null = null

function measureContent(): void {
  const sessionId = payload.value?.sessionId
  if (sessionId === undefined) return
  const root = document.querySelector<HTMLElement>('.overlay-root.live')
  // Первый дочерний элемент — сама поверхность (меню, диалог, тост).
  // Пока его нет, мерять нечего: размер нулевой, и отправка в main
  // схлопнула бы окно.
  const surface = root?.firstElementChild as HTMLElement | null
  if (!surface) return
  const rect = surface.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  // Округляем до целых: дробные пиксели не дают ничего, а в лог
  // попадают значения, которые не с чем сравнить.
  const w = Math.ceil(rect.width)
  const h = Math.ceil(rect.height)
  if (w === lastSent.w && h === lastSent.h) return
  lastSent = { w, h }
  window.overlayAPI?.measure({ sessionId, width: w, height: h })
}

// Наблюдатель пересоздаётся на каждую сессию: элемент поверхности
// меняется при смене view (меню -> диалог), и старый наблюдатель
// остался бы смотать прошлый узел.
function watchSurface(): void {
  observer?.disconnect()
  observer = null
  lastSent = { w: 0, h: 0 }
  const root = document.querySelector<HTMLElement>('.overlay-root.live')
  const surface = root?.firstElementChild
  if (!surface) return
  observer = new ResizeObserver(() => measureContent())
  observer.observe(surface)
  // Первый замер сразу: ResizeObserver срабатывает асинхронно, а main
  // ждёт размер для первого кадра.
  measureContent()
}

function currentSessionId(): number | undefined {
  return payload.value?.sessionId
}

async function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) await window.overlayAPI.dismiss(currentSessionId())
}

async function onSelect(id: string) {
  await window.overlayAPI.select(id, currentSessionId())
}

async function onSubmit(value: string) {
  await window.overlayAPI.submit(value, currentSessionId())
}
</script>

<template>
  <div
    class="overlay-root"
    :class="{ 'align-start': payload?.anchorLeft, live: !contentUnmounted }"
    @mousedown="onBackdrop">
    <!-- contentUnmounted: содержимое убрано из рендера полностью. Это
         основная защита от «мусорного» оверлея: окно может оказаться в
         любой точке экрана, но пустой DOM не виден нигде.
         Прозрачности окна для этого недостаточно. -->
    <template v-if="!contentUnmounted">
      <div v-if="error" class="overlay-error">{{ error }}</div>
      <BrowserMenu
        v-else-if="payload?.model.view === 'menu'"
        :items="payload.model.items ?? []"
        :incognito="payload.model.badge === 'incognito'"
        :align="payload.anchorLeft ? 'start' : 'end'"
        @select="onSelect"
      />
      <ToastStack
        v-else-if="payload?.model.view === 'toast' && payload.model.toast"
        :toast="payload.model.toast"
        :session-id="payload.sessionId"
      />
      <PromptDialog
        v-else-if="payload?.model.view === 'dialog' && payload.model.dialog"
        :dialog="payload.model.dialog"
        :session-id="payload.sessionId"
        @submit="onSubmit"
      />
      <IconDialog
        v-else-if="payload?.model.view === 'icon' && payload.model.icon"
        :icon="payload.model.icon"
        :session-id="payload.sessionId"
      />
      <FindBar
        v-else-if="payload?.model.view === 'find'"
        :initial="payload.model.find?.query ?? ''"
        :counter="payload.model.find?.counter ?? ''"
        :session-id="payload.sessionId"
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
