import { contextBridge, ipcRenderer } from 'electron'
import {
  OVERLAY_CHANNELS,
  OVERLAY_PUSH_CHANNEL,
  OVERLAY_UPDATE_CHANNEL
} from '../../shared/overlay-types'
import type { MeasureMessage, OverlayCommand, PushMessage, UpdateMessage } from '../../shared/overlay-types'

// Канал управления парковкой: main сообщает окну, нужно ли убрать
// содержимое из рендера. Главный механизм скрытия, парковка координатами
// — вспомогательный.
const CONTENT_CHANNEL = 'overlay:park'

// Канал подтверждения отрисовки содержимого после снятия парковки.
const PAINTED_CHANNEL = 'overlay:painted'

// Preload оверлей-окна (меню, тосты, попапы поверх WebContentsView).
// Канал overlay:* изолирован от browserAPI основного окна.
//
// Формы сообщений — в src/shared/overlay-types.ts. Здесь только транспорт:
// типизированные подписки на push/update, отправка команд и отчёт о
// размерах. Разбор и валидация — на стороне main (overlay/ipc.ts,
// overlay/service.ts) и renderer (OverlayHost).
const overlayAPI = {
  // ─── Новый контракт ───────────────────────────────────────────────────

  // Main присылает новую сессию: model, тема, флаги анимаций.
  // Подписка возвращает функцию отписки — вызывать при размонтировании.
  onPush: (cb: (msg: PushMessage) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: PushMessage): void => cb(msg)
    ipcRenderer.on(OVERLAY_PUSH_CHANNEL, listener)
    return () => ipcRenderer.removeListener(OVERLAY_PUSH_CHANNEL, listener)
  },

  // Точечный патч живой сессии: счётчик поиска, ошибка валидации.
  onUpdate: (cb: (msg: UpdateMessage) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: UpdateMessage): void => cb(msg)
    ipcRenderer.on(OVERLAY_UPDATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(OVERLAY_UPDATE_CHANNEL, listener)
  },

  // Действие пользователя одним объектом. Тип — OverlayCommand.
  //
  // sessionId в команде НЕ подставляется автоматически: его знает
  // renderer (он держит текущую сессию), а не preload. Подстановка здесь
  // означала бы, что подтверждать нечего — всегда «текущая», и защита
  // от запоздалых команд исчезала бы именно там, где нужна.
  send: (command: OverlayCommand): Promise<boolean> =>
    ipcRenderer.invoke(OVERLAY_CHANNELS.command, command),

  // Реальные размеры содержимого после монтирования. Main клампит
  // bounds по экрану, чтобы окно не резало меню.
  measure: (msg: MeasureMessage): void => {
    ipcRenderer.send(OVERLAY_CHANNELS.measured, msg)
  },

  // Подтверждение, что содержимое убрано из DOM (v-if снят).
  //
  // Main ждёт его ПЕРЕД перемещением окна. Без такого ожидания на Linux
  // окно показывало прежнее содержимое в новых координатах на долю кадра:
  // setOpacity там no-op, и единственная защита — размонтирование, а
  // сообщение о нём асинхронно.
  //
  // Вызывать из onMounted НЕЛЬЗЯ: нужно после того, как Vue реально
  // снял v-if, поэтому подтверждение шлёт обработчик park, а не onMounted.
  unmounted: (): void => {
    ipcRenderer.send(OVERLAY_CHANNELS.unmounted)
  },

  // ─── Старые методы, миграция на шаге 10 ───────────────────────────────

  /**
   * @deprecated Используйте `send({ type: 'select', id })`.
   * Вызовы не трогаем до шага 10 — они работают как раньше.
   *
   * sessionId — токен сессии, по которому main отсекает запоздалые
   * команды. Не передавать его можно только до шага 10: тогда main
   * сверяет токен лишь когда он есть, и защита дырами.
   */
  select: (id: string, sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('overlay:select', id, sessionId),
  /**
   * @deprecated Используйте `send({ type: 'dismiss' })`.
   */
  dismiss: (sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('overlay:dismiss', sessionId),
  /**
   * @deprecated Используйте `send({ type: 'submit', value })`.
   * Диалог с полем ввода: значение уходит через overlay:submit.
   */
  submit: (value: string, sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('overlay:submit', value, sessionId),
  /**
   * @deprecated Используйте `send({ type: 'submit-icon', buttonId, value })`.
   * Общий диалог иконки. false = main отклонил источник (ошибка
   * верификации), диалог не закрывается.
   */
  submitIcon: (buttonId: string, value: string, sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('overlay:submit-icon', buttonId, value, sessionId),
  /**
   * @deprecated Используйте `send({ type: 'find-query', opts })`.
   * Поиск по странице: запрос, навигация и закрытие панели.
   */
  findQuery: (opts: {
    query: string
    matchCase: boolean
    wholeWord: boolean
    useRegex: boolean
  }, sessionId?: number): Promise<boolean> => ipcRenderer.invoke('find:query', opts, sessionId),
  /**
   * @deprecated Используйте `send({ type: 'find-next' })`.
   */
  findNext: (sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('find:next', sessionId),
  /**
   * @deprecated Используйте `send({ type: 'find-prev' })`.
   */
  findPrev: (sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('find:prev', sessionId),
  /**
   * @deprecated Используйте `send({ type: 'find-close' })`.
   */
  findClose: (sessionId?: number): Promise<boolean> =>
    ipcRenderer.invoke('find:close', sessionId),
  /**
   * Временный канал диагностики: renderer сообщает
   * main о своих наблюдениях — какая анимация играет, какие классы на
   * элементах. Однонаправленный и безопасный: принимает только строки.
   */
  trace: (message: string): void => {
    ipcRenderer.send('overlay:trace', message)
  },
  // Управление содержимым оверлея. Главный механизм скрытия — не
  // прозрачность окна и не позиция, а удаление содержимого из рендера:
  // пустой DOM не виден нигде, куда бы оконный менеджер ни положил
  // окно.
  //
  // Флаг про РАЗМОНТИРОВАНИЕ, а не про монтирование: true = содержимое
  // убрано из рендера. Имя setContentMounted путало полярностью.
  //
  // Имя намеренно не про парковку: парковка позицией устарела и
  // отключена (PARK_MOVES_WINDOW = false), а размонтирование осталось и
  // работает. Канал прежний — 'overlay:park'.
  setContentUnmounted: (unmounted: boolean): void => {
    ipcRenderer.send(CONTENT_CHANNEL, unmounted)
  },
  onContentUnmounted: (cb: (unmounted: boolean) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, v: boolean): void => cb(v)
    ipcRenderer.on(CONTENT_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CONTENT_CHANNEL, listener)
  },

  // Кадр реально отдан. Main держит окно прозрачным до этого сигнала:
  // между снятием размонтирования и применением v-if проходит кадр, и в
  // нём ещё лежит старое содержимое. Если сразу вернуть прозрачность,
  // пользователь увидит вспышку предыдущего меню.
  painted: (token: number): void => {
    ipcRenderer.send(PAINTED_CHANNEL, token)
  }
}

export type OverlayAPI = typeof overlayAPI

contextBridge.exposeInMainWorld('overlayAPI', overlayAPI)

declare global {
  interface Window {
    overlayAPI: OverlayAPI
  }
}
