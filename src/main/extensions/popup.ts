// Всплывающее окно расширения (action popup): отдельное frameless-окно
// с содержимым страницы расширения, как в Chrome и Яндекс Браузере.
//
// Почему отдельное окно, а не WebContentsView внутри shell-окна: попап
// расширения — это чужой веб-контент со своим размером, и его надо
// свободно класть за пределы панелей. WebContentsView потребовал бы
// ручного расчёта инсетов и закрытия по клику на двух поверхностях;
// окно же само отдаёт событие blur и закрывается им.
//
// Партиция та же (persist:konstruktor), поэтому страница видит свой
// service worker и chrome.runtime.
import { BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { getState } from '../windows/browserState'
import { partitionFor, bootWorkspaceId } from '../workspaces/registry'
import { webContentBackgroundFor, schemeForWorkspace } from '../browserTheme'
import { logError } from '../overlay/logger'
import { dispatchExtensionRpc } from './bridge'
import { findExtensionRecord } from './extensionStore'

const DEFAULT_WIDTH = 400
const DEFAULT_HEIGHT = 560
const MIN_WIDTH = 160
const MIN_HEIGHT = 80
// Границы размера попапа: как у Chrome, содержимое больше — окно больше,
// но без ухода за край экрана до абсурда.
const MAX_WIDTH = 800
const MAX_HEIGHT = 700
// Наблюдение за размером содержимого: шаг опроса и общее окно.
// Попап расширения строится асинхронно (меню приходит от фона), поэтому
// размер проверяем не один раз, а несколько секунд. Столько же примерно
// держит попап сам Chrome — он пересчитывает размер при каждом изменении
// документа.
const POPUP_WATCH_MS = 5000
const POPUP_WATCH_STEP_MS = 150
// Порог изменения в пикселях, ниже которого окно не двигаем: иначе
// набегают лишние пересчёты от субпиксельных колебаний раскладки.
const SIZE_EPSILON = 2

// Пауза перед уничтожением попапа, закрытого самим расширением.
// Запросы расширения идут по loopback-мосту асинхронно, и закрытие уносит
// их вместе со страницей: MetaMask открывает онбординг вкладкой
// (tabs.create) и в том же тике зовёт window.close — без паузы запрос
// не успевал уйти, вкладка не открывалась, а попап исчезал (замер:
// RPC tabs.create в лог main не попадал вовсе). Окно в это время уже
// невидимо (setOpacity(0)), поэтому пауза не заметна.
const CLOSE_FLUSH_MS = 450

// Preload попапа: патчит tabs.query и первое sendMessage в мире страницы
// (см. src/preload/popup/index.ts — там же причины).
function popupPreload(): string {
  return join(__dirname, '../preload/popup.cjs')
}

// Окно попапа -> вкладка, из-под значка которой он открыт. Preload забирает
// её синхронным IPC: сам попап — чужой контент, и до его скриптов данные
// доходят только так (additionalArguments в argv preload'а не попадают).
const popupTabInfo = new Map<number, { id: number; url: string; title: string; audible: boolean }>()
ipcMain.on('popup:tab-info', (event) => {
  event.returnValue = popupTabInfo.get(event.sender.id) ?? null
})

// RPC из окна попапа. Нужен потому, что страница расширения получает
// урезанный `chrome.tabs` (query есть, create/update/remove/reload — нет),
// а расширения из попапа открывают вкладки и окна (MetaMask так открывает
// онбординг). Обслуживает тот же мост, что и фоновый шим, — с теми же
// проверками прав. Расширение берётся из реестра по id открытого попапа:
// вызов идёт по IPC, и Origin запроса здесь нет.
ipcMain.handle('popup:rpc', (event, method: string, args?: unknown[]) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || popup !== win) throw new Error('not an action popup')
  const rec = popupExtId ? findExtensionRecord(popupExtId) : undefined
  const electronId = rec?.electronId
  if (!electronId) throw new Error('popup extension is not loaded')
  return dispatchExtensionRpc(electronId, String(method), Array.isArray(args) ? args : [])
})

