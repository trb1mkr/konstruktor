<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { componentFor } from './registry'

// Стек уровней: нижний рисуется первым, верхний — последним и поверх.
//
// Раньше renderer знал об одной модели: приход новой подменял
// старую, и «меню -> Change icon -> диалог» выглядел как смена одного
// окна другим. Теперь renderer получает весь стек и рисует уровни друг
// над другом, а снятие верхнего (Esc) просто убирает последний.
//
// Ключевой момент: уровней в DOM столько же, сколько в стеке, и каждый
// позиционируется по своему offset из сообщения. Окно — объединение
// уровней, поэтому система отсчёта у них одна: левый верхний угол окна.

import type {
  DialogModel,
  FindModel,
  IconModel,
  MenuItem,
  PushMessage,
  StackEntry,
  ToastModel,
  UpdateMessage
} from '../../shared/overlay-types'

// `MenuItem` реэкспортируется: его импортирует BrowserMenu.vue. Экспорт
// из .vue оставлен, чтобы менять потребителей не пришлось.
export type { MenuItem }

/** Модель уровня — плоская: шаблон читает поля напрямую. */
interface OverlayModel {
  view: 'menu' | 'toast' | 'dialog' | 'find' | 'icon' | 'window-menu'
  items?: MenuItem[]
  badge?: string
  toast?: ToastModel
  dialog?: DialogModel
  icon?: IconModel
  find?: FindModel
}

// Один уровень стека, ровно как его прислал main. Форма задана
// контрактом StackEntry, но здесь объявлена отдельно: renderer держит
// уровни в ref и мержит патчи, а контрактный union пришлось бы сузить в
// каждом месте.
interface Level extends Omit<StackEntry, 'model'> {
  model: OverlayModel
}

// То, что приходит из main одним сообщением overlay:push.
interface OverlayPayload {
  // Стек уровней снизу вверх. Токен каждого уровня лежит в нём самом,
  // а не в сообщении: при двух уровнях одно общее поле означало бы,
  // каким оно помечено — верхним или нижним.
  //
  // Токен верхнего уровня работает и подтверждением отрисовки: main держит
  // окно прозрачным, пока renderer не вернёт его через overlay:painted.
  stack: Level[]
  theme: 'dark' | 'light' | 'slate'
  animations: boolean
}

const payload = ref<OverlayPayload | null>(null)

// Верхний уровень — тот, на который приходят команды. Esc и клик мимо
// относятся именно к нему, а не ко всему стеку.
const topLevel = computed<Level | null>(() => {
  const stack = payload.value?.stack
  if (!stack || stack.length === 0) return null
  return stack[stack.length - 1]
})

// Пропы уровня: форма та же, что была для единственной модели, но
// sessionId и anchorLeft берутся из самого уровня, а не из сообщения.
function propsFor(level: Level): Record<string, unknown> | null {
  const model = level.model
  const base = {
    sessionId: level.sessionId,
    anchorLeft: level.anchorLeft
  }
  switch (model.view) {
    case 'menu':
      return {
        ...base,
        items: model.items ?? [],
        incognito: model.badge === 'incognito',
        align: level.anchorLeft ? 'start' : 'end'
      }
    // Меню окна: та же карточка, но без бейджа инкогнито — вкладка и окно
    // не могут быть одновременно инкогнито-вкладкой и обычным окном.
    case 'window-menu':
      return {
        ...base,
        items: model.items ?? [],
        align: level.anchorLeft ? 'start' : 'end'
      }
    case 'toast':
      // Модель может прийти без toast — тогда компонент не рендерим
      // вовсе, а не показываем пустую карточку.
      return model.toast ? { ...base, toast: model.toast } : null
    case 'dialog':
      return model.dialog ? { ...base, dialog: model.dialog } : null
    case 'icon':
      return model.icon ? { ...base, icon: model.icon } : null
    case 'find':
      return {
        ...base,
        initial: model.find?.query ?? '',
        counter: model.find?.counter ?? ''
      }
    default:
      return null
  }
}

const currentComponent = computed(() => {
  const level = topLevel.value
  return level ? componentFor(level.model.view) : null
})

const currentProps = computed(() => {
  const level = topLevel.value
  return level ? propsFor(level) : null
})

