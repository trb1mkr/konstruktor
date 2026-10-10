// Масштаб страницы: процентная лестница, применение к WebContents и
// попап управления зумом (оверлей kind 'zoom').
//
// Лестница СВОЯ, а не Chromium'овская (setZoomLevel, шаг 1.2^N): проценты
// в badge и в поле ввода должны быть целыми и совпадать с кнопками попапа.
// Ручной ввод живёт рядом со ступенями (137% между 125 и 150) и не
// ломает следующий шаг лестницы.
//
// Зум per-webContents НЕТ: режим по умолчанию — per-origin (как в Chrome),
// поэтому вкладки одного сайта делят масштаб, а он переживает навигацию
// сам, через partition. Файл не импортирует tabsManager: pushTabsState
// приходит аргументом, и цикла tabsManager -> zoomManager -> tabsManager
// не возникает.
import type { BrowserWindow, WebContents } from 'electron'
import { windows, type WindowState } from './windows/browserState'
import { getSettingsSync } from './store/settingsStore'
import { getActiveRequest, showOverlay, updateActiveOverlay } from './overlay'

// Границы зума. Потолок и пол — ОБЪЕКТИВНЫЕ: Chromium клампит
// setZoomFactor в диапазон 0.25..5.0 (25..500%), и любое значение вне
// него молча превращается в край. Свой пол 10 из раннего плана
// расходился с этим: setZoom(10) вернул бы 10, а страница показала бы 25.
export const ZOOM_MIN = 25
export const ZOOM_MAX = 500

// Прогрессивная лестница. Значения — целые проценты: дробные в badge
// выглядят как баг (99.9999%), а округление на каждом шаге копило бы
// ошибку.
export const ZOOM_LADDER = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
]

/** Кламп ручного ввода в [25, 500] + округление до целого процента. */
export function clampPercent(raw: number): number {
  if (!Number.isFinite(raw)) return 100
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(raw)))
}

/**
 * Следующая ступень лестницы от текущего процента.
 *
 * Текущее значение может не попадать в лестницу (ручной ввод 137) —
 * тогда берётся ближайшая ступень СВЕРХУ (150) или СНИЗУ (125), без
 * прыжка через введённое значение.
 */
export function ladderStep(percent: number, dir: 1 | -1): number {
  const p = clampPercent(percent)
  if (dir === 1) {
    for (const v of ZOOM_LADDER) if (v > p) return v
    return ZOOM_LADDER[ZOOM_LADDER.length - 1]
  }
  for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
    const v = ZOOM_LADDER[i]
    if (v < p) return v
  }
  return ZOOM_LADDER[0]
}

/** Текущий масштаб webContents в процентах. 100 вместо исключений. */
export function percentOf(wc: WebContents): number {
  try {
    if (wc.isDestroyed()) return 100
    return Math.round(wc.getZoomFactor() * 100)
  } catch {
    return 100
  }
}

/** Применить конкретный процент. Возвращает фактически применённое значение. */
export function setZoom(wc: WebContents, percent: number): number {
  const p = clampPercent(percent)
  try {
    if (!wc.isDestroyed()) wc.setZoomFactor(p / 100)
  } catch {
    // view умерла между вызовом и применением — не критично.
  }
  // Опрос ПОСЛЕ применения: Chromium клампит свой диапазон сам, и
  // возвращать надо реально стоящий процент, иначе badge/поле попапа
  // разошлись бы со страницей на краю шкалы.
  return percentOf(wc)
}

/** Активная view окна — цель применения зума и источник процента шага. */
export function activeWcOf(ws: WindowState): WebContents | undefined {
  const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  return rec ? rec.view.webContents : undefined
}

/**
 * Режим `webContents.setZoomMode` из настроек.
 *
 * 'origin' (default) — per-origin поведение Chromium: зум делится всеми
 * вкладками сайта и хранится в partition. 'tab' — isolated: зум
 * принадлежит вкладке, переживает навигации внутри неё и умирает вместе
 * с ней, поэтому новая вкладка с тем же адресом стартует со 100%.
 */
export function zoomModeFor(settings: { zoomMode?: string }): 'isolated' | 'default' {
  return settings.zoomMode === 'tab' ? 'isolated' : 'default'
}

// Последний процент при включённом едином зуме: им открываются новые
// вкладки. Сессионная переменная, а не settings.json — писать файл на
// каждый шаг лестницы значило бы запись на каждое нажатие.
let syncedPercent = 100

/** Процент для новой вкладки при едином зуме (100, пока зум не меняли). */
export function seedZoomPercent(): number {
  return syncedPercent
}