// Страница попапа просит закрытие (window.close из кода расширения;
// в мире страницы его перехватывает preload — см. src/preload/popup/index.ts).
// Гасим окно сразу и уничтожаем с задержкой: страница не должна мелькать,
// пока дожидаемся доставки запросов, отправленных перед закрытием.
ipcMain.on('popup:close-request', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return
  // Запрос от устаревшего попапа (уже заменён новым) игнорируем.
  if (popup !== win) return
  try {
    win.setOpacity(0)
  } catch {
    // Платформа без setOpacity — окно исчезнет обычным закрытием.
  }
  setTimeout(() => {
    if (popup === win) closeActionPopup()
    else if (!win.isDestroyed()) win.destroy()
  }, CLOSE_FLUSH_MS)
})

let popup: BrowserWindow | null = null
// Реестровый id расширения, чей попап сейчас открыт: по нему повторный
// клик по тому же значку закрывает попап (toggle, как в браузерах).
let popupExtId: string | null = null

// Закрыть открытый попап: перед показом нового и при смене вкладки.
export function closeActionPopup(): void {
  if (!popup || popup.isDestroyed()) {
    popup = null
    popupExtId = null
    return
  }
  const win = popup
  popup = null
  popupExtId = null
  win.destroy()
}

export function actionPopupOpen(): boolean {
  return !!popup && !popup.isDestroyed()
}

// id расширения открытого попапа (null — попапа нет). Нужен вызывающему,
// чтобы отличить повторный клик по тому же значку от клика по другому.
export function actionPopupExtensionId(): string | null {
  return actionPopupOpen() ? popupExtId : null
}

// След попапа, закрытого потерей фокуса.
//
// Клик по значку расширения в shell сначала уводит фокус из попапа — окно
// получает blur и закрывается, — и только потом до main доходит IPC клика.
// К этому моменту попапа уже нет, и проверка «открыт ли попап этого
// расширения» отвечает «нет»: вместо закрытия попап открывался заново.
// Поэтому blur-закрытие оставляет след, а обработчик клика его потребляет.
let blurClosedExtId: string | null = null
let blurClosedAt = 0
// Разрыв «blur → IPC» — это один клик пользователя, он укладывается в
// десятки миллисекунд. Окно небольшое намеренно: иначе быстрый повторный
// клик по значку (после закрытия попапа кликом мимо) не открывал бы попап.
const BLUR_TOGGLE_MS = 350

/**
 * Потребляет след blur-закрытия: true — попап этого расширения только что
 * закрылся из-за потери фокуса, значит текущий клик по значку закрывает
 * попап, а не открывает его.
 */
export function consumeBlurClosedPopup(id: string): boolean {
  if (blurClosedExtId !== id) return false
  if (Date.now() - blurClosedAt > BLUR_TOGGLE_MS) {
    blurClosedExtId = null
    return false
  }
  blurClosedExtId = null
  return true
}

export interface PopupAnchor {
  // Координаты кнопки в CSS-пикселях относительно content-области окна.
  x: number
  y: number
  // Правый край кнопки: попап выравнивается им по правому краю, чтобы
  // не вылезти за окно (как меню браузера).
  right: number
}

/**
 * Показать попап расширения под кнопкой.
 *
 * Размер попапа определяет само содержимое: после загрузки дожидаемся,
 * пока страница расширения наполнится, и читаем scrollWidth/scrollHeight
 * её body. Пока не измерили — окно скрыто, чтобы не мелькала пустая рамка
 * чужого размера.
 */
