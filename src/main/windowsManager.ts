// Окна браузера: создание, геометрия, layout view, fullscreen, сессии.
// Выделено из index.ts: здесь createWindow + layout + fullscreen + bounds + session.
// Вкладки (createTab/closeTab/detach) живут в tabsManager.ts, этот модуль
// принимает их через deps во избежание циклических импортов.
import { app, BrowserWindow, WebContentsView } from 'electron'
import { join } from 'path'
import { windows, type WindowState, INCOGNITO_PARTITION } from './browserState'
import { getSettings, getSettingsSync, saveSettings } from './settingsStore'
import { openFindOverlay } from './findManager'
import { ensureOverlayWindow } from './overlay'
import { readFileSync, existsSync } from 'fs'

// NOTE: dev = не упакованное приложение.
export const isDev = !app.isPackaged

// Синхронное чтение settings.json напрямую с диска.
// Нужно в createWindow: кэш settingsStore еще пуст на момент первого окна,
// а асинхронный load() задержал бы создание окна. Возвращает частичные
// настройки поверх дефолтов — отсутствующие поля добирает store при load().
export function readSettingsFileSync(): {
  rememberBounds?: boolean
  rememberTabs?: boolean
  windowBounds?: { x: number; y: number; width: number; height: number }
  windowMaximized?: boolean
  sessionTabs?: { url: string; active: boolean }[]
} {
  try {
    const p = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf-8')) as {
      rememberBounds?: boolean
      rememberTabs?: boolean
      windowBounds?: { x: number; y: number; width: number; height: number }
      windowMaximized?: boolean
      sessionTabs?: { url: string; active: boolean }[]
    }
  } catch {
    return {}
  }
}

// Пересчет геометрии view под свободную область.
// Renderer сообщает отступы UI через 'layout:update'.
// В контентном fullscreen отступы игнорируются: view на все окно.
// Дефолты ненулевые, чтобы UI был виден даже если renderer еще не прислал замеры.
export function layoutView(ws: WindowState, view: WebContentsView): void {
  if (!ws.window) return
  const b = ws.window.getContentBounds()
  if (ws.contentFullscreen) {
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height })
    return
  }
  const ins = ws.uiInsets
  view.setBounds({
    x: ins.left,
    y: ins.top,
    width: Math.max(0, b.width - ins.left - ins.right),
    height: Math.max(0, b.height - ins.top - ins.bottom)
  })
}

export function layoutActiveView(ws: WindowState): void {
  if (ws.activeTabId === null) return
  const rec = ws.tabs.get(ws.activeTabId)
  if (!rec) return
  layoutView(ws, rec.view)
}

// Слепок сессии обычных вкладок: url + какая активна.
// Инкогнито не пишем никогда. about:blank пропускаем (пустые вкладки).
export function snapshotSessionTabs(ws: WindowState): { url: string; active: boolean }[] {
  return ws.tabOrder
    .map((id) => {
      const rec = ws.tabs.get(id)
      if (!rec || rec.url === 'about:blank') return null
      return { url: rec.url, active: id === ws.activeTabId }
    })
    .filter((t): t is { url: string; active: boolean } => t !== null)
}

export function persistSessionTabs(ws: WindowState): void {
  if (ws.incognito) return
  if (getSettingsSync().rememberTabs === false) return
  void saveSettings({ sessionTabs: snapshotSessionTabs(ws) }).catch(() => undefined)
}