// Что пришло из before-input-event view или окна. Структура — под
// Electron.Input, но объявленная сама: модуль не тянет electron-тип в
// сигнатуру ради одной функции.
export interface ZoomKeyInput {
  type: string
  code?: string
  control: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

/**
 * Разбор сочетания клавиш зума: Ctrl/Cmd + `=`/`-`/`0`.
 *
 * Решается по `input.code` (физическая клавиша), а НЕ по `key`:
 * на русской раскладке `key` = 'ф'/'+' не совпадает с ожидаемым, и зум
 * молча не срабатывал бы — та же история, что с Ctrl+F, разобранная
 * в FIND.md («Ctrl+F и раскладка»).
 *
 * shift НЕ исключается: на части раскладок `+` даёт именно Shift+Equal,
 * и Ctrl+Shift+= — штатный «зум вверх» в Chrome/Yandex. Вычитается
 * только alt — это уже системное сочетание.
 */
export function zoomShortcut(input: ZoomKeyInput): 1 | -1 | 0 | null {
  if (input.type !== 'keyDown') return null
  if (!(input.control || input.meta) || input.alt) return null
  const code = input.code ?? ''
  if (code === 'Equal' || code === 'NumpadAdd') return 1
  if (code === 'Minus' || code === 'NumpadSubtract') return -1
  if (code === 'Digit0' || code === 'Numpad0') return 0
  return null
}

/**
 * Применить процент к активной вкладке и пушнуть затронутые окна.
 *
 * ЕДИНСТВЕННАЯ точка применения зума: клавиши (view и окно), Ctrl+колесо,
 * IPC и кнопки попапа сходятся сюда — иначе режим единого зума пришлось
 * бы дублировать в каждой точке, и одна забытая сломала бы его молча.
 *
 * При `zoomSync` процент применяется ко всем вкладкам ВСЕХ окон (один
 * зум на весь браузер), затронутые окна пушатся по одному разу.
 */
export function applyZoomToWs(
  ws: WindowState,
  percent: number,
  push: (ws: WindowState) => void
): number {
  const p = clampPercent(percent)
  if (!getSettingsSync().zoomSync) {
    const wc = activeWcOf(ws)
    const applied = wc ? setZoom(wc, p) : 100
    push(ws)
    return applied
  }
  syncedPercent = p
  let applied = p
  for (const other of windows.values()) {
    if (other.tabs.size === 0) continue
    for (const rec of other.tabs.values()) {
      applied = setZoom(rec.view.webContents, p)
    }
    push(other)
  }
  return applied
}

/** Шаг по лестнице от процента АКТИВНОЙ вкладки (с учётом единого зума). */
export function stepActiveZoom(
  ws: WindowState,
  dir: 1 | -1,
  push: (ws: WindowState) => void
): number {
  const wc = activeWcOf(ws)
  const from = wc ? percentOf(wc) : 100
  return applyZoomToWs(ws, ladderStep(from, dir), push)
}

/**
 * Синхронизация открытого попапа зума с фактическим процентом страницы.
 *
 * Вызывается из pushTabsState — единственной точки, куда сходятся ВСЕ
 * изменения зума: клавиши, Ctrl+колесо, IPC, само нажатие `+` в попапе.
 * Без этого поле попапа не менялось бы при зуме колесом: такие изменения
 * минуют onSelect и шли только в badge.
 *
 * Патч уходит только при активной сессии zoom (чужая поверхность поля не
 * имеет), и только если процент реально изменился: одинаковое значение
 * Vue-watch в компоненте не увидит, а набираемый в поле текст не перетрётся.
 */
export function syncZoomPopup(ws: WindowState): void {
  const win = ws.window
  if (!win || win.isDestroyed()) return
  const req = getActiveRequest(win)
  if (!req || req.kind !== 'zoom') return
  const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  const percent = rec ? percentOf(rec.view.webContents) : 100
  if (req.zoom && req.zoom.percent === percent) return
  // request.zoom — тот же объект, что шёл в push: пересборка геометрии
  // (измерение, возврат по Esc) покажет уже примененный процент.
  if (req.zoom) req.zoom.percent = percent
  updateActiveOverlay(win, { zoom: { percent } })
}

/**
 * Открыть попап масштаба у индикатора в адресной строке.
 *
 * @param win    окно-родитель оверлея (shell-окно)
 * @param ws     состояние окна; активная вкладка — та, чей зум правится
 * @param anchor правый НИЖНИЙ угол бейджа в координатах content-области
 *               (тот же контракт, что у menu:popup кнопки ☰)
 * @param push   pushTabsState из вызывающего кода — без импорта tabsManager.
 *               Именно он дергает syncZoomPopup, поэтому патч попапа
 *               обязателен лежать в нем, а не в apply.
 */
export function openZoomPopup(
  win: BrowserWindow,
  ws: WindowState,
  anchor: { x: number; y: number },
  push: (ws: WindowState) => void
): void {
  const rec = ws.activeTabId !== null ? ws.tabs.get(ws.activeTabId) : undefined
  if (!rec) return
  const wc = rec.view.webContents
  // Модель — общий объект с request.zoom: main пересобирает push из
  // request (измерение, возврат по Esc), а патч уходит в renderer
  // точечно. Два независимых поля разошлись бы при первом же `+`.
  const model = { percent: percentOf(wc) }
  const apply = (percent: number): void => {
    // Через applyZoomToWs, а не setZoom(wc): при едином зуме процент
    // уедет и в другие вкладки. pushTabsState -> syncZoomPopup патчит
    // поле попапа и обновляет request.zoom — отдельный
    // updateActiveOverlay здесь был бы второй копией того же патча.
    applyZoomToWs(ws, percent, push)
  }
  showOverlay(win, {
    kind: 'zoom',
    anchor,
    zoom: model,
    toggleKey: 'zoom-badge',
    // `+`/`−`/`Reset` держат попап открытым: закрытие после каждого шага
    // превратило бы лестницу в серию переоткрытий. Ручной ввод (submit)
    // сюда не попадает — он закрывает сессию штатно через resolveOverlaySubmit.
    holdOnSelect: (id) => id === 'zoom-in' || id === 'zoom-out' || id === 'zoom-reset',
    onSelect: (id) => {
      if (id === 'zoom-in') {
        apply(ladderStep(percentOf(wc), 1))
        return
      }
      if (id === 'zoom-out') {
        apply(ladderStep(percentOf(wc), -1))
        return
      }
      if (id === 'zoom-reset') {
        apply(100)
        return
      }
      // submit поля: "137" или "137%" — процентом считаем число.
      const parsed = Number.parseInt(id.replace('%', '').trim(), 10)
      if (Number.isFinite(parsed)) apply(parsed)
    }
  })
}
