// Разбор payload overlay: типы push-сообщения, пропсы уровней,
// мерж патчей и сверка устаревших push. Выделено из OverlayRoot.vue.
//
// Граница: всё, что превращает сообщение main в данные для шаблона,
// лежит здесь. Сам OverlayRoot держит только ref состояния, подписки
// на IPC и разметку. НОВЫЙ тип payload — сюда + панель в registry,
// не в OverlayRoot.
import { componentFor } from './registry'
import type {
  DialogModel,
  FindModel,
  IconModel,
  MenuItem,
  StackEntry,
  ToastModel,
  UpdateMessage
} from '../../shared/overlay-types'

export type { MenuItem }

/** Модель уровня — плоская: шаблон читает поля напрямую. */
export interface OverlayModel {
  view: 'menu' | 'toast' | 'dialog' | 'find' | 'icon' | 'window-menu' | 'zoom'
  items?: MenuItem[]
  toast?: ToastModel
  dialog?: DialogModel
  icon?: IconModel
  find?: FindModel
  zoom?: { percent: number }
}

// Один уровень стека, ровно как его прислал main. Форма задана
// контрактом StackEntry, но здесь объявлена отдельно: renderer держит
// уровни в ref и мержит патчи, а контрактный union пришлось бы сузить в
// каждом месте.
export interface Level extends Omit<StackEntry, 'model'> {
  model: OverlayModel
}

// То, что приходит из main одним сообщением overlay:push.
export interface OverlayPayload {
  // Стек уровней снизу вверх. Токен каждого уровня лежит в нём самом,
  // а не в сообщении: при двух уровнях одно общее поле означало бы,
  // каким оно помечено — верхним или нижним.
  //
  // Токен верхнего уровня работает и подтверждением отрисовки: main держит
  // окно прозрачным, пока renderer не вернёт его через overlay:painted.
  stack: Level[]
  theme: 'dark' | 'light' | 'slate'
  // Язык интерфейса оверлея из PushMessage: применяется до отрисовки
  // стека, чтобы FindBar и диалог иконки не мелькнули чужим языком.
  language: string
  animations: boolean
}

// Типы берём из контракта, а не дублируем локально. Прежний комментарий
// утверждал, что общий тип в бандл renderer не попадает и его приходится
// дублировать — это неверно: типы стираются при сборке, и
// `renderer/core/useTabs.ts` уже импортирует их из preload. Локальная копия
// разошлась с общей на шаге 4b: counter и error добавились в модель, а
// локальный OverlayModel молча остался без них.
export type OverlayUpdate = UpdateMessage

/** Пропсы уровня — форма та же, что была для единственной модели. */
export function propsFor(level: Level): Record<string, unknown> | null {
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
    // Попап зума: процент приходит в push (открытие) и в overlay:update
    // (каждое `+`/`−`/`Reset`) — компонент живёт на пропе, своего
    // состояния вне модели у него нет.
    case 'zoom':
      return { ...base, percent: model.zoom?.percent ?? 100 }
    default:
      return null
  }
}

/** Отрисованные уровни: компонент из registry + пропсы, без пустых. */
export function buildRenderedLevels(stack: Level[]) {
  return stack
    .map((level, index) => ({
      key: level.sessionId,
      index,
      level,
      component: componentFor(level.model.view),
      props: propsFor(level)
    }))
    .filter((entry) => entry.props !== null)
}

/**
 * Глубокий мерж патча в модель. Намеренно локальный: патчи всегда плоские
 * (find.counter, icon.error), и общий deep-merge был бы лишней
 * абстракцией.
 *
 * null и undefined НЕ перезаписывают поле — иначе нельзя было бы стереть
 * сообщение об ошибке, не отправляя полную сессию заново.
 */
export function mergePatch<T extends object>(base: T, patch: unknown): T {
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

/**
 * Сверка устаревших push.
 *
 * Правило НЕ «верхний токен меньше — значит позднее»: снятие верхнего
 * уровня (Esc) укорачивает стек, и у возврата к меню верхний токен
 * МЕНЬШЕ, чем у диалога, который только что показали. Такое сравнение
 * отбрасывало возврат как позднее сообщение — и это зафиксировано в логе:
 *
 *   returned to lower level { popped: 2, depth: 1, kind: 'menu' }
 *   STALE, dropped push: got stack 1, current 1+2
 *
 * Попытка с правилом «укороченный стек — всегда устарел» была хуже:
 * 15 абортов подряд, приложение переставало открывать меню вовсе.
 *
 * Верное правило: токены монотонны, поэтому push, верхний токен
 * которого МЕНЬШЕ текущего, устарел лишь тогда, когда этого токена нет
 * НИГДЕ в текущем стеке. У возврата токен меню в стеке есть, и он
 * устаревшим не является.
 *
 * @returns true, если push устарел и должен быть отброшен.
 */
export function isStalePush(msg: OverlayPayload, current: OverlayPayload | null): boolean {
  const currentStack = current?.stack
  const incomingTop = msg.stack[msg.stack.length - 1]
  if (!currentStack || !incomingTop) return false
  const currentTop = currentStack[currentStack.length - 1]
  const knownSomewhere = currentStack.some((l) => l.sessionId === incomingTop.sessionId)
  return !knownSomewhere && incomingTop.sessionId < currentTop.sessionId
}
