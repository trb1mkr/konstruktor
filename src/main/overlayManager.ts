import { BrowserWindow, dialog, nativeTheme } from 'electron'
import { join } from 'path'
import { getSettingsSync } from './settingsStore'

// Менеджер оверлей-окон: прозрачные frameless-окна поверх основного,
// в них DOM-меню/тосты/попапы любой темы. Замена системному Menu.popup,
// который на Windows всегда светлый и не стилизуется.
//
// Жизненный цикл: showOverlay создает окно, select/dismiss закрывают.
// Одновременно жив только один оверлей на родителя — новый вытесняет старый.
// Родитель moved/resized/minimized/blurred — оверлей закрывается сам.

export interface OverlayMenuItem {
  id: string
  label: string
  icon: string
  // Цвет группы (для Add to group): точка-индикатор как на панели закладок.
  color?: string
  disabled?: boolean
}

export interface OverlayDialogButton {
  id: string
  label: string
}

// Общий диалог иконки: одно поле ввода + 4 кнопки (URL, файл, emoji, отмена).
// В поле вводится любой из трех источников, при нажатии тип верифицируется:
// URL (http/file/data/konstruktor), локальный путь к файлу (-> file://),
// одиночный emoji (-> emoji:). Пустой ввод = сброс иконки.
export interface IconDialogState {
  title: string
  placeholder?: string
  initial?: string
}

// Верификация источника иконки: нормализует ввод к хранимому виду.
// Возвращает { ok: true, icon } или { ok: false, error } для тоста/повтора.
export function verifyIconSource(raw: string): { ok: true; icon: string } | { ok: false; error: string } {
  const text = raw.trim()
  // Пустой ввод = сброс к иконке по умолчанию.
  if (!text) return { ok: true, icon: '' }
  // Уже нормализованный emoji-префикс.
  if (text.startsWith('emoji:')) {
    return text.length > 'emoji:'.length
      ? { ok: true, icon: text }
      : { ok: false, error: 'Empty emoji' }
  }
  // URL-источники: http(s), file://, data:, внутренние страницы.
  if (/^(https?:|file:|data:|konstruktor:)/i.test(text)) return { ok: true, icon: text }
  // Локальный путь к файлу (C:\..., /..., .\...): проверяем существование.
  if (/^([a-zA-Z]:[\\/]|\\\\|\.{0,2}[\\/]|\/)/.test(text) || /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(text)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { pathToFileURL } = require('url') as typeof import('url')
      const unquoted = text.replace(/^"|"$/g, '')
      if (!fs.existsSync(unquoted)) return { ok: false, error: 'File not found' }
      return { ok: true, icon: pathToFileURL(unquoted).href }
    } catch {
      return { ok: false, error: 'Cannot read file' }
    }
  }
  // Одиночный emoji (1-2 графемы, без пробелов и точек): храним с префиксом.
  // Иначе TabGroupNode примет его за URL (iconIsUrl) и сломает <img>.
  const graphemes = [...text]
  if (!/\s/.test(text) && !text.includes('.') && graphemes.length <= 4 && /\p{Extended_Pictographic}|\p{Emoji}/u.test(text)) {
    return { ok: true, icon: `emoji:${text}` }
  }
  return { ok: false, error: 'Enter a URL, file path or emoji' }
}

interface OverlayRequest {
  kind: 'menu' | 'toast' | 'dialog' | 'find' | 'icon'
  anchor: { x: number; y: number }
  items?: OverlayMenuItem[]
  incognito?: boolean
  toast?: { title: string; body?: string; timeout?: number }
  dialog?: { title: string; buttons: OverlayDialogButton[] }
  icon?: IconDialogState
  find?: { query?: string }
  onSelect?: (id: string) => void
  // Контекст общего диалога иконки: apply вызывается после верификации.
  // Хранится и в request, и дублируется на overlay (__iconApply) —
  // хендлер overlay:submit-icon находит его по sender-окну.
  onIconApply?: (icon: string) => void
  // Выравнивание меню относительно якоря: 'end' — правый край меню
  // у якоря (кнопка ☰), 'start' — левый край у якоря (контекстное меню).
  align?: 'end' | 'start'
}

// parentId -> { overlay, request }
const active = new Map<number, { overlay: BrowserWindow; request: OverlayRequest }>()

const MENU_W = 260
const MENU_ITEM_H = 40
const MENU_PAD = 20
const DIALOG_W = 320
const DIALOG_H = 190
// Общий диалог иконки: поле + 4 кнопки, выше обычного диалога.
const ICON_W = 340
const ICON_H = 250
// Панель поиска: ширина как у VS Code, высота под одну строку + отступ.
const FIND_W = 380
const FIND_H = 56

function menuHeight(items: OverlayMenuItem[], incognito: boolean): number {
  return MENU_PAD + items.length * MENU_ITEM_H + (incognito ? 26 : 0)
}

