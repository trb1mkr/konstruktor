import { screen } from 'electron'
import type { Rectangle } from 'electron'
import type { Surface, SurfaceAlign, ViewKind } from '../../shared/overlay-types'
import { log } from './logger'

// Геометрия оверлея: размеры поверхностей и кламп по экрану.
//
// До этого шага всё считалось в service.ts константами и цепочками
// тернарников. Цена выросла в bugs, а не в строках:
//
//   - высота меню считалась как MENU_PAD + N * MENU_ITEM_H, где
//     MENU_ITEM_H = 40 — число, никак не связанное с CSS. Меню в реальности
//     занимало 46 px на пункт (padding 9px сверху и снизу + строка 14px +
//     border 1px), и каждый пункт «съедал» 6 px. Для меню вкладки это
//     120 px пустоты внизу окна;
//   - клампа по экрану не было вовсе: x/y только зажимались в границы
//     родителя, поэтому меню у правого края экрана уезжало за него;
//   - «разворот» при нехватке места справа (align-end) делался вычитанием
//     магического `width - 40` — это не разворот, а сдвиг на 220 px.

/** Поверхность: как считать размеры и где ставить окно. */
export interface SurfaceSpec {
  /** Ширина окна: при sizing 'fixed' — сама ширина, при 'content' — потолок. */
  width: number
  /**
   * Чем задаётся ширина окна.
   *
   *  - 'content' — измеренным содержимым (в пределах `width`): окно равно
   *    карточке, и её правый край совпадает с краем окна;
   *  - 'fixed' — замыслом: окно остаётся заданной ширины, а измерение
   *    уточняет только высоту.
   */
  sizing: 'content' | 'fixed'
  /**
   * Нижняя граница ширины при sizing: 'content'. 0 — без границы.
   *
   * Меню она нужна: карточка из одного слова читается хуже, и длинный
   * пункт переносится. Тост — наоборот: карточка короткого уведомления
   * узкая по замыслу, и пол шире карточки оставил бы окно шире
   * содержимого, а уровень в renderer позиционируется по ЛЕВОМУ краю
   * окна — карточка встала бы левее правого края на разницу.
   */
  minWidth: number
  /** Высота, если она известна на стороне main. */
  height: number | null
  /** Как выравнивать относительно точки вызова. */
  align: SurfaceAlign
  /** Отступ от точки вызова, чтобы меню не липло к курсору. */
  gap: number
}

/** Размеры, известные main до измерения в renderer. */
type KnownSize = { width: number; height: number }

/** Описание поверхности по виду оверлея. */
const SURFACES: Record<ViewKind, SurfaceSpec> = {
  // Ширина меню — максимум: реальную задаёт содержимое. Меню не должно
  // растягиваться под длинное название группы, но и не должно обрезать
  // его. Значение используется как потолок при измерении.
  menu: {
    width: 320,
    sizing: 'content',
    minWidth: 200,
    height: null,
    align: 'anchor-end',
    gap: 4
  },
  // Меню окна: та же карточка, но выравнивание по левому краю точки вызова.
  // Отдельная запись нужна из-за 'anchor-end' по умолчанию у menu — с ним
  // меню открывалось бы справа от курсора и уезжало за край окна.
  'window-menu': {
    width: 320,
    sizing: 'content',
    minWidth: 200,
    height: null,
    align: 'anchor',
    gap: 0
  },
  // Диалоги фиксированы: содержимое не влияет на высоту, кнопки в ряд.
  dialog: {
    width: 320,
    sizing: 'fixed',
    minWidth: 0,
    height: 190,
    align: 'center',
    gap: 0
  },
  icon: {
    width: 340,
    sizing: 'fixed',
    minWidth: 0,
    height: 250,
    align: 'center',
    gap: 0
  },
  // Поиск: ширина как у VS Code, высота под одну строку плюс отступы.
  find: {
    width: 380,
    sizing: 'fixed',
    minWidth: 0,
    height: 56,
    align: 'page-top-right',
    gap: 12
  },
  // Попап масштаба: под бейджем справа от адресной строки, правый край
  // по правому краю бейджа — как в Chrome/Yandex. Высота из измерения
  // (одна строка с полем и кнопками, но CSS — источник истины).
  zoom: {
    width: 260,
    sizing: 'content',
    minWidth: 200,
    height: null,
    align: 'anchor-end',
    gap: 6
  },
  // Тост: максимум по ширине, высота зависит от числа строк текста.
  //
  // gap — отступ от угла страницы. Он применяется ЗДЕСЬ, потому что окно
  // оверлея равно самой карточке: отступ внутри компонента съедался бы
  // заново при каждом измерении и уводил карточку от края.
  //
  // minWidth: 0 — намеренно. Тост выравнивается по углу ОКНА, а не по
  // якорю, но ширину ему задаёт содержимое: окно обязано совпасть с
  // карточкой, иначе справа остаётся полоса пустого окна, и карточка
  // встаёт левее правого края ровно на её ширину.
  toast: {
    width: 360,
    sizing: 'content',
    minWidth: 0,
    height: null,
    align: 'page-bottom-right',
    gap: 16
  }
}

