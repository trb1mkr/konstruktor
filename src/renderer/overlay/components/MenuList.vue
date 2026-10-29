<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import type { MenuDisplay, MenuItem } from '../../../shared/overlay-types'
// Самоссылка: боковая панель — тот же список, отрисованный вложенно.
// Импорт из своего файла разрешён Vue и нужен vue-tsc: неявная
// самоссылка по имени файла в шаблоне компилятором TS не видна.
import MenuList from './MenuList.vue'

// Список пунктов меню: единственная реализация для всех меню приложения
// (вкладки, группы, панель, меню браузера).
//
// Почему отдельный компонент, а не продолжение BrowserMenu: сейчас в
// проекте четыре меню, и каждое — своя копия вёрстки пункта. Клавиатурной
// навигации не было НИ В ОДНОМ из них: ни стрелок, ни Enter, ни Escape
// на уровне списка. Приёмка шага 7 требует «работает везде», а «везде»
// означает одно место в коде, а не четыре.
//
// Навигация реализована на roving tabindex, а не на tabindex по каждому
// пункту: иначе Tab перебирал бы все пункты подряд, и меню в двадцать
// пунктов требовало бы двадцати нажатий, чтобы уйти из него.

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    /** Активный индекс; -1 = ни один. */
    modelValue?: number
    /**
     * Видимость частей пункта: иконка, текст, подпись хоткея. Приходит из
     * push (настройка пользователя) и ОДНА на все меню приложения —
     * поэтому правило живёт здесь, в единственной вёрстке пункта, а не в
     * каждом меню отдельно.
     *
     * Дефолт — всё видно: так выглядит меню до первого push и так же
     * выглядят дефолты настроек.
     */
    display?: MenuDisplay
    /**
     * Брать ли фокус при монтировании.
     *
     * false нужно боковой панели: она монтируется от НАВЕДЕНИЯ и не должна
     * уводить фокус — иначе наведение мышью отбирало бы клавиатуру у
     * родительского меню.
     */
    autofocus?: boolean
    /**
     * Выравнивание родительского меню относительно якоря.
     *
     * От него зависит сторона боковой панели: у меню, прижатого правым
     * краем к кнопке ('end'), панель растёт ВЛЕВО — тогда карточка меню
     * остаётся на месте, а окно расширяется в свободную сторону. Для
     * меню от левого края ('start') — вправо, по той же причине.
     */
    align?: 'start' | 'end'
  }>(),
  {
    modelValue: -1,
    autofocus: true,
    align: 'end',
    display: () => ({ icons: true, labels: true, hotkeys: true, hotkeysOnHover: false }),
  },
)

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'update:modelValue', index: number): void
  /** Просьба вернуться на уровень выше (стрелка влево в боковой панели). */
  (e: 'back'): void
}>()

// Активный пункт. Локальное состояние, а не только проп: меню
// открывается без фокуса на конкретном пункте, и первый пункт должен
// подсветиться сразу, чтобы пользователь видел, куда поедет Enter.
const active = ref(props.modelValue >= 0 ? props.modelValue : 0)

// Пункты, на которые можно попасть: disabled пропускаются. Без этого
// стрелка вставала бы на неактивный пункт и Enter ничего не делал.
const selectable = computed(() =>
  props.items
    .map((item, index) => (item.disabled || item.separator ? -1 : index))
    .filter((i) => i >= 0),
)

