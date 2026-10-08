// Сборка push-сообщения и геометрия уровней стека.
// Выделено из service.ts: состояние показа (pendingGeometry), сборка
// PushMessage по стеку сессий и применение измерения из renderer.
//
// Общая точка для ТРЁХ мест: showOverlay (первый показ), возврат по Esc
// (restoreStackAfterPop в close.ts) и повторный push после измерения.
// Три копии разъехались бы при первом изменении формы StackEntry —
// проект уже переживал ровно это с локальной копией OverlayPayload.
import { nativeTheme, type BrowserWindow } from 'electron'
import { getSettingsSync } from '../store/settingsStore'
import { currentLang } from '../i18n'
import { log, logError } from './logger'
import { getPooledOverlay, pushPayload } from './pool'
import {
  boundsFromMeasurement,
  levelOffsetInUnion,
  resolveUnionBounds,
  surfaceFor
} from './geometry'
import { isCurrentSession, sessionOf, stackOf } from './session'
import type { SurfaceSpec } from './geometry'
import type { OverlayRequest } from './service'
import type { OverlayModel, PushMessage, StackEntry } from '../../shared/overlay-types'

// Размеры поверхностей живут в geometry.ts. Хардкод вида
// MENU_PAD + N * MENU_ITEM_H удалён на шаге 6: число 40 не имело
// отношения к CSS (пункт в реальности занимал 46 px), и каждый пункт
// съедал 6 px. Теперь размер приходит из renderer через
// overlay:measured, а до измерения берётся запасной размер из
// описания поверхности.

/**
 * Размер для первого кадра, до измерения в renderer.
 *
 * Для диалогов, иконы и поиска он точный: содержимое не влияет на
 * высоту. Для меню — потолок: настоящая высота зависит от числа
 * пунктов и приходит из `overlay:measured`.
 *
 * Меню в первом кадре получает минимальную вместимость, а не полную:
 * брать «ожидаемую» высоту значило бы угадывать число пунктов, а
 * ошибиться в меньшую сторону безопаснее — окно пустое и прозрачное,
 * лишние 200 px просто не видны.
 */
export function provisionalSize(request: OverlayRequest): { width: number; height: number } {
  const spec = surfaceFor(request.kind, request.align)
  if (spec.height !== null) return { width: spec.width, height: spec.height }
  // Меню: хватает на шесть пунктов, дальше окно дорастёт по измерению.
  const isMenuLike = request.kind === 'menu' || request.kind === 'window-menu'
  const rows = isMenuLike ? (request.items?.length ?? 0) : request.kind === 'zoom' ? 2 : 1
  const estimated = Math.max(rows, 6)
  return { width: spec.width, height: Math.min(estimated * MENU_ROW_FALLBACK_H, MAX_PROVISIONAL_H) }
}

// Запасная высота пункта меню для первого кадра.
//
// Это НЕ высота пункта в CSS и не должна ею быть: единственный источник
// правды по высоте — измерение в renderer. Значение нужно только чтобы
// окно было осмысленного размера до `overlay:measured`, и завышенная
// высота безопаснее заниженной: лишняя пустота в прозрачном окне не
// видна, а обрезанный пункт виден.
const MENU_ROW_FALLBACK_H = 46

// Потолок для первого кадра: очень длинное меню не должно занимать
// весь экран, пока не пришло измерение.
export const MAX_PROVISIONAL_H = 600

// Описание уровня: прямоугольник в экранных координатах плюс всё, чем
// он был получен. spec и anchor лежат РЯДОМ с прямоугольником, а не
// отдельно на весь показ: после возврата по Esc измерение приходит от
// нижнего уровня (меню), а spec последнего показа принадлежит верхнему
// (диалогу). Общий spec пересчитывал меню по ширине диалога — в логе это
// было видно как 'w: 340' у пункта меню, тогда как его ширина 224.
export interface LevelGeometry {
  // Токен уровня. По нему замер находит свой уровень в стеке: после
  // возврата по Esc измерение приходит от нижнего (меню), а не от
  // последнего в списке.
  sessionId: number
  rect: Electron.Rectangle
  spec: SurfaceSpec
  anchor: { x: number; y: number }
  flipped: boolean
}