// Высота пункта меню в CSS намеренно НЕ дублируется здесь. Её знает
// только renderer, и единственный источник правды — измерение.
// Хардкод MENU_ITEM_H = 40 и причина, по которой он разошёлся с CSS,
// разобраны в docs/TROUBLESHOOTING.md.

/**
 * Описание поверхности по виду.
 *
 * Выравнивание приходит двумя источниками: запрошенным в showOverlay
 * (`align: 'start'` для контекстного меню) и умолчанием из SURFACES.
 * Запрошенное побеждает — иначе контекстное меню всегда открывалось бы
 * правым краем в точке клика.
 */
export function surfaceFor(kind: ViewKind, requested?: 'start' | 'end'): SurfaceSpec {
  const spec = SURFACES[kind]
  if (!requested) return spec
  if (kind !== 'menu') return spec
  // 'start' — левый край в точке клика (контекстное меню).
  // 'end'   — правый край в точке (кнопка браузера).
  return { ...spec, align: requested === 'start' ? 'anchor' : 'anchor-end' }
}

/** Переводит описание поверхности в контракт (для renderer и логов). */
export function surfaceContract(spec: SurfaceSpec): Surface {
  return {
    width: spec.width,
    height: spec.height,
    align: spec.align,
    focusable: spec.align === 'center' || spec.align === 'page-top-right',
    gap: spec.gap
  }
}

/**
 * Куда поставить окно размера `size` относительно точки вызова.
 *
 * @param parentBounds  область содержимого окна-родителя
 * @param workArea      рабочая область дисплея РОДИТЕЛЯ (не объединённая)
 * @param anchor        точка вызова в координатах содержимого родителя
 * @param spec          описание поверхности
 * @param size          фактический размер содержимого
 * @param measured      true, если размер пришёл из renderer, а не из хардкода
 */
