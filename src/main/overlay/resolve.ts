// Команды renderer'а оверлея: select, dismiss, submit, submit-icon.
// Выделено из service.ts: разбор команды и её резолв, без логики показа
// (service.ts) и без механики закрытия (close.ts).
//
// Команды приходят от renderer'а оверлея, а адресованы родителю.
// Родителя находим через обратную карту сессий (session.ts), а не перебором.
import { BrowserWindow, dialog } from 'electron'
import { t } from '../i18n'
import { log, logError } from './logger'
import { hideContent } from './pool'
import { clearSession, isTopSession, parentIdOfOverlay, sessionOf } from './session'
import { closeOverlay, setSystemDialogOpen, updateActiveOverlay } from './close'
import { verifyIconSource, verifyEmojiButton, fileToIconDataUrl } from './iconVerify'
import type { OverlayRequest } from './service'

export function resolveOverlaySelect(overlay: BrowserWindow, id: string): void {
  // IPC-канал открытый: не-строка приходит, если renderer прислал
  // нативный DOM-Event (выделение текста в поле поверхности пузырится до
  // корня как 'select', см. OverlayRoot.onSelect). Такая «команда» не
  // существует — гасим до onSelect, иначе упавший хендлер роняет весь
  // IPC-вызов с TypeError в логах.
  if (typeof id !== 'string') {
    log('error', 'select with non-string id, ignored', { got: typeof id })
    return
  }
  log('command', `select: ${id}`)
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) return
  const entry = sessionOf<OverlayRequest>(parentId)
  if (!entry) return
  {
    const parent = BrowserWindow.fromId(parentId)
    entry.request.onSelect?.(id)
    // Сессия просит остаться открытой после выбора: попап зума (`+`/`−`/
    // `Reset` обновили процент через overlay:update и держат себя же).
    // Проверка ДО логики stillTop: onSelect не открывал новую сессию, а
    // закрывать обновлённый попап значит потерять его после каждого шага.
    if (entry.request.holdOnSelect?.(id)) {
      log('command', 'select keeps overlay open', { parentId, id })
      return
    }
    // onSelect умеет открыть новое оверлей-поверх (меню -> диалог иконки).
    // active уже указывает на новую сессию, и её закрывать нельзя —
    // иначе диалог живёт одну вспышку. Но парковать СТАРОЕ содержимое
    // тоже нельзя: если новая сессия ещё грузится, пользователь увидит
    // пункты предыдущего меню на новом месте. Поэтому проверяем, что
    // активна именно та же сессия — по её токену, а НЕ по окну: окно
    // из пула у всех сессий одно и то же, сравнение всегда истинно,
    // и проверка не срабатывала НИКОГДА. Из-за этого диалог иконки
    // открывался только со второго раза.
    // Именно ВЕРХНЯ ЛИ СЕССИЯ. isCurrentSession тут не годится: в стеке
    // он отвечает на вопрос «есть ли сессия в стеке вообще», а нужен
    // другой — «не открыла ли onSelect новую сессию поверх меня». После
    // шага 8 проверка на isCurrentSession давала «та же самая», и
    // closeOverlay закрывал только что открытый диалог вместо того, чтобы
    // его оставить.
    const stillTop = isTopSession(parentId, entry.sessionId)
    if (!stillTop) {
      // onSelect открыл новую сессию поверх текущей (меню -> диалог
      // иконки). active уже указывает на неё, и её закрывать нельзя:
      // диалог жил бы ноль времени — открылся и тут же исчез, что и
      // выглядело как «Cancel не работает».
      //
      // Старое содержимое тоже не трогаем: размонтит его новая
      // сессия своим setContentUnmounted(true), а если она ещё грузится, то
      // размонтирование покажет пользователю пустое окно вместо
      // прежних пунктов. Поэтому просто выходим — showOverlay новой
      // сессии уже отправил все нужные сообщения.
      log('command', 'select opened new session, keeping it open', {
        parentId,
        closed: entry.sessionId,
        current: sessionOf<OverlayRequest>(parentId)?.sessionId
      })
      return
    }
    if (parent) closeOverlay(parent)
    else {
      clearSession(parentId)
      try {
        // hide(), а не close(): родитель уже мёртв, но окно держим
        // в пуле, если оно переиспользуемо.
        hideContent(overlay)
      } catch {
        // Игнорим.
      }
    }
  }
}

export function resolveOverlayDismiss(overlay: BrowserWindow): void {
  log('command', 'dismiss')
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) return
  const parent = BrowserWindow.fromId(parentId)
  // closeOverlay, а не closeStack: клик по подложке и Esc означают одно и
  // то же — «снять верхний уровень». Снимать весь стек было бы
  // неожиданностью: подложка диалога не должна убирать лежащее под ним
  // меню.
  if (parent) closeOverlay(parent)
  else {
    clearSession(parentId)
    try {
      hideContent(overlay)
    } catch {
      // Игнорим.
    }
  }
}

