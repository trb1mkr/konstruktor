// Сверка каталогов локализации с en.json (язык-источник).
//
// Проверяет для каждого языка:
//   1) полноту — каждый ключ en.json присутствует в каталоге языка;
//   2) множественное число — набор суффиксов _one/_few/_many/_other
//      полон для категорий этого языка (Intl.PluralRules);
//   3) лишние ключи — ключи, которых нет в en.json;
//   4) параметры {{...}} — набор имён совпадает с en.json.
//
// Запуск: npm run i18n:check. Ненулевой код выхода при любой проблеме.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const localesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'shared',
  'i18n',
  'locales',
)

// Суффиксы множественного числа i18next (без ordinal — он не используется).
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/

function flatten(tree, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
    else out[path] = value
  }
  return out
}

function baseKey(key) {
  return key.replace(PLURAL_SUFFIX, '')
}

function load(file) {
  return flatten(JSON.parse(readFileSync(join(localesDir, file), 'utf8')))
}

function pluralCategories(lang) {
  try {
    return new Intl.PluralRules(lang).resolvedOptions().pluralCategories
  } catch {
    return ['one', 'other']
  }
}

// Ключ считается присутствующим, если он есть буквально либо задан
// непустым набором суффиксов (вызов идёт по базовому ключу с count).
function hasKey(keys, key, categories) {
  if (keys.has(key)) return true
  return categories.some((cat) => keys.has(`${key}_${cat}`))
}

function suffixesOf(keys, base) {
  const found = []
  for (const key of keys) {
    if (key.startsWith(`${base}_`) && PLURAL_SUFFIX.test(key))
      found.push(key.slice(base.length + 1))
  }
  return found
}

function paramsOf(value) {
  return new Set([...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))
}

function sameParams(a, b) {
  if (a.size !== b.size) return false
  for (const name of a) if (!b.has(name)) return false
  return true
}

const files = readdirSync(localesDir).filter((f) => f.endsWith('.json'))
if (!files.includes('en.json')) {
  console.error('[i18n:check] нет en.json — язык-источник обязателен')
  process.exit(1)
}

const enFlat = load('en.json')
const enKeys = new Set(Object.keys(enFlat))
const problems = []
// Множественные ключи проверяются по базе, сообщение — одно на базу.
const pluralReported = new Set()

for (const file of files.sort()) {
  const lang = file.replace(/\.json$/, '')
  const flat = load(file)
  const keys = new Set(Object.keys(flat))
  const categories = pluralCategories(lang)

  for (const key of enKeys) {
    if (!hasKey(keys, key, categories)) {
      problems.push(`${file}: отсутствует ключ ${key}`)
    }
  }
  for (const key of keys) {
    const base = baseKey(key)
    // Легальный вариант — буквальный ключ из en либо суффикс множественного
    // числа от базового ключа, который plural в en (у ru их больше: _few/_many).
    const isPluralVariant = base !== key && suffixesOf(enKeys, base).length > 0
    if (!enKeys.has(key) && !isPluralVariant) {
      problems.push(`${file}: лишний ключ ${key} (нет в en.json)`)
      continue
    }
    // Неполный набор суффиксов: часть форм переведена, часть нет.
    // Обязателен ВЕСЬ набор категорий языка (у русского это
    // _one/_few/_many/_other), а не только те, что есть в en.
    if (isPluralVariant && !pluralReported.has(`${file}:${base}`)) {
      pluralReported.add(`${file}:${base}`)
      const present = suffixesOf(keys, base)
      if (categories.some((cat) => !present.includes(cat))) {
        problems.push(
          `${file}: неполный набор множественного числа ${base} ` +
            `(есть: ${present.sort().join(', ') || '—'}, нужно: ${categories.sort().join(', ')})`,
        )
      }
    }
    // Параметры {{...}} обязаны совпадать с источником: перевод со свободным
    // именем сломает интерполяцию в рантайме.
    const ref = enFlat[key] ?? enFlat[`${base}_other`] ?? enFlat[`${base}_one`] ?? enFlat[base]
    const value = flat[key]
    if (typeof ref === 'string' && typeof value === 'string') {
      const enParams = paramsOf(ref)
      const locParams = paramsOf(value)
      if (!sameParams(enParams, locParams)) {
        problems.push(
          `${file}: параметры {{...}} расходятся у ${key} ` +
            `(en: ${[...enParams].join(', ') || '—'}; ${lang}: ${[...locParams].join(', ') || '—'})`,
        )
      }
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[i18n:check] ${problem}`)
  console.error(`[i18n:check] проблем: ${problems.length}`)
  process.exit(1)
}
console.log(`[i18n:check] ок: языков ${files.length}, ключей en ${enKeys.size}`)
