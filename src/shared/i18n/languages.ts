// Реестр языков интерфейса. Добавление языка = запись здесь + файл
// каталога locales/<код>.json — код приложения не меняется: селектор
// в настройках и форматтеры дат строятся из этого списка.
export interface LanguageDef {
  // Код языка: ключ каталога и значение настройки locale.
  code: string
  // Полная Intl-локаль для дат/чисел и <html lang>.
  intl: string
  // Подпись в селекторе: каждый язык называет себя своим именем,
  // поэтому она не переводится.
  label: string
}

export const LANGUAGES: LanguageDef[] = [
  { code: 'en', intl: 'en-US', label: 'English' },
  { code: 'ru', intl: 'ru-RU', label: 'Русский' },
]

// Intl-локаль для кода: 'ru' -> 'ru-RU'. Неизвестный код возвращается как есть.
export function langTag(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.intl ?? code
}