// Уровни для отрисовки, снизу вверх. propsFor отдаёт null для модели без
// содержимого (тост без toast) — такой уровень пропускаем, иначе в DOM
// появился бы компонент без данных.
const renderedLevels = computed(() => {
  const stack = payload.value?.stack ?? []
  return stack
    .map((level, index) => ({
      key: level.sessionId,
      index,
      level,
      component: componentFor(level.model.view),
      props: propsFor(level)
    }))
    .filter((entry) => entry.props !== null)
})

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
  error.value = msg.stack && msg.stack.length > 0 ? '' : 'Empty overlay model.'
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
    if (unmounted) {
      // Подтверждаем снятие содержимого — но после того, как Vue реально
      // убрал v-if, а не в том же кадре, когда выставлен флаг. Иначе
      // подтверждение уйдёт раньше, чем DOM очищен, и main начнёт
      // двигать окно, пока старое меню ещё на экране.
      void nextTick(() => {
        window.overlayAPI?.unmounted?.()
      })
      return
    }
    // Пока содержимое размонтировано, измерять нечего — и нечего
    // сообщать: в main нет сессии с живым содержимым.
    observer?.disconnect()
    const sessionId = topLevel.value?.sessionId
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
    //
    // Сверка по ТОКЕНУ ВЕРХНЕГО уровня, а не по всему стеку. Push несёт
    // весь стек, и укороченный стек после Esc имеет меньший верхний токен,
    // чем предыдущий: сравнение «меньше — значит устарел» отбросило бы
    // возврат к меню как позднее сообщение.
    //
    // Сверка устаревших push. Правило НЕ «верхний токен меньше — значит
    // позднее»: снятие верхнего уровня (Esc) укорачивает стек, и у
    // возврата к меню верхний токен МЕНЬШЕ, чем у диалога, который только
    // что показали. Такое сравнение отбрасывало возврат как позднее
    // сообщение — и это зафиксировано в логе:
    //
    //   returned to lower level { popped: 2, depth: 1, kind: 'menu' }
    //   STALE, dropped push: got stack 1, current 1+2
    //
    // Попытка с правилом «укороченный стек — всегда устарел» была хуже:
    // 15 абортов подряд, приложение переставало открывать меню вовсе.
    //
    // Верное правило: токены монотонны, поэтому push, верхний токен
    // которого МЕНЬШЕ текущего, устарел лишь тогда, когда этого токена нет
    // НИГДЕ в текущем стеке. У возврата токен меню в стеке есть, и он
    // устаревшим не является.
    const currentStack = payload.value?.stack
    const incomingTop = msg.stack[msg.stack.length - 1]
    if (currentStack && incomingTop) {
      const currentTop = currentStack[currentStack.length - 1]
      const knownSomewhere = currentStack.some((l) => l.sessionId === incomingTop.sessionId)
      if (!knownSomewhere && incomingTop.sessionId < currentTop.sessionId) {
        window.overlayAPI?.trace(
          `STALE, dropped push: got ${incomingTop.sessionId}, current ` +
            `${currentTop.sessionId} (stack ${msg.stack.map((l) => l.sessionId).join("+")})`
        )
        return
      }
    }

    const wasUnmounted = contentUnmounted.value
    // Прежняя глубина стека: без неё не отличить возврат (стек короче)
    // от обычного открытия (стек той же или большей длины).
    const wasStack = payload.value?.stack ?? []
    applyPayload(msg)
    // Наблюдатель пересоздаётся здесь, а не в onMounted: содержимое
    // сменилось, и старый наблюдатель смотрит на уже размонтированный узел.
    // Измерять здесь рано: содержимое ещё размонтировано (v-if стоит
    // на !contentUnmounted), элемента поверхности нет, и измерение
    // вернёт пустоту. Наблюдатель ставится после снятия парковки —
    // см. onContentUnmounted ниже.
    observer?.disconnect()
    observer = null
    //
    // Возврат по Esc/Cancel НЕ проходит через снятие парковки: окно всё
    // это время показывало стек, contentUnmounted оставался false, и
    // onContentUnmounted не срабатывал. Значит watchSurface (а с ним и
    // focusTopLevel) не вызывался — фокус не возвращался, и клавиатура
    // оставалась мёртвой, хотя меню было кликабельно.
    //
    // Поэтому фокус ставится здесь: после applyPayload вершина уже новая,
    // а следующий кадр — правильное для него место.
    if (!wasUnmounted) {
      // Возврат к нижнему уровню: стек укоротился. Меню пересоберётся и
      // смонтируется заново, и вместе с ним стартует overlay-fade — а
      // возвращение не открытие, и это выглядит как перезагрузка меню.
      const wasDeeper = wasStack.length > msg.stack.length
      if (wasDeeper) suppressAnimationsForFrame()
      void nextTick(() => {
        watchSurface()
      })
    }
    traceAnimations(`push sessionId=${msg.stack.map((l) => l.sessionId).join("+")}`)
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
    //
    // Патч адресован уровню по ЕГО токену, а не верхнему. Патч приходит
    // для того уровня, чья модель меняется: счётчик поиска — верхнего,
    // ошибка валидации иконки — тоже верхнего, но если меню лежит под
    // диалогом и начнёт обновляться, сверка с верхним токеном отбросила
    // бы его патч молча.
    const index = current.stack.findIndex((l) => l.sessionId === msg.sessionId)
    if (index < 0) {
      const topId = current.stack[current.stack.length - 1]?.sessionId
      window.overlayAPI?.trace(
        `STALE, dropped update: got ${msg.sessionId}, top ${topId}`
      )
      return
    }
    const stack = current.stack.slice()
    stack[index] = {
      ...stack[index],
      model: mergePatch(stack[index].model, msg.patch)
    }
    payload.value = { ...current, stack }
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
  const sessionId = topLevel.value?.sessionId
  if (sessionId === undefined) return
  const root = document.querySelector<HTMLElement>('.overlay-root.live')
  // ВЕРХНИЙ уровень, а не первый дочерний: в стеке их несколько, и
  // размер окна задаёт тот, кто сейчас на экране. Нижний лежит под ним,
  // и его размер на окно не влияет.
  const surface = topLevel
    ? (document.querySelector<HTMLElement>('.overlay-level--top') ?? null)
    : (root?.firstElementChild as HTMLElement | null)
  if (!surface) return
  const rect = surface.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  // Размер окна = размер карточки ПЛЮС её поля (margin). Без этого окно
  // вырезалось по габаритам самой карточки, и та прижималась к нижней
  // границе окна. Нижние углы скругления оказывались на самой кромке
  // поверхности и срезались Compositor'ом — меню выглядело с острым
  // нижним углом. Поля не входят в getBoundingClientRect, поэтому
  // прибавляем их явно.
  const style = getComputedStyle(surface)
  const mx = parseFloat(style.marginLeft) + parseFloat(style.marginRight)
  const my = parseFloat(style.marginTop) + parseFloat(style.marginBottom)
  // Округляем до целых: дробные пиксели не дают ничего, а в лог
  // попадают значения, которые не с чем сравнить. Округление вверх, а
  // не вниз: округление вниз срезало бы ту же границу.
  const w = Math.ceil(rect.width + mx)
  const h = Math.ceil(rect.height + my)
  if (w === lastSent.w && h === lastSent.h) return
  lastSent = { w, h }
  window.overlayAPI?.measure({ sessionId, width: w, height: h })
}