export function resolveBounds(
  parentBounds: Rectangle,
  workArea: Rectangle,
  anchor: { x: number; y: number },
  spec: SurfaceSpec,
  size: { width: number; height: number },
  measured: boolean
): { x: number; y: number; width: number; height: number; flipped: boolean } {
  const { align, gap } = spec
  // Высота содержимого может превышать доступную (длинное меню у нижнего
  // края). Тогда окно поднимаем вверх, а не режем: пункты меню резать
  // нельзя, пунктов может быть двадцать.
  const width = Math.min(size.width, parentBounds.width)
  const height = size.height

  // Точка вызова в экранных координатах.
  const anchorX = parentBounds.x + anchor.x
  const anchorY = parentBounds.y + anchor.y

  let x: number
  let y: number
  let flipped = false

  switch (align) {
    case 'center':
      x = parentBounds.x + Math.round((parentBounds.width - width) / 2)
      y = parentBounds.y + Math.round((parentBounds.height - height) / 2)
      break

    case 'page-bottom-right':
      // Тост — правый нижний угол области страницы, то есть ОКНА, а не
      // монитора. Отсчёт от экрана выглядел правильным в полноэкранном
      // окне, но в оконном режиме уводил карточку за пределы окна и под
      // панель задач.
      //
      // gap здесь — единственный отступ от угла. Внутри компонента его
      // быть не должно: padding на контейнере добавлялся к размеру
      // уровня, и main считал окно по этой лишней ширине, из-за чего
      // карточка уезжала от правого края ровно на величину padding.
      x = parentBounds.x + parentBounds.width - width - gap
      y = parentBounds.y + parentBounds.height - height - gap
      break

    case 'page-top-right':
      // Правый край области страницы. anchor несёт uiInsets.top по вертикали
      // и игнорируется по горизонтали: панель поиска прижата к правому
      // краю всегда, независимо от того, где кликнули.
      x = parentBounds.x + parentBounds.width - width - gap
      y = anchorY + gap
      break

    case 'anchor':
      // Левый верхний угол в точке клика.
      x = anchorX + gap
      y = anchorY + gap
      break

    case 'anchor-end':
    default: {
      // Правый край в точке. Если справа не хватает места, а слева есть —
      // разворачиваем, как в обычных браузерах.
      x = anchorX - width + gap
      if (x + width > workArea.x + workArea.width) {
        const flippedX = anchorX + gap
        if (flippedX + width <= workArea.x + workArea.width) {
          x = flippedX
          flipped = true
        }
      }
      y = anchorY + gap
      break
    }
  }

  // Последний кламп: не выходить за рабочую область дисплея родителя.
  //
  // Для поверхностей, привязанных к ОКНУ (toast, find), граница берётся
  // по самому родителю, а не по дисплею. Иначе в оконном режиме
  // карточка считалась от угла окна, но ограничивалась краем экрана —
  // то есть уезжала за пределы окна, под его рамку и панель задач.
  //
  // Нижняя граница клампится вверх: если окно ниже карточки, прижимаем
  // к низу родителя, иначе тост уехал бы в панель заголовка.
  const parentMaxX = parentBounds.x + parentBounds.width - width
  const parentMaxY = parentBounds.y + parentBounds.height - height
  const isWindowAnchored = align === 'page-bottom-right' || align === 'page-top-right'
  const boundX = isWindowAnchored
    ? parentMaxX
    : workArea.x + workArea.width - width
  const boundY = isWindowAnchored
    ? parentMaxY
    : workArea.y + workArea.height - height
  const clampedX = Math.min(Math.max(Math.round(x), workArea.x), Math.max(workArea.x, boundX))
  const clampedY = Math.min(Math.max(Math.round(y), workArea.y), Math.max(workArea.y, boundY))

  if (measured && (clampedX !== Math.round(x) || clampedY !== Math.round(y))) {
    log('geometry', 'clamped to work area', {
      want: { x: Math.round(x), y: Math.round(y) },
      got: { x: clampedX, y: clampedY },
      flipped,
      workArea
    })
  }

  return { x: clampedX, y: clampedY, width, height, flipped }
}

/**
 * Пересчитывает bounds после измерения содержимого в renderer.
 *
 * Вызывается на `overlay:measured`. Основная ширина берётся из измерения,
 * но ограничивается `spec.width`: длинное название группы не должно
 * растягивать меню во всю ширину экрана.
 */
export function boundsFromMeasurement(
  parentBounds: Rectangle,
  workArea: Rectangle,
  anchor: { x: number; y: number },
  spec: SurfaceSpec,
  measured: { width: number; height: number }
): { x: number; y: number; width: number; height: number; flipped: boolean } {
  // Ширину содержимое задаёт там, где она не часть замысла
  // (sizing: 'content'): меню, попап зума и тост растут от содержимого до
  // потолка `width`. Диалог, иконка и панель поиска держат заданную
  // ширину, и измерение уточняет их только по высоте.
  //
  // Тост раньше попадал в «фиксированные» — по выравниванию (он стоит по
  // углу ОКНА, а не по якорю), хотя по замыслу его ширина — максимум.
  // Цена: окно оставалось 360 px при карточке в 200 px. Уровень в
  // renderer позиционируется по левому краю окна, поэтому карточка
  // вставала левее правого края ровно на разницу ширин — это и был
  // «тост со смещением».
  const width =
    spec.sizing === 'content'
      ? Math.min(Math.max(measured.width, spec.minWidth), spec.width)
      : spec.width
  return resolveBounds(parentBounds, workArea, anchor, spec, { width, height: measured.height }, true)
}

