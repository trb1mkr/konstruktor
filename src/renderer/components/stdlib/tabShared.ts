// Общие хелперы панели вкладок и узлов групп.
// Раньше faviconIsEmoji/faviconEmoji/shortTitle/iconIsUrl дублировались
// в TabStrip.vue и TabGroupNode.vue один в один — правили в двух местах.
// Канонический источник — этот файл, компоненты только импортируют.

// Favicon вкладки: emoji-иконка (emoji:...) рисуется текстом,
// остальное — картинкой. Без проверки emoji ломал <img>.
export function faviconIsEmoji(favicon?: string): boolean {
  return !!favicon && favicon.startsWith('emoji:')
}

export function faviconEmoji(favicon?: string): string {
  return (favicon ?? '').replace(/^emoji:/, '')
}

// Иконка группы: emoji-префикс — текст, остальное — URL картинки.
export function iconIsUrl(icon?: string): boolean {
  return !!icon && !icon.startsWith('emoji:')
}

// Текст иконки группы для fallback-спана: срезает emoji-префикс.
export function groupIconText(icon?: string): string {
  return icon?.replace(/^emoji:/, '') || '📁'
}

// Заголовок вкладки: название страницы или URL.
export function shortTitle(t: { title: string; url: string }): string {
  return t.title || t.url || 'New Tab'
}

// Горизонтальный скролл колесом: вертикальное колесо листает вправо,
// горизонтальное (тачпад) — как есть. Возвращает false если листать некуда
// (caller отдает событие родителю — вложенная группа уступает панели).
export function wheelDelta(e: WheelEvent): number {
  return Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
}
