// Контекстное меню веб-страницы: ПКМ по сайту и Shift+F10.
// Выделено в кластер tabs/ по образцу tabsMenu.ts: чистый билдер пунктов
// (buildPageMenu) и показ через showOverlay, действия — в onSelect.
// Системный Menu.popup не используется: на Windows он всегда светлый и не
// стилизуется, поэтому меню рисует overlay-окно (kind: 'menu').
//
// ГРАНИЦА ФАЙЛА: параметры события 'context-menu' от view вкладки и действия
// над ней. Зависимости, которым нужны окна (открыть вкладку/окно, инспектор),
// приходят через PageMenuDeps: модуль не импортирует windows/, иначе связка
// tabs -> pageMenu -> deps замкнула бы цикл.
import {
  clipboard,
  dialog,
  type BrowserWindow,
  type ContextMenuParams,
  type WebContents
} from 'electron'
import { findTab, type TabData, type WindowState } from '../windows/browserState'
import { showOverlay, type OverlayMenuItem } from '../overlay'
import { getSettingsSync } from '../store/settingsStore'
import { t } from '../i18n'

export interface PageMenuDeps {
  // Открыть URL вкладкой в окне, где вызвано меню.
  openTab: (ws: WindowState, url: string) => void
  // Открыть URL в новом окне.
  openWindow: (url: string) => void
  // Открыть DevTools (если закрыты) и подсветить элемент в точке x/y.
  inspectAt: (ws: WindowState, tabId: number, x: number, y: number) => void
}

// Схемы, которым разрешено открываться вкладкой/окном. Остальное
// (javascript:, mailto:, data:) — пункты «открыть» не показываются.
const OPEN_SCHEMES = /^(https?|konstruktor|file):/i

type PageContext = 'page' | 'image' | 'selection' | 'link'

function canOpen(url: string): boolean {
  return OPEN_SCHEMES.test(url)
}

// Приоритет контекста — цепочка Chrome: поле ввода, ссылка, изображение,
// выделение, страница. null = показывать нечего: editable-контекст отдан
// второй фазе (Cut/Copy/Paste через editFlags), он же закрывает и выделение
// внутри поля ввода.
function detectContext(params: ContextMenuParams): PageContext | null {
  if (params.isEditable) return null
  if (params.linkURL) return 'link'
  if (params.mediaType === 'image' && params.srcURL) return 'image'
  if (params.selectionText.trim()) return 'selection'
  return 'page'
}

// Аргумент поиска: выделение -> текст ссылки -> URL страницы. Для ссылки
// первым идёт её текст (как в Chrome), для выделения — само выделение.
//
// Текст НЕ обрезается. Обрезка осталась бы от подписи пункта, но уезжала
// в сам запрос: длинное выделение искалось по первым сорока символам с
// многоточием в конце. Нормализуются только пробелы — многострочное
// выделение схлопывается в одну строку запроса.
function searchArg(params: ContextMenuParams, ctx: PageContext): string {
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  const sel = flat(params.selectionText)
  if (ctx === 'link') return flat(params.linkText) || sel || params.linkURL || params.pageURL
  if (ctx === 'selection') return sel
  return sel || params.linkURL || params.pageURL
}

// Общий хвост: разделитель, поиск, исходник страницы, инспектор.
// Один набор на все контексты — без дублей между блоками.
function commonTail(searchLabel: string): OverlayMenuItem[] {
  return [
    { id: 'sep-tail', label: '', icon: '', separator: true },
    { id: 'search', label: searchLabel, icon: '🔍' },
    { id: 'view-source', label: t('pageMenu.viewSource'), icon: '📄' },
    { id: 'inspect', label: t('pageMenu.inspect'), icon: '🛠️' }
  ]
}