// Наблюдатель пересоздаётся на каждую сессию: элемент поверхности
// меняется при смене view (меню -> диалог), и старый наблюдатель
// остался бы смотать прошлый узел.
/**
 * Ставит фокус на элемент верхнего уровня, если он есть и сам себя не
 * имеет.
 *
 * Окно уже в фокусе (focus() из main), но обработчик клавиатуры висит на
 * элементе внутри renderer. Фокус на окне для него — то же, что фокуса
 * нет: keydown приходит в document и до обработчика не доходит.
 *
 * Проверка activeElement нужна, потому что вызывается дважды: если фокус
 * уже на списке, второй вызов перевёл бы его на сам элемент и сбросил
 * подсветку активного пункта.
 */
function focusTopLevel(): void {
  const level = document.querySelector<HTMLElement>('.overlay-level--top')
  if (!level) return
  const focusable = level.querySelector<HTMLElement>('[tabindex], button, input')
  if (!focusable || focusable === document.activeElement) return
  focusable.focus()
}

function watchSurface(): void {
  observer?.disconnect()
  observer = null
  lastSent = { w: 0, h: 0 }
  const root = document.querySelector<HTMLElement>('.overlay-root.live')
  // Наблюдатель на верхнем уровне — том, чей размер влияет на окно.
  // При смене стека (Esc снял диалог) вершина меняется, и наблюдатель
  // пересоздаётся вместе с ней.
  const surface = topLevel
    ? (document.querySelector<HTMLElement>('.overlay-level--top') ?? null)
    : (root?.firstElementChild as HTMLElement | null)
  if (!surface) return
  observer = new ResizeObserver(() => measureContent())
  observer.observe(surface)
  // Фокус на элемент верхнего уровня.
  //
  // После снятия верхнего уровня (Esc, Cancel, клик по подложке) вершина
  // ПЕРЕСОБИРАЕТСЯ: Vue размонтирует диалог и монтирует меню заново.
  // Фокус, поставленный при прошлом mount, уехал вместе с диалогом, а
  // focus() из main приходит уже после и уводит фокус на ОКНО — где
  // keydown не ловится, потому что обработчик висит на элементе списка.
  //
  // Отсюда был симптом: меню кликабельно, стрелки не работают. Ставим
  // фокус сами, после mount вершины, и повторяем на следующем кадре —
  // focus() из main может отработать позже нашего вызова.
  focusTopLevel()
  requestAnimationFrame(() => focusTopLevel())

  // Первый замер сразу: ResizeObserver срабатывает асинхронно, а main
  // ждёт размер для первого кадра.
  measureContent()
}