interface PendingGeometry {
  parentBounds: Electron.Rectangle
  workArea: Electron.Rectangle
  // Границы окна, под которые посчитаны offset'ы уровней. Union НЕ
  // сжимается при возврате уровня, и это поле хранит прежнее значение:
  // без него offset'ы прыгали бы вместе с окном, а меню смещалось бы
  // внутри окна (см. restoreStackAfterPop).
  union: Electron.Rectangle
  //
  // Окно «заморожено» на время укороченного стека. Пока стек короче
  // последнего полного объединения, размеры окна не пересчитываются по
  // измерению: иначе замер от ResizeObserver'а оставшегося уровня снова
  // сжал бы окно до его размеров, и меню снова прыгнуло бы. Именно это
  // и было единственным оставшимся морганием.
  //
  // Снимается при новом полном показе (showOverlay) и при закрытии стека.
  frozen: boolean
  // Уровни стека снизу вверх. Каждый со своим spec и anchor: пересчёт по
  // измерению обязан опираться на описание того уровня, который измерили.
  levels: LevelGeometry[]
}

// Родитель -> геометрия последнего показа. Живёт до прихода измерения:
// без него applyMeasured не знает, что пересчитывать.
export const pendingGeometry = new Map<number, PendingGeometry>()

/**
 * Собирает PushMessage по стеку сессий и прямоугольникам уровней.
 *
 * Уровни и сессии сопоставляются по индексу: обе структуры наполняются
 * снизу вверх одним и тем же showOverlay. Токен в прямоугольнике не
 * хранится, искать по нему бессмысленно.
 */
export function buildPushMessage(
  parent: BrowserWindow,
  levels: LevelGeometry[],
  union: Electron.Rectangle
): PushMessage {
  const entries = stackOf<OverlayRequest>(parent.id)
  const settings = getSettingsSync()
  const theme =
    settings.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : settings.theme === 'slate' || settings.theme === 'light'
        ? settings.theme
        : 'dark'
  const stack: StackEntry[] = entries.map((entry, ix) => {
    const rect = levels[ix]?.rect ?? union
    return {
      sessionId: entry.sessionId,
      model: overlayModel(entry.request),
      // Контракт называет это anchorLeft: 'start' -> прижать к левому
      // краю якоря. Раньше поле называлось align и ехало в payload URL,
      // теперь форма задана контрактом.
      anchorLeft: entry.request.align === 'start',
      offset: levelOffsetInUnion(rect, union)
    }
  })
  return { stack, theme, animations: settings.animations !== false, language: currentLang() }
}

/**
 * Сообщивает renderer новую геометрию уровней без смены сессий.
 *
 * Вызывается после измерения содержимого: окно пересобрано по новому
 * объединению, и сдвиги всех уровней внутри него изменились. Без этого
 * push renderer рисовал бы по старым координатам, и после сжатия меню
 * карточка уехала бы за край окна.
 */
export function pushStackGeometry(
  parent: BrowserWindow,
  overlay: BrowserWindow,
  levels: LevelGeometry[],
  union: Electron.Rectangle
): void {
  if (overlay.isDestroyed()) return
  const message = buildPushMessage(parent, levels, union)
  if (message.stack.length === 0) return
  pushPayload(overlay, message)
}

/**
 * Пересчитывает bounds по фактическому размеру содержимого.
 *
 * Вызывается из `overlay:measured`. Первая версия брала только ширину,
 * и меню недотягивало по высоте; теперь учитываются оба размера.
 *
 * Токен сессии обязателен: измерение приходит из общего окна пула, и без
 * сверки патч от предыдущей сессии передвинул бы текущую.
 *
 * @param sessionId токен сессии, к которой относится измерение.
 * @param size фактический размер содержимого после монтирования.
 * @returns true, если bounds обновлены.
 */