// F11: сценарий из настроек. 'window' — fullscreen всего окна,
// 'content' — только WebContentsView (панели прячутся через shell).
// Контентный режим тоже разворачивает ОКНО на весь экран (иначе видны
// смещение окна и таскбар), но панели скрыты и view занимает все окно.
// Исходные bounds запоминаем: setFullScreen(false) сам их не вернет,
// т.к. окно уже было немаксимизированным — восстанавливаем вручную.
export function toggleFullscreenMode(ws: WindowState): boolean {
  if (!ws.window || ws.window.isDestroyed()) return false
  const mode = getSettingsSync().fullscreenMode === 'content' ? 'content' : 'window'
  if (mode === 'content') {
    if (!ws.contentFullscreen) {
      ws.savedBounds = ws.window.getBounds()
      ws.contentFullscreen = true
      ws.window.setFullScreen(true)
    } else {
      ws.contentFullscreen = false
      ws.window.setFullScreen(false)
      // Возвращаем исконный размер: fullscreen его затирает.
      if (ws.savedBounds) {
        ws.window.setBounds(ws.savedBounds)
        ws.savedBounds = undefined
      }
    }
    layoutActiveView(ws)
    ws.window.webContents.send('window:content-fullscreen', ws.contentFullscreen)
    return ws.contentFullscreen
  }
  ws.window.setFullScreen(!ws.window.isFullScreen())
  return ws.window.isFullScreen()
}

export interface WindowDeps {
  createTab: (ws: WindowState, url?: string) => number
  setActiveTab: (ws: WindowState, id: number) => void
  pushTabsState: (ws: WindowState) => void
}

// Восстановление сессии при старте: создает вкладки из sessionTabs,
// активную ставит последней (setActiveTab в createTab каждый раз двигает).
// Возвращает false если восстанавливать нечего — caller создаст стартовую.
export function restoreSessionTabs(ws: WindowState, deps: WindowDeps): boolean {
  const saved = readSettingsFileSync()
  if (saved.rememberTabs === false) return false
  const tabs = (saved.sessionTabs ?? []).filter(
    (t) => typeof t?.url === 'string' && t.url.length > 0 && t.url !== 'about:blank'
  )
  if (tabs.length === 0) return false
  let activeId: number | null = null
  for (const t of tabs.slice(0, 50)) {
    try {
      const id = deps.createTab(ws, t.url)
      if (t.active) activeId = id
    } catch {
      // Битый URL — пропускаем вкладку.
    }
  }
  if (activeId !== null) deps.setActiveTab(ws, activeId)
  return ws.tabOrder.length > 0
}

// Ручное перетаскивание окна.
//
// Заменило -webkit-app-region: drag на панели вкладок и заголовке:
// drag-область на Windows перехватывает правый клик и отдаёт его
// СИСТЕМНОМУ меню окна. Событие до renderer не доходит вообще, отменить
// его нечем, и контекстное меню панели открывалось только на кнопке "+"
// (она no-drag). Заодно это единственный способ убрать системное меню.
//
// Цена: теряется прилипание к краям экрана (snap) и «показать рабочий
// стол» — их даёт ОС на drag-области, а не Chromium.
interface WindowDrag {
  // Окно, которое сейчас тащат. null = перетаскивания нет.
  win: BrowserWindow | null
  // Смещение курсора от левого верхнего угла окна в момент захвата.
  // Держим смещение, а не стартовую позицию: иначе окно прыгает под
  // курсор, если тот взяли не за угол.
  offsetX: number
  offsetY: number
}

const windowDrag: WindowDrag = { win: null, offsetX: 0, offsetY: 0 }

/**
 * Захват окна мышью. Дальше renderer шлёт координаты до отпускания.
 *
 * Никакой проверки на двойной клик здесь нет: renderer отсекает его сам
 * (иначе разворот по двойному клику срабатывал бы после начала drag),
 * а момент отсечки на стороне renderer-а виден в его стеке вызовов.
 */
export function startWindowDrag(win: BrowserWindow, cursorX: number, cursorY: number): boolean {
  if (win.isDestroyed()) return false
  windowDrag.win = win
  const [x, y] = win.getPosition()
  windowDrag.offsetX = Math.round(cursorX - x)
  windowDrag.offsetY = Math.round(cursorY - y)
  return true
}

/** Движение окна за курсором. Смещение внутри окна сохраняется. */
export function moveWindowDrag(cursorX: number, cursorY: number): void {
  const win = windowDrag.win
  if (!win || win.isDestroyed()) return
  // В maximize/fullscreen тащить нечего: окно размером с экран.
  if (win.isMaximized() || win.isFullScreen()) return
  const x = Math.round(cursorX - windowDrag.offsetX)
  const y = Math.round(cursorY - windowDrag.offsetY)
  // setBounds без animate: анимация окна на Windows видна как задержка
  // начала перетаскивания, а системное окно едет мгновенно.
  win.setBounds({ x, y, width: win.getBounds().width, height: win.getBounds().height })
}