/**
 * Объединение прямоугольников уровней стека — окно оверлея (вариант B).
 *
 * Проблема, которую это решает: уровни выровнены по-разному. Меню у края
 * экрана разворачивается влево (align-end), диалог стоит по центру, тост —
 * в правом нижнем углу. Их окна в разных местах, а показать их
 * одновременно можно только ОДНИМ окном. Значит, окно должно покрывать
 * все уровни целиком.
 *
 * Считаем не «всё окно родителя» (тогда кликабельность перекроет всю
 * страницу), а прямоугольник, описанный вокруг уровней. Плата варианта B
 * в том, что union с соседними уровнями растёт, но на практике стек
 * держится на глубине 1-2, и рамка не уходит за пределы экрана.
 *
 * Между уровнями оставляем зазор STACK_GAP: без него карточки разных
 * уровней примыкали бы друг к другу вплотную, и визуально не было бы
 * видно, что это две отдельные поверхности.
 *
 * @param levels прямоугольники уровней в экранных координатах
 * @param workArea рабочая область дисплея родителя
 */
export function resolveUnionBounds(
  levels: Rectangle[],
  workArea: Rectangle
): { x: number; y: number; width: number; height: number } {
  if (levels.length === 0) {
    return { x: workArea.x, y: workArea.y, width: 1, height: 1 }
  }
  const left = Math.min(...levels.map((l) => l.x))
  const top = Math.min(...levels.map((l) => l.y))
  const right = Math.max(...levels.map((l) => l.x + l.width))
  const bottom = Math.max(...levels.map((l) => l.y + l.height))
  // Зазор только между уровнями, а не по краям: иначе отступ от края
  // экрана плавал бы в зависимости от того, какой уровень крайний.
  const grow = levels.length > 1 ? STACK_GAP : 0
  let x = Math.round(left - grow)
  let y = Math.round(top - grow)
  const width = Math.round(right - left + grow * 2)
  const height = Math.round(bottom - top + grow * 2)
  // Последний кламп: union не должен уходить за экран, иначе край
  // уровня окажется за рабочей областью и карточка обрежется.
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const clampedX = Math.min(Math.max(x, workArea.x), Math.max(workArea.x, maxX))
  const clampedY = Math.min(Math.max(y, workArea.y), Math.max(workArea.y, maxY))
  if (clampedX !== x || clampedY !== y) {
    log('geometry', 'union clamped to work area', {
      want: { x, y, width, height },
      got: { x: clampedX, y: clampedY },
      workArea
    })
  }
  x = clampedX
  y = clampedY
  return { x, y, width, height }
}

/**
 * Локальные координаты уровня внутри окна объединения.
 *
 * Renderer рисует уровни в потоке документа, а не в экранных координатах:
 * окно и есть система отсчёта. Уровень, который main посчитал по
 * resolveBounds, нужно сдвинуть в начало окна — иначе он оказался бы за
 * пределами видимой области.
 */
export function levelOffsetInUnion(
  level: Rectangle,
  union: Rectangle
): { x: number; y: number } {
  return { x: level.x - union.x, y: level.y - union.y }
}

/** Зазор между уровнями стека, чтобы карточки не слипались в одну полосу. */
const STACK_GAP = 4

/** Рабочая область дисплея, на котором лежит окно. */
export function workAreaOf(win: Electron.BrowserWindow): Rectangle {
  return screen.getDisplayMatching(win.getBounds()).workArea
}

export type { KnownSize }