export interface PageMenuContext {
  kind: PageContext
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * Собрать пункты контекстного меню для detected-контекста.
 *
 * Пункт не показывается, если контекст его не даёт: у ссылки и изображения
 * скрываются «открыть» при неразрешённой схеме, у редактируемого поля меню
 * нет вовсе (detectContext вернул null до сюда).
 */
export function buildPageMenu(params: ContextMenuParams, ctx: PageMenuContext): OverlayMenuItem[] {
  // Подпись поиска — без пояснений: название движка и текст запроса
  // удлиняли пункт, а движок берётся из настроек в момент выбора, поэтому
  // в подписи он был бы либо повтором, либо устаревшим значением.
  const tail = commonTail(t('pageMenu.search'))

  if (ctx.kind === 'link') {
    const items: OverlayMenuItem[] = []
    if (canOpen(params.linkURL)) {
      items.push(
        { id: 'open-link-tab', label: t('pageMenu.openLinkTab'), icon: '＋' },
        { id: 'open-link-window', label: t('pageMenu.openLinkWindow'), icon: '🗗' }
      )
    }
    items.push(
      { id: 'save-link', label: t('pageMenu.saveLink'), icon: '💾' },
      { id: 'copy-link-address', label: t('pageMenu.copyLinkAddress'), icon: '🔗' },
      { id: 'copy-link-text', label: t('pageMenu.copyLinkText'), icon: '📋' }
    )
    return [...items, ...tail]
  }

  if (ctx.kind === 'image') {
    const items: OverlayMenuItem[] = []
    if (canOpen(params.srcURL)) {
      items.push(
        { id: 'open-image-tab', label: t('pageMenu.openImageTab'), icon: '＋' },
        { id: 'open-image-window', label: t('pageMenu.openImageWindow'), icon: '🗗' }
      )
    }
    items.push(
      { id: 'save-image', label: t('pageMenu.saveImage'), icon: '💾' },
      { id: 'copy-image-address', label: t('pageMenu.copyImageAddress'), icon: '🔗' }
    )
    return [...items, ...tail]
  }

  if (ctx.kind === 'selection') {
    return [{ id: 'copy', label: t('pageMenu.copy'), icon: '📋' }, ...tail]
  }

  return [
    { id: 'back', label: t('pageMenu.back'), icon: '◀️', disabled: !ctx.canGoBack },
    { id: 'forward', label: t('pageMenu.forward'), icon: '▶️', disabled: !ctx.canGoForward },
    { id: 'reload', label: t('pageMenu.reload'), icon: '🔄' },
    { id: 'sep-nav', label: '', icon: '', separator: true },
    { id: 'save-page', label: t('pageMenu.savePage'), icon: '💾' },
    { id: 'print', label: t('pageMenu.print'), icon: '🖨️' },
    ...tail
  ]
}

// Сохранение страницы: системный диалог + savePage.
// savePage не проходит через will-download, поэтому тост шлём сами.
async function savePageAs(win: BrowserWindow, wc: WebContents, rec: TabData): Promise<void> {
  const base = (rec.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80).trim() || 'page'
  try {
    const res = await dialog.showSaveDialog(win, {
      title: t('pageMenu.savePage'),
      defaultPath: `${base}.html`,
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
    })
    if (res.canceled || !res.filePath) return
    await wc.savePage(res.filePath, 'HTMLComplete')
    showOverlay(win, {
      kind: 'toast',
      // anchor у тоста игнорируется: положение считает geometry по углу workArea.
      anchor: { x: 0, y: 0 },
      toast: { title: t('toast.downloadComplete'), body: res.filePath.split(/[\\/]/).pop() ?? '' }
    })
  } catch (err) {
    console.error('[pageMenu] save page failed:', err)
  }
}

/**
 * Показать контекстное меню страницы в точке вызова.
 *
 * tabId — из замыкания хука в createTab; ws ищется заново через findTab,
 * потому что tabs:attach/detach переносит view в другое окно. Внутренние
 * страницы (`konstruktor://`) меню не получают: своя Vue-оболочка.
 *
 * anchor — точка клика в координатах content-области окна: позиция view
 * (view.getBounds — относительно contentView) + координаты кадра params.
 * params.x/y приходят в DIP viewport вызвавшего вида и не меняются при зуме,
 * прокрутке и из iframe (проверено пробником: 80/100/150% и сабфрейм дают
 * те же координаты основного вида). Кламп в workArea уже в geometry.ts.
 */
export function showPageContextMenu(
  deps: PageMenuDeps,
  tabId: number,
  params: ContextMenuParams
): void {
  // Свежее состояние: вкладка могла переехать в другое окно или закрыться.
  const found = findTab(tabId)
  if (!found) return
  const { ws, rec } = found
  const win = ws.window
  if (!win || win.isDestroyed()) return
  const wc = rec.view.webContents
  if (wc.isDestroyed()) return
  if (params.pageURL.startsWith('konstruktor://')) return
  const kind = detectContext(params)
  if (!kind) return

  const items = buildPageMenu(params, {
    kind,
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward()
  })
  const vb = rec.view.getBounds()
  showOverlay(win, {
    kind: 'menu',
    anchor: { x: Math.round(vb.x + params.x), y: Math.round(vb.y + params.y) },
    items,
    align: 'start',
    onSelect: (action) => {
      // Действия тоже по свежему состоянию: меню могло пережить переезд вкладки.
      const now = findTab(tabId)
      if (!now) return
      const { ws: liveWs, rec: liveRec } = now
      const live = liveRec.view.webContents
      if (live.isDestroyed()) return
      if (action === 'back') {
        live.navigationHistory.goBack()
      } else if (action === 'forward') {
        live.navigationHistory.goForward()
      } else if (action === 'reload') {
        live.reload()
      } else if (action === 'save-page') {
        const parent = liveWs.window
        if (parent) void savePageAs(parent, live, liveRec)
      } else if (action === 'print') {
        live.print()
      } else if (action === 'open-image-tab') {
        if (canOpen(params.srcURL)) deps.openTab(liveWs, params.srcURL)
      } else if (action === 'open-image-window') {
        if (canOpen(params.srcURL)) deps.openWindow(params.srcURL)
      } else if (action === 'save-image') {
        live.downloadURL(params.srcURL)
      } else if (action === 'copy-image-address') {
        clipboard.writeText(params.srcURL)
      } else if (action === 'copy') {
        live.copy()
      } else if (action === 'open-link-tab') {
        if (canOpen(params.linkURL)) deps.openTab(liveWs, params.linkURL)
      } else if (action === 'open-link-window') {
        if (canOpen(params.linkURL)) deps.openWindow(params.linkURL)
      } else if (action === 'save-link') {
        live.downloadURL(params.linkURL)
      } else if (action === 'copy-link-address') {
        clipboard.writeText(params.linkURL)
      } else if (action === 'copy-link-text') {
        clipboard.writeText(params.linkText)
      } else if (action === 'search') {
        // Движок — из настроек браузера (`searchEngine`), тот же, что у
        // адресной строки: своего движка у меню нет, и хардкода Google в
        // нём тоже. Читаем в момент выбора, а не при сборке меню, — иначе
        // смена настройки не подействовала бы на открытое меню.
        const template = getSettingsSync().searchEngine
        const url = template.replace('%s', encodeURIComponent(searchArg(params, kind)))
        void live.loadURL(url).catch((err: unknown) =>
          console.error('[pageMenu] search load failed:', err)
        )
      } else if (action === 'view-source') {
        deps.openTab(liveWs, `view-source:${params.pageURL}`)
      } else if (action === 'inspect') {
        deps.inspectAt(liveWs, tabId, params.x, params.y)
      }
    }
  })
}
