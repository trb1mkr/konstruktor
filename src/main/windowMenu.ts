// Меню окна: ПКМ по кнопкам навигации (свернуть/развернуть/закрыть).
//
// Отдельный модуль по образцу groupsMenu.ts: здесь только сборка
// пунктов и их действия, без знания об устройстве оверлея.
//
// Системное меню окна на Windows заменено намеренно. Ото��алось само —
// правый клик по drag-области заголовка отдавался ОС, минуя renderer.
// Оно и светлое, и не стилизуется, и не знает про проект: в нём нет ни
// «Clone window», ни «Open new window». Убрать его можно было только
// сняв drag-область (см. windowsManager.startWindowDrag), иначе система
// продолжит отдавать правый клик мимо renderer.
//
// Пункты «Move»/«Size» из системного меню сознательно не воспроизведены.
// Там они не действие, а режим: курсор превращается в стрелку, границы
// окна тянутся мышью до следующего клика. В Electron нет состояния
// «окно ждёт границ» — только setBounds/setSize, то есть действие без
// курсора. Реализация выходила заметно объёмнее пункта, который в меню
// окна занимает одну строку и вряд ли кем-то используется.
//
// Пока локализации нет: подписи по-английски напрямую. Когда появится
// i18n, единственное место для правки — labels().
import { BrowserWindow } from 'electron'
import { showOverlay, type OverlayMenuItem } from './overlay'

/** Подписи меню. Отдельная функция — будущий i18n меняет только её. */
function labels(): {
  maximize: string
  restore: string
  minimize: string
  close: string
  newWindow: string
  cloneWindow: string
} {
  return {
    maximize: 'Maximize',
    restore: 'Restore',
    minimize: 'Minimize',
    close: 'Close',
    newWindow: 'Open new window',
    cloneWindow: 'Clone window'
  }
}

/**
 * Показать меню окна в точке вызова.
 *
 * anchor — координаты относительно content-области окна, как у всех
 * остальных меню: оверлей позиционируется от родителя, а не от экрана.
 *
 * deps:
 *   newWindow — окно со стартовой страницей: вкладки текущего не копируются.
 *   cloneWindow — окно с копией вкладок текущего, исходные остаются на месте.
 */
export function showWindowMenu(
  win: BrowserWindow,
  anchor: { x: number; y: number },
  deps: {
    newWindow: () => void
    cloneWindow: () => void
  }
): void {
  const L = labels()
  // Maximize и Restore — взаимоисключающие: одно и то же действие в двух
  // состояниях, поэтому в меню присутствует ровно один из них. Раздельные
  // пункты вместо смены подписи выбраны по требованию: скрываются, а не
  // гаснут — состав меню не меняется при развороте окна.
  const maximized = win.isMaximized()
  const items: OverlayMenuItem[] = [
    { id: 'new-window', label: L.newWindow, icon: '🗗' },
    { id: 'clone-window', label: L.cloneWindow, icon: '⧉' },
    { id: 'minimize', label: L.minimize, icon: '─' },
    maximized
      ? { id: 'restore', label: L.restore, icon: '❐' }
      : { id: 'maximize', label: L.maximize, icon: '☐' },
    { id: 'close', label: L.close, icon: '✕' }
  ]

  showOverlay(win, {
    kind: 'window-menu',
    anchor: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    items,
    incognito: false,
    align: 'start',
    onSelect: (action) => {
      // Окно могло закрыться, пока меню было открыто: действовать не на чем.
      if (win.isDestroyed()) return
      if (action === 'maximize') {
        win.maximize()
      } else if (action === 'restore') {
        win.unmaximize()
      } else if (action === 'minimize') {
        win.minimize()
      } else if (action === 'close') {
        win.close()
      } else if (action === 'new-window') {
        deps.newWindow()
      } else if (action === 'clone-window') {
        deps.cloneWindow()
      }
    }
  })
}