// Ширина карточки по схеме отображения.
//
// Считается здесь, а не в main: единственный источник правды по размеру —
// измерение содержимого, CSS задаёт реальную ширину карточки, а main
// (geometry.ts) только клампит измеренное в свой потолок. Поэтому потолок
// в main поднят под самый широкий режим, а пол и разброс задаёт CSS.
//
// Три схемы:
//   - icons: нет текста и нет подписей — карточка по размеру эмодзи (~50 px);
//   - hotkeys: нет текста, подписи есть — компактная по содержимому, иконка
//     и подпись стоят рядом (распорка-текст скрыта, см. --no-label);
//   - wide: текст и подписи — шире обычного, подписи встают столбцом справа;
//   - default: иначе — обычная.
//
// «Подписи есть» = подпись есть ХОТЬ У ОДНОГО пункта ЭТОГО меню: у меню без
// хоткеев расширяться незачем.
const widthMode = computed(() => {
  const hasHotkeys =
    props.display.hotkeys && props.items.some((item) => !item.separator && item.hotkey)
  // Кнопка-действие расширяет карточку так же, как подпись хоткея: она
  // стоит справа от текста и своей шириной сдвигала бы подпись длинного
  // пункта, если бы карточка считалась только по хоткеям.
  const hasAction = props.items.some((item) => !item.separator && item.actionIcon)
  if (props.display.labels) return hasHotkeys || hasAction ? 'wide' : 'default'
  return hasHotkeys || hasAction ? 'hotkeys' : 'icons'
})

function step(delta: number): void {
  if (selectable.value.length === 0) return
  const currentPos = selectable.value.indexOf(active.value)
  // С активного пункта, которого больше нет (список сменился), стартуем
  // с начала — иначе indexOf вернул бы -1 и шаг вёл бы в никуда.
  const from = currentPos < 0 ? 0 : currentPos
  const nextPos = (from + delta + selectable.value.length) % selectable.value.length
  const nextIndex = selectable.value[nextPos]
  if (nextIndex === undefined) return
  active.value = nextIndex
  emit('update:modelValue', nextIndex)
  void scrollActiveIntoView()
}

function toStart(): void {
  const first = selectable.value[0]
  if (first === undefined) return
  active.value = first
  emit('update:modelValue', first)
  void scrollActiveIntoView()
}

function toEnd(): void {
  const last = selectable.value[selectable.value.length - 1]
  if (last === undefined) return
  active.value = last
  emit('update:modelValue', last)
  void scrollActiveIntoView()
}

