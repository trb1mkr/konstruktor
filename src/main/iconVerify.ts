// Верификация источника иконки: нормализует ввод к хранимому виду.
// Выделено из сервиса оверлеев: без зависимостей от окон. Ошибки
// возвращаются уже переведёнными (t) — их видит overlay-рендерер.
// Возвращает { ok: true, icon } или { ok: false, error }.
import { t } from './i18n'
export function verifyIconSource(raw: string): { ok: true; icon: string } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: true, icon: '' }
  if (text.startsWith('emoji:')) {
    return text.length > 'emoji:'.length
      ? { ok: true, icon: text }
      : { ok: false, error: t('icon.error.emptyEmoji') }
  }
  if (/^(https?:|file:|data:|konstruktor:)/i.test(text)) return { ok: true, icon: text }
  if (/^([a-zA-Z]:[\\/]|\\\\|\.{0,2}[\\/]|\/)/.test(text) || /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(text)) {
    try {
      const fs = require('fs') as typeof import('fs')
      const { pathToFileURL } = require('url') as typeof import('url')
      const path = require('path') as typeof import('path')
      const unquoted = text.replace(/^"|"$/g, '')
      const normalized = path.normalize(unquoted)
      if (!fs.existsSync(normalized)) return { ok: false, error: t('icon.error.fileMissing') }
      return { ok: true, icon: pathToFileURL(normalized).href }
    } catch {
      return { ok: false, error: t('icon.error.cannotRead') }
    }
  }
  const graphemes = [...text]
  if (!/\s/.test(text) && !text.includes('.') && graphemes.length <= 4 && /\p{Extended_Pictographic}|\p{Emoji}/u.test(text)) {
    return { ok: true, icon: `emoji:${text}` }
  }
  return { ok: false, error: t('icon.error.empty') }
}

// Строгая проверка emoji для кнопки Emoji диалога: только pictographic,
// до 4 графем. Голый emoji через кнопку URL отклоняется.
export function verifyEmojiButton(value: string): { ok: true; icon: string } | { ok: false; error: string } {
  const text = value.trim()
  if (text && [...text].length <= 4 && /\p{Extended_Pictographic}|\p{Emoji}/u.test(text)) {
    return { ok: true, icon: `emoji:${text.replace(/^emoji:/, '')}` }
  }
  return { ok: false, error: t('icon.error.notEmoji') }
}

// Локальный файл в dataURL 16px: читаем, ресайзим через nativeImage, храним dataURL.
// Большие картинки сжимаются — иконка не тянет мегабайты за собой.
export function fileToIconDataUrl(filePath: string): { ok: true; icon: string } | { ok: false; error: string } {
  try {
    const fs = require('fs') as typeof import('fs')
    const { nativeImage } = require('electron') as typeof import('electron')
    const path = require('path') as typeof import('path')
    const unquoted = filePath.replace(/^"|"$/g, '')
    const normalized = path.normalize(unquoted)
    if (!fs.existsSync(normalized)) return { ok: false, error: t('icon.error.fileMissing') }
    const img = nativeImage.createFromPath(normalized)
    if (img.isEmpty()) return { ok: false, error: t('icon.error.cannotRead') }
    const small = img.resize({ width: 16, height: 16, quality: 'good' })
    return { ok: true, icon: small.toDataURL() }
  } catch {
    return { ok: false, error: t('icon.error.cannotRead') }
  }
}
