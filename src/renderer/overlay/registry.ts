import type { Component } from 'vue'
import type { ViewKind } from '../../shared/overlay-types'
import BrowserMenu from './BrowserMenu.vue'
import WindowMenu from './WindowMenu.vue'
import PromptDialog from './PromptDialog.vue'
import IconDialog from './IconDialog.vue'
import FindBar from './FindBar.vue'
import ToastStack from './ToastStack.vue'

// Соответствие вида оверлея и компонента.
//
// Раньше это был `v-else-if` на пять веток прямо в OverlayRoot. Цена не в
// количестве строк, а в том, что добавление вида требовало править
// шаблон: новое условие забывали, и вид просто не отрисовывался — без
// ошибок и без логов. Реестр делает вид явным: забыть его можно только
// тем, что не добавили, а TypeScript скажет об этом на сборке.
//
// Ключи — ViewKind из контракта, а не строковые литералы: опечатка в
// имени вида становится ошибкой компиляции, а не молчаливым undefined.
const REGISTRY: Record<ViewKind, Component> = {
  menu: BrowserMenu,
  // Меню окна отличается от контекстного только источником пунктов
  // (список формирует main из состояния окна), но рисуется тем же
  // MenuList — иначе получилась бы вторая копия вёрстки пункта.
  'window-menu': WindowMenu,
  dialog: PromptDialog,
  icon: IconDialog,
  find: FindBar,
  toast: ToastStack
}

/**
 * Компонент для вида оверлея.
 *
 * Бросает на неизвестном виде, а не возвращает undefined: вызывающий код
 * тогда получает внятную ошибку вместо пустого окна без объяснений.
 */
export function componentFor(view: ViewKind): Component {
  const component = REGISTRY[view]
  if (!component) {
    throw new Error(`Нет компонента для вида оверлея: ${String(view)}`)
  }
  return component
}

/** Зарегистрированные виды. Для диагностики и тестов реестра. */
export function registeredViews(): ViewKind[] {
  return Object.keys(REGISTRY) as ViewKind[]
}