function overlayUrl(payload: object): string {
  const encoded = encodeURIComponent(JSON.stringify(payload))
  if (process.env['ELECTRON_RENDERER_URL']) {
    return `${process.env['ELECTRON_RENDERER_URL']}/menu.html#payload=${encoded}`
  }
  return `file://${join(__dirname, '../renderer/menu.html')}#payload=${encoded}`
}

export function closeOverlay(parent: BrowserWindow): void {
  const entry = active.get(parent.id)
  if (!entry) return
  active.delete(parent.id)
  try {
    if (!entry.overlay.isDestroyed()) entry.overlay.close()
  } catch {
    // Уже закрыто — игнорим.
  }
}

// Активный оверлей родителя (для проброса found-in-page в панель поиска).
export function getActiveOverlay(parent: BrowserWindow): BrowserWindow | undefined {
  const entry = active.get(parent.id)
  return entry && !entry.overlay.isDestroyed() ? entry.overlay : undefined
}

export function getActiveRequest(parent: BrowserWindow): OverlayRequest | undefined {
  return active.get(parent.id)?.request
}

// Родитель оверлея: sender find:query/next/prev/close — это webContents
// самого оверлея, по нему находим окно-родитель и активную view.
export function getParentOfOverlay(overlay: BrowserWindow): BrowserWindow | undefined {
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) return BrowserWindow.fromId(parentId) ?? undefined
  }
  return undefined
}

export function showOverlay(parent: BrowserWindow, request: OverlayRequest): void {
  // Один оверлей на родителя: старый закрываем.
  closeOverlay(parent)

  // Флаг анимаций из настроек: false = открыть моментально без fade-in.
  // Синхронно из кэша — без await, иначе меню открывается с задержкой.
  // Тему тоже из кэша: оверлей красится до монтирования.
  const settings = getSettingsSync()
  const animations = settings.animations !== false
  // Эффективная тема оверлея: system резолвится через nativeTheme,
  // остальные уходят как есть (slate красится своими переменными).
  const theme =
    settings.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : settings.theme === 'slate' || settings.theme === 'light'
        ? settings.theme
        : 'dark'

  const parentBounds = parent.getContentBounds()
  const width =
    request.kind === 'menu'
      ? MENU_W
      : request.kind === 'dialog'
        ? DIALOG_W
        : request.kind === 'icon'
          ? ICON_W
          : request.kind === 'find'
            ? FIND_W
            : 360
  const height =
    request.kind === 'menu'
      ? menuHeight(request.items ?? [], request.incognito ?? false)
      : request.kind === 'dialog'
        ? DIALOG_H
        : request.kind === 'icon'
          ? ICON_H
          : request.kind === 'find'
            ? FIND_H
            : 120

  // Диалог и диалог иконки — по центру родителя. Поиск — правый верхний угол ОБЛАСТИ
  // СТРАНИЦЫ (ниже верхней панели UI): anchor несет uiInsets.top.
  // Меню — от якоря (align end/start). Клампим в границы родителя.
  const align = request.align ?? 'end'
  const centered = request.kind === 'dialog' || request.kind === 'icon'
  const isFind = request.kind === 'find'
  const x = centered
    ? parentBounds.x + Math.max(0, Math.round((parentBounds.width - width) / 2))
    : isFind
      ? parentBounds.x + Math.max(0, parentBounds.width - width - 16)
      : Math.min(
          Math.max(
            parentBounds.x + request.anchor.x - (request.kind === 'menu' && align === 'end' ? width - 40 : 0),
            parentBounds.x
          ),
          parentBounds.x + parentBounds.width - width
        )
  const y = centered
    ? parentBounds.y + Math.max(0, Math.round((parentBounds.height - height) / 2))
    : isFind
      ? parentBounds.y + request.anchor.y + 12
      : Math.min(
          parentBounds.y + request.anchor.y,
          parentBounds.y + parentBounds.height - height
        )

  const overlay = new BrowserWindow({
    x: Math.round(x),
    y: Math.round(y),
    width,
    height,
    parent,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    // Панель поиска должна держать фокус ввода: без focusable:false
    // клик/фокус уходит обратно в страницу и окно кажется неоткрывшимся.
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.cjs'),
      contextIsolation: true,
      sandbox: false
    }
  })

  active.set(parent.id, { overlay, request })
  // Контекст диалога иконки дублируем на окно: хендлер overlay:submit-icon
  // находит apply по sender-окну, request при этом недоступен напрямую.
  if (request.kind === 'icon' && request.onIconApply) {
    ;(overlay as unknown as { __iconApply?: (icon: string) => void }).__iconApply = request.onIconApply
  }

  const cleanup = () => {
    if (active.get(parent.id)?.overlay === overlay) active.delete(parent.id)
  }
  overlay.on('closed', cleanup)
  overlay.on('blur', () => closeOverlay(parent))
  // Родитель двигается — оверлей протух, закрываем.
  const closeOnParent = () => closeOverlay(parent)
  parent.on('move', closeOnParent)
  parent.on('resize', closeOnParent)
  parent.on('minimize', closeOnParent)
  overlay.on('closed', () => {
    parent.removeListener('move', closeOnParent)
    parent.removeListener('resize', closeOnParent)
    parent.removeListener('minimize', closeOnParent)
  })

  const payload =
    request.kind === 'menu'
      ? { kind: 'menu', items: request.items, incognito: request.incognito, animations, theme }
      : request.kind === 'dialog'
        ? { kind: 'dialog', dialog: request.dialog, animations, theme }
        : request.kind === 'icon'
          ? { kind: 'icon', icon: request.icon, animations, theme }
          : request.kind === 'find'
            ? { kind: 'find', find: request.find ?? {}, animations, theme }
            : { kind: 'toast', toast: request.toast, animations, theme }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void overlay.loadURL(overlayUrl(payload))
  } else {
    void overlay.loadFile(join(__dirname, '../renderer/menu.html'), {
      hash: `payload=${encodeURIComponent(JSON.stringify(payload))}`
    })
  }
  // Показываем сразу по готовности первой отрисовки: ready-to-show
  // ждет полной загрузки и дает видимую задержку перед открытием.
  // showInactive для меню/тостов (фокус остается в странице),
  // для поиска — show + focus, иначе не печатается.
  overlay.webContents.once('did-frame-finish-load', () => {
    if (overlay.isDestroyed()) return
    if (request.kind === 'find') {
      overlay.show()
      overlay.focus()
    } else {
      overlay.showInactive()
    }
  })
}

