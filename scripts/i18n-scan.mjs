// Извлечение ключей локализации из кода и сверка с en.json.
//
// Сканирует t('...'), $t('...') и tr('...') с литеральными ключами во всех
// .ts/.vue файлах src (включая встроенные скрипты внутренних страниц) и
// сообщает:
//   - ключ использован в коде, но отсутствует в en.json → ошибка, exit 1;
//   - ключ есть в en.json, но нигде не используется → предупреждение.
//
// Запуск: npm run i18n:scan. Синхронизация каталогов — руками через
// i18n Ally или npm run i18n:check после добавления ключей.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')
const enPath = join(srcDir, 'shared', 'i18n', 'locales', 'en.json')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (/\.(ts|vue)$/.test(entry.name)) out.push(path)
  }
  return out
}

function flatten(tree, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
    else out[path] = value
  }
  return out
}

// Вызовы с литеральным ключом: t('a.b'), $t("a.b"), tr('a.b').
// Точка/другой идентификатор слева исключает str.t(...) и похожие,
// но допускает начало строки, скобку, кавычку, { и пробел.
const CALL = /(^|[^.\w$])(?:\$?t|tr)\(\s*(['"])([^'"]+)\2/g

const enKeys = new Set(Object.keys(flatten(JSON.parse(readFileSync(enPath, 'utf8')))))
const used = new Map()

for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(CALL)) {
    const key = match[3]
    if (!used.has(key)) used.set(key, relative(root, file))
  }
}

function known(key) {
  if (enKeys.has(key)) return true
  // Множественное число: вызов по базовому ключу, формы — _one/_other.
  return enKeys.has(`${key}_one`) && enKeys.has(`${key}_other`)
}

const missing = [...used].filter(([key]) => !known(key)).sort()
const usedBases = new Set(
  [...used.keys()].map((key) => key.replace(/_(zero|one|two|few|many|other)$/, '')),
)
const unused = [...enKeys]
  .map((key) => key.replace(/_(zero|one|two|few|many|other)$/, ''))
  .filter((base) => !usedBases.has(base) && !used.has(base))
  .filter((base, index, all) => all.indexOf(base) === index)
  .sort()

for (const [key, file] of missing) console.error(`[i18n:scan] нет в en.json: ${key} (${file})`)
for (const key of unused) console.log(`[i18n:scan] не используется: ${key}`)

if (missing.length > 0) {
  console.error(`[i18n:scan] ключей без каталога: ${missing.length}`)
  process.exit(1)
}
console.log(`[i18n:scan] ок: ключей в коде ${used.size}, в en.json ${enKeys.size}`)
