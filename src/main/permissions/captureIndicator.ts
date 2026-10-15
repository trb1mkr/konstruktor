// Индикатор захвата: какие вкладки держат камеру, микрофон или экран.
//
// Electron не сообщает о начале и конце захвата — `webContents` знает
// только про звук воспроизведения (`isCurrentlyAudible`), а не про
// захват. Поэтому о захвате узнаём из самой страницы: main кладёт в её
// ГЛАВНЫЙ мир небольшой скрипт, который оборачивает
// `getUserMedia`/`getDisplayMedia` и сообщает о появлении и остановке
// треков.
//
// Путь сообщения: главный мир -> window.postMessage (DOM-событие видят все
// миры документа) -> изолированный мир прелоада -> ipcRenderer ->
// `permissions:capture` -> карта вкладки -> `tabs:state` -> бейдж в
// адресной строке.
//
// Граница доверия: страница может подделать сообщение и показать ложный
// индикатор. Риск принят осознанно — индикатор только отображает
// состояние и ничего не разрешает; защита от подделки потребовала бы
// канала, которого у главного мира нет.
import { ipcMain, type WebContents } from 'electron'
import {
  getState,
  parentOfSenderView,
  type TabData,
  type WindowState,
} from '../windows/browserState'
import { log } from '../overlay/logger'

// Обработчик изменений захвата регистрирует permissions/permissionManager:
// ему нужен pushTabsState, а прямой импорт tabsManager отсюда дал бы цикл
// (tabsManager сам импортирует этот модуль ради инъекции хука).
let captureChanged: ((ws: WindowState) => void) | null = null

/** Подписывает владельца состояния вкладок на изменение захвата. */
export function setCaptureChangeHandler(fn: (ws: WindowState) => void): void {
  captureChanged = fn
}

/** Виды захвата, о которых умеет сообщать страница. */
export type CaptureKind = 'audio' | 'video' | 'screen'

/**
 * Скрипт для главного мира страницы.
 *
 * Обёртка ставится на сами методы `navigator.mediaDevices`, а не на
 * прототип: подменять прототип значило бы влиять на чужой код шире, чем
 * нужно, а страница обычно держит ссылку на объект `mediaDevices`, а не
 * на метод отдельно. Повторная установка отсекается флагом — скрипт
 * приходит на каждую навигацию.
 */
export const CAPTURE_HOOK_SOURCE = `(() => {
  if (window.__konstruktorCaptureHook) return;
  window.__konstruktorCaptureHook = true;
  const post = (kind, active) => {
    try { window.postMessage({ __konstruktorCapture: true, kind, active }, '*'); } catch (e) {}
  };
  const md = navigator.mediaDevices;
  if (!md) return;
  const wrap = (name, forced) => {
    const original = md[name];
    if (typeof original !== 'function') return;
    md[name] = function (...args) {
      return original.apply(this, args).then((stream) => {
        const seen = {};
        const tracks = stream && stream.getTracks ? stream.getTracks() : [];
        for (const track of tracks) {
          if (!track || track.readyState !== 'live') continue;
          const kind = forced || (track.kind === 'audio' ? 'audio' : 'video');
          if (seen[kind]) continue;
          seen[kind] = true;
          post(kind, true);
          try {
            track.addEventListener('ended', () => post(kind, false));
          } catch (e) {}
        }
        return stream;
      });
    };
  };
  wrap('getUserMedia', null);
  wrap('getDisplayMedia', 'screen');
})()`

/** Ставит обёртку в страницу. Вызывается на каждую навигацию вкладки. */
export function installCaptureHook(wc: WebContents): void {
  if (wc.isDestroyed()) return
  // Только http(s): у внутренних страниц и страниц расширений захвата нет,
  // а лишняя инъекция — лишний риск сломать их собственную разметку.
  if (!/^https?:/i.test(wc.getURL())) return
  wc.executeJavaScript(CAPTURE_HOOK_SOURCE, false).catch(() => undefined)
}

/**
 * Принимает отчёт страницы о захвате и обновляет карту вкладки.
 *
 * Регистрируется один раз: ipcMain.on('permissions:capture'). Карта держит
 * признак по видам раздельно — страница может одновременно захватывать
 * камеру и микрофон, и один общий флаг скрыл бы остановку одного из них.
 */
export function registerCaptureIpc(): void {
  ipcMain.on('permissions:capture', (e, kind: CaptureKind, active: boolean) => {
    if (kind !== 'audio' && kind !== 'video' && kind !== 'screen') return
    const win = parentOfSenderView(e.sender)
    const ws = win ? getState(win) : undefined
    if (!ws) return
    let rec: TabData | undefined
    let tabId: number | undefined
    for (const [id, tab] of ws.tabs) {
      if (tab.view?.webContents?.id === e.sender.id) {
        rec = tab
        tabId = id
        break
      }
    }
    if (!rec) return
    const next = { audio: false, video: false, screen: false, ...(rec.capturing ?? {}) }
    if (next[kind] === active) return
    next[kind] = active
    // Пустое состояние не храним: булев набор из трёх false — то же
    // отсутствие захвата, а лишнее поле тянулось бы в каждый tabs:state.
    rec.capturing = next.audio || next.video || next.screen ? next : undefined
    log('session', 'capture state changed', {
      tabId,
      kind,
      active,
      capturing: rec.capturing,
    })
    captureChanged?.(ws)
  })
}
