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
  /** Ширина окна. */
  width: number
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
  menu: { width: 320, height: null, align: 'anchor-end', gap: 4 },
  // Диалоги фиксированы: содержимое не влияет на высоту, кнопки в ряд.
  dialog: { width: 320, height: 190, align: 'center', gap: 0 },
  icon: { width: 340, height: 250, align: 'center', gap: 0 },
  // Поиск: ширина как у VS Code, высота под одну строку плюс отступы.
  find: { width: 380, height: 56, align: 'page-top-right', gap: 12 },
  // Тост: максимум по ширине, высота зависит от числа строк текста.
  toast: { width: 360, height: null, align: 'page-bottom-right', gap: 16 }
}

// Высота пункта меню в CSS намеренно НЕ дублируется здесь. Её знает
// только renderer, и единственный источник правды — измерение.
// Хардкод MENU_ITEM_H = 40 и причина, по которой он разошёлся с CSS,
// разобраны в docs/TROUBLESHOOTING.md.

/** Максимум, до которого сужается окно, если содержимое не влезает. */
const MIN_SURFACE_W = 200

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
      // Тост — правый нижний угол области страницы. Раньше он брал
      // координаты из anchor, и высота окна не совпадала с переданным
      // отступом, из-за чего карточка плавала выше низа. Положение
      // считаем сами, anchor по вертикали игнорируем.
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

  // Последний кламп: в пределах рабочей области дисплея родителя.
  // Именно дисплея, а не родителя: окно у края родителя — норма, а за
  // экраном пользователь его не увидит.
  const maxX = workArea.x + workArea.width - width
  const maxY = workArea.y + workArea.height - height
  const clampedX = Math.min(Math.max(Math.round(x), workArea.x), Math.max(workArea.x, maxX))
  const clampedY = Math.min(Math.max(Math.round(y), workArea.y), Math.max(workArea.y, maxY))

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
  // Меню по ширине не фиксировано: renderer меряет содержимое, main
  // ограничивает сверху. Для остальных поверхностей размер известен, и
  // измерение может его уточнить (тост с переносом строк), но не изменить
  // замысел: там фиксированная ширина — часть дизайна.
  const width =
    spec.align === 'anchor' || spec.align === 'anchor-end'
      ? Math.min(Math.max(measured.width, MIN_SURFACE_W), spec.width)
      : spec.width
  return resolveBounds(parentBounds, workArea, anchor, spec, { width, height: measured.height }, true)
}

/** Рабочая область дисплея, на котором лежит окно. */
export function workAreaOf(win: Electron.BrowserWindow): Rectangle {
  return screen.getDisplayMatching(win.getBounds()).workArea
}

export type { KnownSize }