// Активный пункт должен быть виден: меню в двадцать пунктов не помещается
// в окно, и без прокрутки стрелка уводила бы подсветку за нижний край.
function scrollActiveIntoView(): Promise<void> {
  return nextTick(() => {
    // Поиск внутри СВОЕГО списка: при открытой боковой панели в документе
    // два списка, и глобальный селектор нашёл бы подсветку чужого.
    const el = root.value?.querySelector<HTMLElement>('.menu-item--active')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function activate(index: number): void {
  const item = props.items[index]
  if (!item || item.disabled) return
  // Пункт с подпунктами не выбирается, а раскрывает боковую панель: выбор
  // ушёл бы в main, и подменю не было бы видно вообще.
  if (hasChildren(item)) {
    openFlyout(index)
    return
  }
  emit('select', item.id)
}

// Наведение мышью переводит выбор на пункт: подсветка показывает, что
// пункт нажимается. У строки-справки (plain) нажимается только кнопка
// справа, поэтому наведение НЕ делает её активной — иначе имя разрешения
// подсвечивалось бы как кнопка, а это текст.
//
// Здесь же открывается и закрывается боковая панель: она следует за
// наведением, как в системных меню. Наведение на пункт БЕЗ подпунктов
// закрывает её — иначе панель висела бы над соседними пунктами.
function onEnter(index: number, item: MenuItem): void {
  if (item.plain) return
  if (active.value !== index) active.value = index
  if (hasChildren(item)) openFlyout(index)
  else closeFlyout()
}

// Клик по строке. Строку-справку не нажимаем: единственное её действие
// живёт в кнопке-корзине, а выбор строки в логе выглядел бы как выбор
// пункта меню — то есть как другой действие.
function onClick(index: number, item: MenuItem): void {
  if (item.plain) return
  // Пункт с подпунктами: клик раскрывает панель, а не выбирает пункт.
  if (hasChildren(item)) {
    openFlyout(index)
    return
  }
  activate(index)
}

// Первая буква переходит к следующему пункту, начинающемуся с неё —
// как в обычных меню. Приёмка не требовала, но без неё список из
// двадцати пунктов просматривается только стрелками.
function onKey(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowRight': {
      const item = props.items[active.value]
      if (!hasChildren(item)) return
      e.preventDefault()
      openFlyout(active.value)
      // Фокус переезжает в панель: иначе ArrowRight пришлось бы нажимать
      // дважды — стрелки навигации работают у того списка, который в фокусе.
      void nextTick(() => flyoutRef.value?.focusFirst())
      return
    }
    case 'ArrowLeft':
      // Панель открыта — закрываем её и возвращаемся в список. Если панели
      // нет, стрелка означает «назад» для того, кто открыл ЭТОТ список
      // (боковая панель в родителе — так же).
      e.preventDefault()
      if (flyoutIndex.value !== null) closeFlyout()
      else emit('back')
      return
    case 'ArrowDown':
      e.preventDefault()
      step(1)
      return
    case 'ArrowUp':
      e.preventDefault()
      step(-1)
      return
    case 'Home':
      e.preventDefault()
      toStart()
      return
    case 'End':
      e.preventDefault()
      toEnd()
      return
    case 'Enter':
      e.preventDefault()
      activate(active.value)
      return
    case ' ':
      // Пробел: только если фокус не в текстовом поле. Иначе он
      // вставил бы пробел в поле ввода диалога.
      if (e.target instanceof HTMLInputElement) return
      e.preventDefault()
      activate(active.value)
      return
    default:
    // Ничего не делаем: Escape ловится на родителе окна, он должен
    // работать и когда фокус в списке.
  }
}

// Типобезопасность: onKey назначается на элемент, но в <script setup>
// компилятор не связывает это с DOM-событием.
const onKeydown = (e: KeyboardEvent): void => onKey(e)

// Фокус в DOM, а не только в окне.
//
// main вызывает win.focus() при показе меню, и этого НЕДОСТАТОЧНО: фокус
// получает окно, а не элемент внутри него. Событие keydown приходит в
// document, до .menu-list не доходит, и навигация молчала. Клик по меню
// работал потому, что он целился в сам список и ставил фокус на элемент —
// то есть фокус давал клик, а не открытие.
//
// autofocus через атрибут не годится: он срабатывает при загрузке
// страницы оверлея, когда меню ещё нет, и повторно не срабатывает.
const root = ref<HTMLElement | null>(null)

// --- Боковая панель подпунктов -----------------------------------------
//
// Пункт с `children` открывает подменю СБОКУ, как «История» в Яндекс.Браузере:
// по наведению, по Enter и по клику. Панель живёт в том же окне оверлея и
// является вторым ребёнком карточки-обёртки (display: flex): тогда высота и
// ШИРИНА окна считаются по обоим карточкам, и панель не срезается кромкой.
//
// Абсолютное позиционирование здесь не годится ровно поэтому: вылетающий за
// карточку блок не входит в getBoundingClientRect родителя, окно осталось бы
// узким, и панель была бы обрезана.
const flyoutIndex = ref<number | null>(null)
const flyoutTop = ref(0)
const flyoutRef = ref<InstanceType<typeof MenuList> | null>(null)

const flyoutItems = computed(() => {
  if (flyoutIndex.value === null) return []
  return props.items[flyoutIndex.value]?.children ?? []
})

const flyoutSide = computed(() => (props.align === 'start' ? 'right' : 'left'))

// Пока панель открыта, уровень НЕ ограничен шириной окна.
//
// `.overlay-level` стоит `max-width: 100%`: карточка не должна вылезать за
// окно, посчитанное по прошлому замеру. Но именно эту границу панель и
// обязана пересечь — иначе замер видит ширину, равную окну, окно ждёт
// замера, и панель остаётся сжатой в полоску (замерено: 256 px при нужных
// 515). Класс ставится на <html>, потому что правило живёт в общем
// overlay.css, а уровень — не наш элемент.
watch(
  () => flyoutItems.value.length,
  (count) => document.documentElement.classList.toggle('overlay-flyout', count > 0)
)
onUnmounted(() => document.documentElement.classList.remove('overlay-flyout'))

function hasChildren(item: MenuItem | undefined): boolean {
  return !!item?.children && item.children.length > 0
}

function openFlyout(index: number): void {
  const item = props.items[index]
  if (!hasChildren(item)) return
  // Смещение пункта внутри списка: панель встаёт на уровень своего пункта.
  // Минус отступ списка — иначе первая строка панели была бы ниже первой
  // строки пункта на высоту верхнего поля карточки.
  const el = root.value?.children[index] as HTMLElement | undefined
  flyoutTop.value = Math.max(0, (el?.offsetTop ?? 0) - 6)
  flyoutIndex.value = index
}

function closeFlyout(): void {
  flyoutIndex.value = null
}

function onFlyoutSelect(id: string): void {
  emit('select', id)
}

// Стрелка влево в самой панели: назад к родительскому меню, а не закрытие
// всего оверлея. Фокус возвращается списку — иначе следующая стрелка
// ушла бы в никуда.
function backToParent(): void {
  closeFlyout()
  void nextTick(() => root.value?.focus())
}

onMounted(() => {
  // Боковая панель не забирает фокус: она появляется от наведения мыши.
  if (props.autofocus === false) return
  root.value?.focus()
  toStart()
})

defineExpose({ focusFirst: toStart })
</script>

<template>
  <!-- Обёртка из двух карточек: боковая панель и само меню. Flex, а не
       абсолютное позиционирование: размер окна оверлея снимается с этого
       контейнера, и только flex-сосед добавляет панели ширину. -->
  <div
    class="menu-frame"
    :class="{ 'menu-frame--right': flyoutSide === 'right' }"
    @mouseleave="closeFlyout"
  >
    <MenuList
      v-if="flyoutItems.length"
      ref="flyoutRef"
      class="menu-flyout"
      :style="{ marginTop: flyoutTop + 'px' }"
      :items="flyoutItems"
      :display="display"
      :autofocus="false"
      :align="align"
      @select="onFlyoutSelect"
      @back="backToParent"
    />
    <div
      ref="root"
      class="menu-list"
      :class="{
        'menu-list--icons': widthMode === 'icons',
        'menu-list--hotkeys': widthMode === 'hotkeys',
        'menu-list--wide': widthMode === 'wide',
        'menu-list--no-label': !display.labels,
      }"
      role="menu"
      tabindex="0"
      @keydown="onKeydown"
      @mousedown.stop
    >
      <template v-for="(item, index) in items" :key="item.id">
        <div v-if="item.separator" class="menu-separator" role="separator" />
        <!-- Строка-справка (item.plain) — div, а не button: её действие
             живёт в отдельной кнопке справа, а кнопка в кнопке невалидна.
             Стрелками строка по-прежнему выбирается, и Enter выполняет то
             же, что корзина: иначе снять решение с клавиатуры было бы
             нечем — мышь целится в кнопку, клавиатура в строку. -->
        <component
          :is="item.plain ? 'div' : 'button'"
          v-else
          class="menu-item"
          :class="{
            'menu-item--active': index === active,
            'menu-item--heading': item.heading,
            'menu-item--plain': item.plain,
            'menu-item--submenu': hasChildren(item),
          }"
          role="menuitem"
          :disabled="item.plain ? undefined : item.disabled"
          :tabindex="index === active ? 0 : -1"
          @click="onClick(index, item)"
          @mouseenter="onEnter(index, item)"
        >
          <span v-if="display.icons" class="menu-icon">
            <span v-if="item.color" class="menu-dot" :style="{ background: item.color }" />
            <template v-if="item.icon">{{ item.icon }}</template>
          </span>
          <!-- Текст всегда в растущем span, даже когда скрыт: он раздвигает
               пункт и прижимает хоткей к правому краю. Без него подпись
               хоткея встала бы вплотную к иконке. -->
          <span class="menu-label">{{ display.labels ? item.label : '' }}</span>
          <!-- Кнопка-действие справа (🗑️ у разрешений). У строки-справки это
               настоящая кнопка (родитель — div), у обычного пункта — span
               с role=button: вложенная в кнопку кнопка была бы невалидной
               разметкой. Клик гасим (stop), чтобы он не считался выбором
               пункта. -->
          <component
            :is="item.plain ? 'button' : 'span'"
            v-if="item.actionIcon"
            class="menu-action"
            :type="item.plain ? 'button' : undefined"
            :role="item.plain ? undefined : 'button'"
            :title="item.actionTitle ?? ''"
            @click.stop="emit('select', item.id)"
            >{{ item.actionIcon }}</component
          >
          <!-- Стрелка у пункта с подпунктами: без неё пользователь не знает,
               что за пунктом есть второй уровень, и ждёт действия по клику. -->
          <span v-if="hasChildren(item)" class="menu-arrow" aria-hidden="true">›</span>
          <span
            v-if="display.hotkeys && item.hotkey"
            class="menu-hotkey"
            :class="{ 'menu-hotkey--hover': display.hotkeysOnHover }"
            >{{ item.hotkey }}</span
          >
        </component>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Контейнер уровня: карточка меню и, если пункт раскрыт, боковая панель.
   Flex обязателен: ширина окна оверлея снимается с этого контейнера, и
   только сосед в потоке добавляет панели место. Абсолютно
   спозиционированная панель не вошла бы в getBoundingClientRect и была
   бы срезана краем окна. */