export function resolveOverlaySelect(overlay: BrowserWindow, id: string): void {
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      entry.request.onSelect?.(id)
      // onSelect может открыть новый оверлей поверх (например диалог
      // выбора иконки из контекстного меню). Тогда active уже указывает
      // на новое окно — его закрывать нельзя, только старый dismiss.
      if (active.get(parentId)?.overlay !== overlay) return
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          overlay.close()
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

export function resolveOverlayDismiss(overlay: BrowserWindow): void {
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          overlay.close()
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

// Диалог с полем ввода: значение "buttonId::text" резолвится
// через тот же onSelect — main разбирает префикс сам.
export function resolveOverlaySubmit(overlay: BrowserWindow, raw: string): void {
  for (const [parentId, entry] of active) {
    if (entry.overlay === overlay) {
      const parent = BrowserWindow.fromId(parentId)
      entry.request.onSelect?.(raw)
      if (parent) closeOverlay(parent)
      else {
        active.delete(parentId)
        try {
          overlay.close()
        } catch {
          // Игнорим.
        }
      }
      return
    }
  }
}

// Общий диалог иконки: верификация источника перед применением.
// Возвращает true если применено (диалог закроется), false если
// источник отклонен (диалог остается, renderer показывает ошибку).
// Кнопка file открывает системный диалог выбора картинки и подставляет
// путь в поле через executeJavaScript — submit идет обычным путем.
export function resolveOverlaySubmitIcon(
  overlay: BrowserWindow,
  buttonId: string,
  value: string,
  apply: (icon: string) => void
): boolean {
  for (const [parentId, entry] of active) {
    if (entry.overlay !== overlay) continue
    if (buttonId === 'file') {
      const parent = BrowserWindow.fromId(parentId)
      void dialog
        .showOpenDialog(parent ?? (null as never), {
          title: 'Choose icon',
          properties: ['openFile'],
          filters: [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'] },
            { name: 'All files', extensions: ['*'] }
          ]
        })
        .then(async (res) => {
          if (res.canceled || res.filePaths.length === 0 || overlay.isDestroyed()) return
          const { pathToFileURL } = await import('url')
          const href = pathToFileURL(res.filePaths[0]).href
          // Подставляем путь в поле ввода: пользователь жмет URL/Emoji/Enter сам.
          const escaped = href.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
          void overlay.webContents
            .executeJavaScript(
              `(()=>{const i=document.querySelector('.dialog-input');if(!i)return false;i.focus();i.value='${escaped}';i.dispatchEvent(new Event('input',{bubbles:true}));return true})()`
            )
            .catch(() => undefined)
        })
      return true
    }
    // Кнопки url/emoji: верифицируем ввод как соответствующий тип.
    let check: { ok: true; icon: string } | { ok: false; error: string }
    if (buttonId === 'emoji') {
      const text = value.trim()
      check =
        text && [...text].length <= 4 && /\p{Extended_Pictographic}|\p{Emoji}/u.test(text)
          ? { ok: true as const, icon: `emoji:${text.replace(/^emoji:/, '')}` }
          : { ok: false as const, error: 'Not an emoji' }
    } else {
      check = verifyIconSource(value)
      // Кнопка URL не принимает голый emoji: для него есть своя кнопка.
      if (check.ok && check.icon.startsWith('emoji:')) {
        check = { ok: false, error: 'Use Emoji button for emoji' }
      }
    }
    if (!check.ok) return false
    apply(check.icon)
    const parent = BrowserWindow.fromId(parentId)
    if (parent) closeOverlay(parent)
    else {
      active.delete(parentId)
      try {
        overlay.close()
      } catch {
        // Игнорим.
      }
    }
    return true
  }
  return false
}