export async function openActionPopup(params: {
  parent: BrowserWindow
  electronId: string
  // Реестровый id расширения: по нему потом находится «свой» попап
  // для toggle (повторный клик закрывает).
  extId: string
  page: string
  anchor: PopupAnchor
}): Promise<boolean> {
  const { parent, electronId, page, anchor } = params
  const rel = page.replace(/^\//, '')
  if (!rel) return false
  closeActionPopup()

  const url = 'chrome-extension://' + electronId + '/' + rel
  const bounds = parent.getContentBounds()

  // Вкладка, из-под значка которой открыт попап. Уходит в preload окна:
  // расширения на старте зовут tabs.query({active:true,currentWindow:true}),
  // а в Electron попап — отдельное окно, и без подсказки «текущей вкладкой»
  // оказывается сам попап (chrome-extension://…). uBlock на этом рисует
  // «not a website» вместо панели (проверено: browser.permissions в попапе
  // тоже undefined, поэтому вычислять вкладку в самой странице нельзя).
  const ws = getState(parent)
  // Схема попапа — по настройкам пространства-родителя: у каждого оно своё.
  const popupWsId = ws?.workspaceId ?? bootWorkspaceId()
  const activeRec = ws && ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  const popupTab = activeRec
    ? {
        id: activeRec.view.webContents.id,
        url: activeRec.url,
        title: activeRec.title,
        // Признак звука вкладки: попап отдаёт его в синтетическом Tab
        // (см. src/preload/popup/index.ts). Расширения-распознаватели
        // музыки отказываются работать, если вкладка «молчит».
        audible:
          !activeRec.view.webContents.isDestroyed() &&
          activeRec.view.webContents.isCurrentlyAudible()
      }
    : null

  const popupWin = new BrowserWindow({
    parent,
    frame: false,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Фон окна — по базовой теме веб-контента: попап расширения это
    // веб-контент. Без явного цвета окно стартует белым и мигает
    // при тёмной схеме (и наоборот). Схему prefers-color-scheme внутри
    // попапа ведет nativeTheme.themeSource — см. browserTheme.ts.
    backgroundColor: webContentBackgroundFor(popupWsId),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    webPreferences: {
      // Партиция пространства окна-родителя: попап должен видеть те же
      // cookies и storage, что и вкладка, иначе расширение работает
      // в чужой сессии. Пространство берём у родителя, а не у реестра:
      // попап всегда открывается из конкретного окна.
      partition: partitionFor(popupWsId),
      contextIsolation: true,
      nodeIntegration: false,
      preload: popupPreload()
    }
  })
  // Регистрируем вкладку для preload'а до загрузки страницы: sync-IPC
  // из preload'а ждёт ответ в момент старта документа.
  const wcId = popupWin.webContents.id
  if (popupTab) popupTabInfo.set(wcId, popupTab)
  popupWin.on('closed', () => popupTabInfo.delete(wcId))
  // Used-схема попапа: цвет ползунка, формы, канвас. prefers-color-scheme
  // внутри него ведет nativeTheme.themeSource (см. browserTheme.ts).
  void popupWin.webContents
    .insertCSS(`:root { color-scheme: ${schemeForWorkspace(popupWsId)} !important; }`, {
      cssOrigin: 'author'
    })
    .catch(() => undefined)

  let opened = false
  // Окно получает фокус после show(), и первое же событие blur может
  // прийти от окна-родителя, которое в этот момент теряло фокус. Без
  // задержки попап закрывался бы сразу после открытия.
  let blurArmed = false
  popupExtId = params.extId
  popupWin.webContents.on('did-finish-load', () => {
    void (async () => {
      try {
        // Размер берём из body, а не из documentElement.
        //
        // Попап расширения — фиксированная панель: его body задаёт свой
        // естественный размер (у uBlock — компактная колонка ~273px), а
        // documentElement в flex-раскладке растянут на всё окно и вернул бы
        // размер самого окна. Из-за этого попап не подстраивался под
        // содержимое и оставался пустой полосой внизу и справа.
        //
        // Ждём, пока содержимое отрисуется: uBlock держит body в состоянии
        // `loading` (visibility: hidden) и наполняет его асинхронно после
        // ответа фонового воркера. Мерять сразу после загрузки бессмысленно.
        const size = (await popupWin.webContents.executeJavaScript(`(async () => {
          const t0 = Date.now();
          const isBusy = () => document.body && (
            document.body.classList.contains('loading') ||
            document.body.classList.contains('busy')
          );
          // Ждём и снятия busy-состояния, и непустого тела: сразу после
          // загрузки body бывает нулевой высоты (замер: 400x0), и окно
          // показывалось полоской, а затем прыгало до реального размера.
          while (Date.now() - t0 < 1500) {
            const h = document.body ? document.body.scrollHeight : 0;
            if (!isBusy() && h > 0) break;
            await new Promise((r) => setTimeout(r, 40));
          }
          return JSON.stringify({
            w: document.body.scrollWidth,
            h: document.body.scrollHeight
          });
        })()`)) as string
        const parsed = JSON.parse(size) as { w?: number; h?: number }
        const base = {
          x: Math.round(bounds.x + anchor.right),
          y: Math.round(bounds.y + anchor.y + 4),
          screenX: Math.max(0, parent.getBounds().x + anchor.right),
          screenY: parent.getBounds().y + anchor.y + 4
        }
        let last = { w: parsed.w ?? DEFAULT_WIDTH, h: parsed.h ?? DEFAULT_HEIGHT }
        applyPopupBounds(popupWin, {
          width: Math.max(MIN_WIDTH, Math.min(last.w, MAX_WIDTH)),
          height: Math.max(MIN_HEIGHT, Math.min(last.h, MAX_HEIGHT)),
          ...base
        })
        // Содержимое многих попапов дорастает ПОСЛЕ загрузки: панель строится
        // по ответу фона (Tampermonkey — меню и подсказка), поэтому одного
        // замера мало. В Chrome попап пересчитывает размер при каждом
        // изменении документа; повторяем это: следим за body и двигаем окно,
        // пока размер меняется, но не дольше окна наблюдения.
        const watchUntil = Date.now() + POPUP_WATCH_MS
        const track = setInterval(() => {
          if (popupWin.isDestroyed() || popup !== popupWin) {
            clearInterval(track)
            return
          }
          if (Date.now() > watchUntil) {
            clearInterval(track)
            return
          }
          void popupWin.webContents
            .executeJavaScript(
              `JSON.stringify({ w: document.body.scrollWidth, h: document.body.scrollHeight })`
            )
            .then((r: unknown) => {
              const next = JSON.parse(String(r)) as { w?: number; h?: number }
              const w = next.w ?? last.w
              const h = next.h ?? last.h
              if (Math.abs(w - last.w) < SIZE_EPSILON && Math.abs(h - last.h) < SIZE_EPSILON) return
              last = { w, h }
              applyPopupBounds(popupWin, {
                width: Math.max(MIN_WIDTH, Math.min(w, MAX_WIDTH)),
                height: Math.max(MIN_HEIGHT, Math.min(h, MAX_HEIGHT)),
                ...base
              })
            })
            .catch(() => {
              // Страница могла уйти навигацией — прекращаем наблюдение.
              clearInterval(track)
            })
        }, POPUP_WATCH_STEP_MS)
        popupWin.on('closed', () => clearInterval(track))
      } catch (e) {
        logError('popup: measure failed — ' + String(e))
        applyPopupBounds(popupWin, {
          width: DEFAULT_WIDTH,
          height: DEFAULT_HEIGHT,
          x: Math.round(bounds.x + anchor.right),
          y: Math.round(bounds.y + anchor.y + 4),
          screenX: Math.max(0, parent.getBounds().x + anchor.right),
          screenY: parent.getBounds().y + anchor.y + 4
        })
      }
      if (!popupWin.isDestroyed()) popupWin.show()
      opened = true
      setTimeout(() => {
        blurArmed = true
      }, 250)
    })()
  })

  // Клик мимо (окно потеряло фокус) закрывает попап — так делают браузеры.
  // След закрытия нужен, чтобы клик по значку, вызвавший этот blur, закрыл
  // попап вместо повторного открытия (см. consumeBlurClosedPopup).
  popupWin.on('blur', () => {
    if (!blurArmed) return
    if (popup === popupWin) {
      blurClosedExtId = popupExtId
      blurClosedAt = Date.now()
      closeActionPopup()
    }
  })
  popupWin.on('closed', () => {
    if (popup === popupWin) popup = null
  })

  popup = popupWin
  // Новый попап открывается — прежний след blur-закрытия больше не актуален.
  blurClosedExtId = null
  try {
    await popupWin.loadURL(url)
  } catch (e) {
    logError('popup: load failed for ' + url + ' — ' + String(e))
    closeActionPopup()
    return false
  }
  return opened || !popupWin.isDestroyed()
}

interface PopupBounds {
  width: number
  height: number
  // Координаты относительно окна-родителя (для setBounds с parent).
  x: number
  y: number
  // Экранные координаты — только для клампа по рабочей области.
  screenX: number
  screenY: number
}

// Позиция с учётом края экрана: попап не должен уезжать за границу
// рабочей области, иначе его нижняя часть недоступна.
function applyPopupBounds(win: BrowserWindow, b: PopupBounds): void {
  if (win.isDestroyed()) return
  const work = screen.getDisplayNearestPoint({ x: b.screenX, y: b.screenY }).workArea
  const screenX = Math.max(work.x, Math.min(b.screenX - b.width + 4, work.x + work.width - b.width))
  const screenY = Math.min(b.screenY, work.y + work.height - b.height)
  win.setBounds({
    x: Math.round(screenX),
    y: Math.round(screenY),
    width: Math.round(b.width),
    height: Math.round(b.height)
  })
}

// Проверка существования страницы попапа в каталоге расширения:
// манифест может ссылаться на файл, которого нет (битая сборка).
export function popupPageExists(dir: string, page: string): boolean {
  return existsSync(join(dir, page.replace(/^\//, '')))
}