.menu-frame {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
/* Меню от левого края ('start'): панель справа раскрывается в свободную
   сторону. row-reverse ставит список первым по видимому порядку. */
.menu-frame--right {
  flex-direction: row-reverse;
}
/* Боковая панель — такая же карточка, как меню: своя рамка, радиус и
   тень. Тень отделяет её от карточки меню, иначе две рамки вплотную
   читаются как одна сломанная. */
.menu-flyout {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}
.menu-list {
  min-width: 220px;
  max-width: 320px;
  background: var(--ov-bg);
  border: 1px solid var(--ov-border);
  border-radius: 12px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Список получает фокус, чтобы работали стрелки: оверлей открыт через
     showInactive() и сам фокуса не забирает. Показываем фокус только
     с клавиатуры — иначе рамка мигает при каждом открытии меню. */
  outline: none;
}
.menu-list:focus-visible {
  outline: 1px solid var(--ov-border);
}
/* Стрелка пункта с подпунктами. Прижата вправо, как в системных меню:
   она показывает направление раскрытия, а не украшает пункт. */
.menu-arrow {
  flex-shrink: 0;
  color: var(--ov-dim, #888);
  font-size: 15px;
  line-height: 1;
}
/* Шеврон у пункта с подпунктами занимает место подписи хоткея, поэтому
   когда есть и то, и другое, они стоят рядом — стрелка левее подписи. */
/* Текст выключен: распорка .menu-label убирается совсем. Это главное для
   соседних режимов (см. ниже) — пустая распорка с flex:1 раздвигала пункт,
   и между иконкой и хоткеем оставалась дыра во всю ширину карточки. */
.menu-list--no-label .menu-label {
  display: none;
}
/* Только иконки: карточка по размеру эмодзи и отступов, без нижнего пола.
   Пункт центрируется, боковые отступы ужаты — иначе двадцать пикселей под
   иконку получили бы 220. */
.menu-list--icons {
  min-width: 0;
  max-width: 60px;
}
.menu-list--icons .menu-item {
  justify-content: center;
  gap: 0;
  padding-left: 8px;
  padding-right: 8px;
}
/* Иконки + хоткеи без текста: карточка по содержимому, иконка и подпись
   стоят рядом (распорки нет). Ширину задаёт самый длинный пункт, поэтому
   все подписи начинаются на одной вертикали — столбец. */
.menu-list--hotkeys {
  min-width: 0;
  max-width: 320px;
}
/* Без текста отступ хоткея не нужен: он был добавлен к растущему тексту,
   а здесь подпись идёт сразу за иконкой — оставляем только gap пункта. */
.menu-list--no-label .menu-hotkey {
  margin-left: 0;
}
/* Иконка + текст + хоткей: шире обычного, чтобы подписи встали столбцом
   у правого края, а длинное название не переносилось. */
.menu-list--wide {
  min-width: 260px;
  max-width: 480px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: none;
  color: var(--ov-text);
  text-align: left;
  font-size: 14px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.menu-item:hover:not(:disabled):not(.menu-item--plain) {
  background: var(--ov-hover);
}
/* Активный пункт держит подсветку и без наведения мыши: при навигации
   стрелками курсор стоит в стороне, иначе активный пункт не виден. */
.menu-item--active:not(:disabled) {
  background: var(--ov-hover);
}
.menu-item:disabled {
  color: #666;
  cursor: default;
}
/* Подзаголовок группы: цвет и размер как у обычного пункта. Затемнение
   disabled к заголовку не применяется — на тёмной теме (#666) он читался
   хуже списка, который делит. Правило идёт ПОСЛЕ .menu-item:disabled:
   специфичность у них равная, решает порядок. */
.menu-item--heading:disabled {
  color: var(--ov-text);
}
.menu-item--heading {
  cursor: default;
}
/* Строка-справка: имя разрешения — обычный текст, а не кнопка. Подсветка
   при наведении снята (она обещает клик), курсор обычный. Подсветку
   ВЫБОРА строка сохраняет: стрелки на неё встают, и без неё с клавиатуры
   не видно, где стоишь, а Enter на строке снимает решение.
   Правило идёт ПОСЛЕ :hover — иначе не перебило бы его по специфичности. */
.menu-item--plain {
  cursor: default;
}
/* Разделитель: та же ширина карточки минус внутренние поля, что у пункта,
   иначе линия была бы короче текста и выглядела бы опечаткой. */
.menu-separator {
  height: 1px;
  margin: 4px 10px;
  background: var(--ov-border);
  flex-shrink: 0;
}
.menu-icon {
  width: 20px;
  text-align: center;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.menu-label {
  /* Длинное название группы переносится, а не растягивает меню. */
  overflow-wrap: anywhere;
  min-width: 0;
  /* Растягивается и прижимает хоткей к правому краю пункта. Даже когда
     текст скрыт настройкой, span остаётся распоркой. */
  flex: 1 1 auto;
}
/* Подпись горячей клавиши справа, как в меню Яндекс Браузера. */
.menu-hotkey {
  flex-shrink: 0;
  margin-left: 12px;
  color: var(--ov-faint);
  font-size: 12px;
  /* Табличные цифры и запрет переноса: «Ctrl+Shift+T» — одна подпись,
     а не две строки. */
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.menu-item:disabled .menu-hotkey {
  color: #666;
}
/* Режим «только при наведении/выборе»: подпись проявляется на активном
   пункте. Условие совпадает с подсветкой — курсор мыши ИЛИ выбор
   стрелками (класс active). */
.menu-hotkey--hover {
  opacity: 0;
  transition: opacity 90ms ease;
}
.menu-item:hover:not(:disabled) .menu-hotkey--hover,
.menu-item--active:not(:disabled) .menu-hotkey--hover {
  opacity: 1;
}
.menu-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
/* Кнопка-действие справа: ОТДЕЛЬНАЯ квадратная кнопка рядом с текстом, а
   не часть строки. Квадрат фиксированной величины, а не паддинг по
   тексту: эмодзи в строчном span резался по высоте, и кнопка читалась
   как узкая полоска. Рамка видна всегда — иначе действие читается как
   украшение строки, а не как то, что можно нажать. */
.menu-action {
  flex-shrink: 0;
  margin-left: 8px;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  background: transparent;
  border: 1px solid var(--ov-border);
  border-radius: 6px;
  color: var(--ov-text);
  cursor: pointer;
  font-family: inherit;
  font-size: 15px;
  line-height: 1;
}
.menu-action:hover {
  background: var(--ov-btn-hover);
}
</style>