/**
 * Подавляет анимацию появления на ОДИН кадр.
 *
 * Нужно при возврате к нижнему уровню (Esc, Cancel, клик по подложке):
 * вершина пересобирается, Vue монтирует меню заново, и вместе с ним
 * стартует overlay-fade. Возврат — не открытие, и моргание здесь выглядит
 * как перезагрузка меню.
 *
 * Подавление локальное намеренно. Вариант «слать push с animations: false»
 * залипает: no-anim висит на <html> до следующего сообщения, и если оно
 * не дойдёт, анимации выключатся навсегда. Здесь класс снимается на
 * следующем кадре, и второе сообщение не нужно.
 */
function suppressAnimationsForFrame(): void {
  const html = document.documentElement
  if (html.classList.contains('no-anim')) return
  html.classList.add('no-anim')
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      html.classList.remove('no-anim')
    })
  })
}

function currentSessionId(): number | undefined {
  return topLevel.value?.sessionId
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
    :class="{ 'align-start': topLevel?.anchorLeft, live: !contentUnmounted }"
    @mousedown="onBackdrop">
    <!-- contentUnmounted: содержимое убрано из рендера полностью. Это
         основная защита от «мусорного» оверлея: окно может оказаться в
         любой точке экрана, но пустой DOM не виден нигде.
         Прозрачности окна для этого недостаточно. -->
    <template v-if="!contentUnmounted">
      <div v-if="error" class="overlay-error">{{ error }}</div>
      <!--
           Стек уровней, снизу вверх. Каждый уровень позиционируется по
           своему offset из сообщения: окно — объединение уровней, и
           система отсчёта у них одна (левый верхний угол окна).

           Порядок важен как для отрисовки, так и для кликов: верхний
           уровень идёт последним, поэтому лежит поверх и ловит мышь
           первым. Нижний (меню под диалогом) остаётся видимым, но кликнуть
           его нельзя — это правильно: пока открыт диалог, меню не должно
           принимать выбор.

           v-for по уровням вместо одного <component :is> — тот рисовал
           бы ровно один компонент, то есть верхний.
      -->
      <div
        v-for="entry in renderedLevels"
        :key="entry.key"
        class="overlay-level"
        :class="{ 'overlay-level--top': entry.level.sessionId === topLevel?.sessionId }"
        :style="{
          left: entry.level.offset.x + 'px',
          top: entry.level.offset.y + 'px'
        }"
      >
        <component
          :is="entry.component"
          v-bind="entry.props"
          @select="onSelect"
          @submit="onSubmit"
        />
      </div>
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
/* Уровень стека. Позиционируется по offset из сообщения: окно
   — объединение уровней, поэтому координаты уровня задаются относительно
   левого верхнего угла ОКНА, а не родительского окна браузера.

   Размер ЗАДАЁТСЯ СОДЕРЖИМОМ, и это не стилистика, а условие работы шага 6.
   Рамка уровня обтекает карточку, а ResizeObserver (единственный источник
   правды по размеру) наблюдает именно рамку. Если задать ей width/height
   из сообщения, рамка станет ровно той же, что и запасной размер, и
   наблюдатель перестанет срабатывать: main не получит измерение, окно
   останется запасным, и меню будет выглядеть пустым снизу.

   Ширину/высоту из сообщения поэтому НЕ применяем. */
.overlay-level {
  position: absolute;
  /* Ширина не задаётся: без неё рамка обтекает карточку, и длинное
     название группы переносится по содержимому, а не растягивает
     уровень. Иначе подпись уезжала бы за край окна, посчитанного main
     по предыдущему замеру. */
  width: max-content;
  max-width: 100%;
  /* Нижние уровни не принимают мышь: пока открыт верхний (диалог),
     кликнуть лежащее под ним меню нельзя. */
  pointer-events: none;
}
.overlay-level--top {
  pointer-events: auto;
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