// Диалог с полем ввода: значение "buttonId::text" резолвится
// через тот же onSelect — main разобрает префикс сам.
export function resolveOverlaySubmit(overlay: BrowserWindow, raw: string): void {
  // Тот же заслон не-строки, что и в resolveOverlaySelect: log ниже
  // режет raw.slice(0, 40) и упал бы на объекте.
  if (typeof raw !== 'string') {
    log('error', 'submit with non-string value, ignored', { got: typeof raw })
    return
  }
  log('command', `submit: ${raw.slice(0, 40)}`)
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) return
  const entry = sessionOf<OverlayRequest>(parentId)
  if (!entry) return
  const parent = BrowserWindow.fromId(parentId)
  entry.request.onSelect?.(raw)
  if (parent) closeOverlay(parent)
  else {
    clearSession(parentId)
    try {
      hideContent(overlay)
    } catch {
      // Игнорим.
    }
  }
}

// Общий диалог иконки: верификация источника перед применением.
// Возвращает true если применено (диалог закроется), false если
// источник отклонен (диалог остается, renderer показывает ошибку).
// Кнопка file открывает системный диалог выбора картинки и подставляет
// путь в поле через executeJavaScript — submit идет обычным путем.
//
// apply больше НЕ передаётся снаружи и не дублируется на окне в
// __iconApply: он лежит в request активной сессии, а сессия находится
// через обратную карту. Раньше контекст хранился в двух местах сразу, и
// apply на окне мог устареть раньше сессии.
export async function resolveOverlaySubmitIcon(
  overlay: BrowserWindow,
  buttonId: string,
  value: string
): Promise<boolean> {
  log('command', `submit-icon: ${buttonId} (${value.slice(0, 30)})`)
  const parentId = parentIdOfOverlay(overlay)
  if (parentId === undefined) return false
  const entry = sessionOf<OverlayRequest>(parentId)
  if (!entry) return false
  const apply = entry.request.onIconApply
  if (!apply) return false
  {
    if (buttonId === 'file') {
      const parent = BrowserWindow.fromId(parentId)
      try {
        setSystemDialogOpen(true)
        // Оверлей alwaysOnTop, и системный диалог открывается ПОД ним:
        // пользователь видит только рамку оверлея, сам диалог перекрыт.
        // На время выбора снимаем alwaysOnTop — состояние диалога не
        // теряется, в отличие от парковки окна.
        const wasAlwaysOnTop = overlay.isAlwaysOnTop()
        if (wasAlwaysOnTop) overlay.setAlwaysOnTop(false)
        let res: Electron.OpenDialogReturnValue
        try {
          res = await dialog.showOpenDialog(parent ?? (null as never), {
            title: t('icon.fileDialog.title'),
            properties: ['openFile'],
            filters: [
              {
                name: t('icon.fileDialog.images'),
                extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp']
              },
              { name: t('icon.fileDialog.allFiles'), extensions: ['*'] }
            ]
          })
        } finally {
          if (wasAlwaysOnTop && !overlay.isDestroyed()) overlay.setAlwaysOnTop(true)
        }
        setSystemDialogOpen(false)
        if (res.canceled || !res.filePaths || res.filePaths.length === 0 || overlay.isDestroyed()) {
          return true
        }
        const conv = fileToIconDataUrl(res.filePaths[0])
        if (!conv.ok) {
          logError('icon file conversion failed', conv.error)
          // Ошибка уходит через overlay:update, а не executeJavaScript:
          // раньше скрипт правил .dialog-error по селектору, и разметка с
          // данными расходились при любом переименовании класса.
          const errParent = BrowserWindow.fromId(parentId)
          if (errParent) {
            updateActiveOverlay(errParent, { icon: { error: conv.error } })
          }
          return true
        }
        apply(conv.icon)
        const p = BrowserWindow.fromId(parentId)
        if (p) closeOverlay(p)
        return true
      } catch (err) {
        setSystemDialogOpen(false)
        logError('file dialog failed', err)
        return true
      }
    }
    let check: { ok: true; icon: string } | { ok: false; error: string }
    if (buttonId === 'emoji') {
      check = verifyEmojiButton(value)
    } else {
      check = verifyIconSource(value)
      if (check.ok && check.icon.startsWith('emoji:')) {
        check = { ok: false, error: t('icon.error.useEmojiButton') }
      }
    }
    if (!check.ok) return false
    apply(check.icon)
    const parent = BrowserWindow.fromId(parentId)
    if (parent) closeOverlay(parent)
    else {
      clearSession(parentId)
      try {
        hideContent(overlay)
      } catch {
        // Игнорим.
      }
    }
    return true
  }
}
