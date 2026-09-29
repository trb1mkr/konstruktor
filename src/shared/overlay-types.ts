// Общий контракт с��стемы оверлея: main <-> preload <-> renderer overlay.
// Единственный источник правды по формам сообщений. Никаких импортов из
// electron/vue — файл должен собираться в любом из трёх контекстов.

// Какие поверхности умеет показывать оверлей-окно. Renderer держит реестр
// view -> Vue-компонент, main — описание геометрии/фокуса.
export type ViewKind = 'menu' | 'dialog' | 'icon' | 'find' | 'toast'

// Как меню выравнивается относительно точки вызова.
// 'anchor' — левый верхний угол в точке клика (контекстное меню).
// 'anchor-end' — правый край в точке (кнопка браузера).
// 'center' — по центру окна-родителя (диалоги).
// 'page-top-right' — правый верхний угол области страницы (поиск, тосты).
export type SurfaceAlign = 'anchor' | 'anchor-end' | 'center' | 'page-top-right'

// Описание поверхности: размеры, фокус, выравнивание, нужен ли focusable.
export interface Surface {
  // Ширина окна в px (menu/dialog фиксированы, у toast — максимум).
  width: number
  // Высота. null = измерить в renderer (высота зависит от числа пунктов).
  height: number | null
  align: SurfaceAlign
  // true = окно забирает фокус ввода (диалоги, поиск), иначе showInactive.
  focusable: boolean
  // Отступ от точки вызова, чтобы меню не липло к курсору.
  gap: number
}

// Пункт универсального меню. Один тип на все меню приложения:
// вкладки, группы, панель, меню браузера.
export interface MenuItem {
  id: string
  label: string
  // Эмодзи/символ или короткий текст. null = без иконки.
  icon?: string | null
  // Цвет группы (точка-индикатор), как на панели закладок.
  color?: string | null
  disabled?: boolean
  // Подпункты второго уровня (меню «Add to group» и т.п.).
  // null = пункт конечный.
  children?: MenuItem[] | null
}

// Данные для универсального диалога с полем ввода.
export interface DialogModel {
  title: string
  placeholder?: string
  initial?: string
  buttons: { id: string; label: string }[]
}

// Данные диалога иконки (URL / файл / эмодзи / отмена).
export interface IconModel {
  title: string
  placeholder?: string
  initial?: string
}

// Данные панели поиска.
export interface FindModel {
  query?: string
}

// Данные тоста.
export interface ToastModel {
  title: string
  body?: string
  timeout?: number
}

// Модель — то, что видно компоненту. Ровно одно поле заполнено
// (или items/itemsFor — для универсального меню любого контекста).
export type OverlayModel =
  | { view: 'menu'; items: MenuItem[]; badge?: string }
  | { view: 'dialog'; dialog: DialogModel }
  | { view: 'icon'; icon: IconModel }
  | { view: 'find'; find: FindModel }
  | { view: 'toast'; toast: ToastModel }

// Что main сообщает renderer при открытии/смене сессии.
export interface PushMessage {
  // Монотонный счётчик сессий. Renderer отбрасывает команды/данные
  // со старым sessionId — защита от гонок при быстром переключении меню.
  sessionId: number
  model: OverlayModel
  // Тема оверлея: 'dark' | 'light' | 'slate' (уже разрешена в main).
  theme: 'dark' | 'light' | 'slate'
  // Анимации включены (настройка). false = без fade.
  animations: boolean
  // Меню прижато к точке вызова: меняет внутреннее выравнивание DOM.
  anchorLeft?: boolean
}

// Точечное обновление живой сессии: счётчик поиска, ошибка валидации и т.п.
export interface UpdateMessage {
  sessionId: number
  // Патч на уровне модели: { find: { counter } }, { icon: { error } }.
  patch: DeepPartial<OverlayModel>
}

// Команда renderer -> main: действие пользователя.
export type OverlayCommand =
  | { sessionId: number; type: 'select'; id: string }
  | { sessionId: number; type: 'submit'; value: string }
  | { sessionId: number; type: 'dismiss' }
  | { sessionId: number; type: 'find-query'; opts: FindQueryOptions }
  | { sessionId: number; type: 'find-next' }
  | { sessionId: number; type: 'find-prev' }
  | { sessionId: number; type: 'find-close' }
  // Диалог иконки: main верифицирует источник, false = ошибка в диалоге.
  | { sessionId: number; type: 'submit-icon'; buttonId: string; value: string }

export interface FindQueryOptions {
  query: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
}

// Renderer сообщает реальные размеры содержимого после монтирования.
// Main корректирует bounds — окно никогда не режет меню.
export interface MeasureMessage {
  sessionId: number
  width: number
  height: number
}

// Рекурсивный Partial — для точечных патчей модели.
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

// Канал renderer -> main: пользователь нажал кнопку/пункт.
export const OVERLAY_CHANNELS = {
  command: 'overlay:command',
  measured: 'overlay:measured'
} as const

// Каналы main -> renderer: новая сессия / точечный патч.
export const OVERLAY_PUSH_CHANNEL = 'overlay:push'
export const OVERLAY_UPDATE_CHANNEL = 'overlay:update'