export function applyMeasured(
  parent: BrowserWindow,
  sessionId: number,
  size: { width: number; height: number }
): boolean {
  // Замер относится к конкретному уровню, и уровень может быть уже не
  // в стеке: снятая сессия (Esc) успевает дослать измерение от своего
  // ResizeObserver. Проверка обязательна, и она остаётся.
  if (!isCurrentSession(parent.id, sessionId)) {
    log('geometry', 'STALE, dropped measurement', {
      parentId: parent.id,
      sessionId,
      current: sessionOf<OverlayRequest>(parent.id)?.sessionId
    })
    return false
  }
  const pending = pendingGeometry.get(parent.id)
  if (!pending) return false
  const overlay = getPooledOverlay(parent.id)
  if (!overlay || overlay.isDestroyed()) return false

  // Нулевой или огромный размер — признак того, что измеряли не то
  // (например, скрытый элемент с display:none). Применять такое нельзя:
  // окно схлопнется или уедет за экран.
  if (size.width < 1 || size.height < 1 || size.height > MAX_PROVISIONAL_H * 2) {
    logError('implausible overlay measurement', new Error(JSON.stringify(size)))
    return false
  }

  //
  // Измерение приходит для ВЕРХНЕГО уровня, и пересчитывается он
  // один — через boundsFromMeasurement, как и до стека. Прямоугольник
  // уровня заменяется на последнем месте в pending.levels: измерение
  // приходит от того, кто сейчас на экране, а он по определению вершина.
  //
  // Union пересобирается из ВСЕХ уровней. Без этого окно осталось бы
  // прежним, и либо обрезало бы измеренный уровень, либо оставляло бы
  // пустое поле при сжатии меню.
  //
  // Уровень ищется по ТОКЕНУ измерения, а не «последний в стеке».
  // Измерение может прийти от любого уровня: после возврата по Esc
  // вершиной стал нижний (меню), и его ResizeObserver прислал замер уже
  // после снятия верхнего. Взять «последний» значило бы пересчитать не
  // тот уровень.
  //
  // spec и anchor берутся У ЭТОГО ЖЕ уровня. Раньше они лежали на всём
  // показе, и меню пересчитывалось по spec'у диалога — в логе это было
  // видно как 'w: 340' у пункта меню при его настоящей ширине 224, и
  // объединение раздувалось, а меню уезжало вверх.
  const index = pending.levels.findIndex((l) => l.sessionId === sessionId)
  const target = index >= 0 ? index : pending.levels.length - 1
  const level = pending.levels[target]
  const measured = boundsFromMeasurement(
    pending.parentBounds,
    pending.workArea,
    level.anchor,
    level.spec,
    size
  )
  const levels = pending.levels.slice()
  levels[target] = {
    ...level,
    rect: { x: measured.x, y: measured.y, width: measured.width, height: measured.height }
  }
  //
  // Окно пересчитывается по объединению уровней — но ТОЛЬКО если стек не
  // укорочен. После возврата по Esc стек короче, и пересчёт сжал бы окно
  // до размеров оставшегося меню: в логе это было видно как
  // 'stack popped, window kept { w: 348 }' и следом
  // 'bounds from measurement { w: 224 }'. Меню при этом прыгало внутри
  // окна — это и было последнее моргание.
  //
  // Прямоугольник уровня уточняется всегда: он нужен следующему полному
  // показу, и именно по нему считается union при открытии диалога.
  const next = pending.frozen
    ? pending.union
    : resolveUnionBounds(
        levels.map((l) => l.rect),
        pending.workArea
      )
  pendingGeometry.set(parent.id, { ...pending, levels, union: next })
  // Меняем только размеры: позиция пересчитана, но если она не изменилась
  // (а обычно не меняется), лишний setBounds не нужен — он вызывает
  // перерисовку поверхности композитором.
  const current = overlay.getBounds()
  if (
    current.width === next.width &&
    current.height === next.height &&
    current.x === next.x &&
    current.y === next.y
  ) {
    return false
  }
  overlay.setBounds(next)
  log('geometry', 'bounds from measurement', {
    parentId: parent.id,
    sessionId,
    was: { x: current.x, y: current.y, w: current.width, h: current.height },
    now: { x: next.x, y: next.y, w: next.width, h: next.height },
    measured: size
  })
  // Геометрия уровня изменилась — сообщаем renderer новые сдвиги. Иначе
  // после сжатия меню до 220 px уровень остался бы на прежнем месте,
  // то есть за краем нового окна.
  pushStackGeometry(parent, overlay, levels, next)
  return true
}

// Переводит внутренний запрос в модель контракта для IPC-push.
//
// Раньше та же логика жила инлайн в showOverlay при сборке payload для
// URL. Теперь она оформлена отдельно: payload едет в renderer по
// контракту из shared/overlay-types.ts, и его форма задаётся там.
export function overlayModel(request: OverlayRequest): OverlayModel {
  if (request.kind === 'menu') {
    return { view: 'menu', items: request.items ?? [] }
  }
  if (request.kind === 'window-menu') {
    return { view: 'window-menu', items: request.items ?? [] }
  }
  if (request.kind === 'dialog') {
    return {
      view: 'dialog',
      dialog: {
        title: request.dialog?.title ?? '',
        placeholder: request.dialog?.placeholder,
        initial: request.dialog?.initial,
        buttons: request.dialog?.buttons ?? []
      }
    }
  }
  if (request.kind === 'icon') {
    return {
      view: 'icon',
      icon: {
        title: request.icon?.title ?? '',
        placeholder: request.icon?.placeholder,
        initial: request.icon?.initial
      }
    }
  }
  if (request.kind === 'find') {
    return { view: 'find', find: { query: request.find?.query } }
  }
  if (request.kind === 'zoom') {
    return { view: 'zoom', zoom: { percent: request.zoom?.percent ?? 100 } }
  }
  return { view: 'toast', toast: request.toast ?? { title: '' } }
}