/** Отпускание кнопки — конец перетаскивания. */
export function endWindowDrag(): void {
  windowDrag.win = null
}

export function createWindow(
  opts: {
    x?: number
    y?: number
    /**
     * Читать ли вкладки из sessionTabs при готовности renderer.
     *
     * По умолчанию true — так ведёт себя обычный запуск и перезапуск:
     * приложение возвращает вкладки прошлой сессии. Но пункт «Open new
     * window» обязан открыть ПУСТОЕ окно со стартовой страницей, и без
     * флага в него переезжали бы вкладки другого окна: sessionTabs —
     * общий слот на всё приложение, а не слот конкретного окна.
     */
    restoreSession?: boolean
  } = {},
  deps: WindowDeps
): WindowState {
  const ws: WindowState = {
    window: null,
    tabs: new Map(),
    tabOrder: [],
    activeTabId: null,
    stripOrder: [],
    pinnedStripOrder: [],
    uiInsets: { top: 110, bottom: 50, left: 0, right: 0 },
    // Новое окно всегда обычное: отдельного приватного окна больше нет,
    // режим переключается на уже открытом через switchIncognito.
    incognito: false,
    contentFullscreen: false,
    openGroups: []
  }
  // Восстановление геометрии: при rememberBounds стартуем с прошлого
  // размера/позиции, иначе дефолт 1600×900. Maximized — отдельным флагом.
  // Кэш settingsStore в main может быть пустым на момент первого окна
  // (load() еще не вызывался) — читаем файл синхронно напрямую.
  const saved = readSettingsFileSync()
  const useBounds = saved.rememberBounds !== false && saved.windowBounds
  const startBounds =
    opts.x !== undefined || opts.y !== undefined
      ? undefined
      : useBounds
        ? saved.windowBounds
        : undefined
  const win = new BrowserWindow({
    x: opts.x ?? startBounds?.x,
    y: opts.y ?? startBounds?.y,
    width: startBounds?.width ?? 1600,
    height: startBounds?.height ?? 900,
    autoHideMenuBar: true,
    // Свой заголовок: системный скрыт, кнопки рисует renderer.
    frame: false,
    titleBarStyle: 'hidden',
    // Прозрачный фон + CSS border-radius в shell: скругленные углы
    // в оконном режиме. В maximize/fullscreen радиус убирается классом.
    transparent: true,
    backgroundColor: '#00000000',
    fullscreenable: true,
    webPreferences: {
      // CJS-билд preload (format: 'cjs'): index.cjs рядом с internal.cjs.
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      // Партиция НЕ задаётся здесь.
      //
      // Раньше здесь стояло `partition: opts.incognito ? ...`, но после
      // перехода на переключение режима в существующем окне это стало
      // ложью: webPreferences читаются один раз при создании BrowserWindow,
      // и сменить партицию живого окна нельзя. Окно, переключённое в
      // приватный режим, продолжало бы писать localStorage шелла на диск.
      //
      // Теперь окно всегда грузится в in-memory партицию: различие между
      // режимами делают вкладки (WebContentsView получают партицию в
      // createTab, и она пересоздаётся при переключении). Для шелла
      // разницы нет — хранить в нём нечего, кроме истории и закладок
      // панели, а они в приватном режиме скрыты.
      //
      // Цена: localStorage обычного окна тоже не переживает перезапуск.
      // Если понадобится сохранять — отдельная партиция на режим и
      // перезагрузка renderer при переключении.
      partition: INCOGNITO_PARTITION,
      // ESM-прелоад (.mjs при "type": "module") требует sandbox: false,
      // иначе скрипт молча не грузится и window.browserAPI undefined.
      sandbox: false
    }
  })
  ws.window = win
  windows.set(win.id, ws)

  // Создаём оверлей-окно заранее, чтобы первый оверлей открывался мгновенно.
  ensureOverlayWindow(win)

  // DevTools по требованию: настройка devtools, env KONSTRUKTOR_DEVTOOLS=1
  // или флаг --devtools. По умолчанию закрыты.
  void getSettings()
    .then((s) => {
      const want =
        s.devtools || process.env.KONSTRUKTOR_DEVTOOLS === '1' || process.argv.includes('--devtools')
      if (want && ws.window && !ws.window.webContents.isDevToolsOpened()) {
        ws.window.webContents.openDevTools({ mode: 'detach' })
      }
    })
    .catch(() => undefined)

  win.on('resize', () => layoutActiveView(ws))
  win.on('resized', () => layoutActiveView(ws))
  // Состояние окна пушим в shell — опроса таймером больше нет.
  // maximize/unmaximize не покрывают все случаи: resize развернутого окна
  // (перетаскивание за край) и F11 (fullscreen) меняют геометрию без этих
  // событий — поэтому шлем оба флага на каждый resize тоже.
  const pushWindowState = () => {
    if (!ws.window || ws.window.isDestroyed()) return
    ws.window.webContents.send('window:maximized', ws.window.isMaximized())
    ws.window.webContents.send('window:fullscreen', ws.window.isFullScreen())
  }
  win.on('maximize', pushWindowState)
  win.on('unmaximize', pushWindowState)
  win.on('enter-full-screen', pushWindowState)
  win.on('leave-full-screen', () => {
    // Выход из fullscreen не через F11 (Esc, Win-жесты): контентный режим
    // тоже сбрасываем, иначе панели останутся скрытыми в обычном окне.
    if (ws.contentFullscreen) {
      ws.contentFullscreen = false
      if (ws.savedBounds && !ws.window?.isDestroyed()) {
        ws.window?.setBounds(ws.savedBounds)
        ws.savedBounds = undefined
      }
      layoutActiveView(ws)
      ws.window?.webContents.send('window:content-fullscreen', false)
    }
    pushWindowState()
  })
  win.on('resized', pushWindowState)
  // Первый layout после готовности renderer: к этому моменту view уже есть.
  // Сессия вкладок восстанавливается здесь же: did-finish-load значит shell
  // готов принимать pushTabsState. Инкогнито сессию не читает никогда.
  win.webContents.on('did-finish-load', () => {
    if (ws.tabs.size === 0) {
      // Сессия читается только если её не отключили вызовом, и никогда
      // для инкогнито: приватное окно не восстанавливает чужие вкладки.
      const canRestore = opts.restoreSession !== false && !ws.incognito
      const restored = canRestore && restoreSessionTabs(ws, deps)
      if (!restored) deps.createTab(ws)
    } else {
      // Вкладки уже есть — значит их положил вызывающий (cloneWindow).
      // Сессию НЕ читаем: она перезаписала бы только что созданные
      // вкладки, и клон превратился бы в пустое окно со стартовой.
      layoutActiveView(ws)
      deps.pushTabsState(ws)
    }
  })
  // Активация окна при старте. Осознанный размен: приложение перехватывает
  // фокус даже при запуске из терминала. Отключается удалением блока
  // ready-to-show целиком.
  //
  // За окном обязательно фокусируем вкладку. focus() окна передаёт
  // клавиатуру webContents окна (shell), а не вложенной view: вкладка —
  // отдельный WebContentsView, и без её focus() клавиатура остаётся в
  // shell. Отсюда был симптом «не срабатывает ни одна клавиша, но мышь
  // работает»: ввод доходил до окна, но не до того webContents, который
  // его обрабатывает, а клик Chromium трактует как команду сфокусировать.
  //
  // show() и focus() идут безусловно и повторяются: WM может применить
  // отложенную активацию позже ready-to-show и увести фокус обратно.
  // Проверять isFocused() здесь нельзя — по замеру оно и так true, и
  // guard отменял бы тот самый вызов, ради которого написан.
  const activateAtStartup = (): void => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    // Сразу за окном фокусируем и активную вкладку. focus() окна
    // передаёт клавиатуру webContents окна (shell), а не вложенной view:
    // вкладка — отдельный WebContentsView, и без её focus() клавиатура
    // остаётся в shell. Отсюда и не срабатывала ни одна клавиша:
    // ввод доходил до окна, но не до того webContents, который его
    // обрабатывает. Симптом совпадал с замером — не срабатывало НИЧЕГО.
    const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
    if (rec && !rec.view.webContents.isDestroyed()) {
      rec.view.webContents.focus()
    }
  }
  win.once('ready-to-show', () => {
    activateAtStartup()
    // Повтор после микротаска: WM может успеть применить отложенную
    // активацию позже ready-to-show и увести фокус обратно.
    setTimeout(activateAtStartup, 0)
    setTimeout(activateAtStartup, 150)
    // И позже: активация может прийти уже после того, как renderer
    // создал вкладку и поднял свои подписки. Без этого ввод в первые
    // секунды после запуска ещё уходит мимо.
    setTimeout(activateAtStartup, 600)
  })
  // Глобальный Ctrl+F окна: срабатывает даже если before-input-event view
  // не выстрелил (фокус в shell, пустая вкладка, перехват сайтом).
  // F11 из фокуса shell: тоггл сценария из настроек вручную.
  win.webContents.on('before-input-event', (e, input) => {
    if (
      input.key === 'F11' &&
      input.type === 'keyDown' &&
      !input.control &&
      !input.meta &&
      !input.shift &&
      !input.alt
    ) {
      e.preventDefault()
      if (!win.isDestroyed()) toggleFullscreenMode(ws)
      return
    }
    const key = (input.key ?? '').toLowerCase()
    const isF = key === 'f' || input.code === 'KeyF'
    if (
      (input.control || input.meta) &&
      !input.shift &&
      !input.alt &&
      isF &&
      input.type === 'keyDown'
    ) {
      e.preventDefault()
      openFindOverlay(ws)
    }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Восстановленный maximized применяется после загрузки shell.
  if (readSettingsFileSync().rememberBounds !== false && readSettingsFileSync().windowMaximized) {
    win.maximize()
  }

  // Геометрия пишется при каждом resize/move обычного окна.
  // Debounce 500ms: resize шлет десятки событий в секунду.
  let boundsTimer: NodeJS.Timeout | null = null
  const persistBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return
      void saveSettings({ windowBounds: win.getBounds() }).catch(() => undefined)
    }, 500)
  }
  win.on('resized', persistBounds)
  win.on('moved', persistBounds)
  win.on('maximize', () => {
    void saveSettings({ windowMaximized: true }).catch(() => undefined)
  })
  win.on('unmaximize', () => {
    void saveSettings({ windowMaximized: false }).catch(() => undefined)
  })

  win.on('close', () => {
    // Финальный слепок при закрытии: обычное окно — bounds + не maximized,
    // maximized/fullscreen — только флаг (bounds от таких окон кривые).
    // Сессия вкладок — всегда (кроме инкогнито): закрытие может быть
    // резким, debounce persistSessionTabs мог не успеть.
    if (getSettingsSync().rememberBounds !== false) {
      if (win.isMaximized() || win.isFullScreen()) {
        void saveSettings({ windowMaximized: true }).catch(() => undefined)
      } else {
        void saveSettings({ windowBounds: win.getBounds(), windowMaximized: false }).catch(
          () => undefined
        )
      }
    }
    if (!ws.incognito && getSettingsSync().rememberTabs !== false) {
      void saveSettings({ sessionTabs: snapshotSessionTabs(ws) }).catch(() => undefined)
    }
  })

  win.on('closed', () => {
    for (const tab of ws.tabs.values()) {
      try {
        tab.view.webContents.close()
      } catch {
        // Окно уже мертво — игнорим.
      }
    }
    // Инкогнито: чистим in-memory сессию при закрытии окна.
    if (ws.incognito) {
      try {
        const ses = win.webContents.session
        void ses.clearStorageData().catch(() => undefined)
        void ses.clearCache().catch(() => undefined)
      } catch {
        // Сессия уже уничтожена — игнорим.
      }
    }
    windows.delete(win.id)
    ws.window = null
    ws.tabs.clear()
  })

  return ws
}
