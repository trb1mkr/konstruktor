// JS-инъекции поиска по странице (п.4 рефакторинга).
//
// Здесь остались только скрипты, исполняемые в webContents ВКЛАДКИ:
// собственный поиск по словам и regex, который findInPage не умеет.
// Данные, идущие В оверлей, через JS не передаются: счётчик и ошибка
// валидации едут точечным патчем overlay:update.
// Раньше строки executeJavaScript жили внутри index.ts рядом с логикой
// findInPage — теперь все шаблоны в одном файле, main только подставляет
// параметры через JSON.stringify. Тестировать можно без Electron.
export interface CustomFindOptions {
  query: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
}

// Живое перекрашивание внутренней страницы без перезагрузки.
export function buildPageThemeScript(pageTheme: string): string {
  return `document.documentElement.dataset.theme = ${JSON.stringify(pageTheme)}; true`
}

// Собственный поиск для wholeWord/regex: findInPage их не умеет
// (только подстрока + matchCase). Разбиваем текст на слова границами
// Unicode-букв/цифр — пробелы и пунктуация считаются разделителями.
export function buildRunCustomFindScript(opts: CustomFindOptions): string {
  return (
    `(() => {\n` +
    ` const q = ${JSON.stringify(opts.query)};\n` +
    ` const matchCase = ${opts.matchCase ? 'true' : 'false'};\n` +
    ` const wholeWord = ${opts.wholeWord ? 'true' : 'false'};\n` +
    ` const useRegex = ${opts.useRegex ? 'true' : 'false'};\n` +
    ` document.querySelectorAll('.konstruktor-find-hit').forEach((el) => {\n` +
    `   const p = el.parentNode; if (!p) return;\n` +
    `   p.replaceChild(document.createTextNode(el.textContent), el); p.normalize();\n` +
    ` });\n` +
    ` window.__konstruktorFind = { hits: [], active: 0 };\n` +
    ` const esc = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');\n` +
    ` let base = useRegex ? q : esc(q);\n` +
    ` if (wholeWord) base = '(?<![\\\\p{L}\\\\p{N}_])(?:' + base + ')(?![\\\\p{L}\\\\p{N}_])';\n` +
    ` let re;\n` +
    ` try { re = new RegExp(base, 'g' + (matchCase ? '' : 'i') + 'u'); }\n` +
    ` catch (err) { return { matches: 0, error: 'bad-regex' }; }\n` +
    ` if (!document.body) return { matches: 0 };\n` +
    ` const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {\n` +
    `   acceptNode(n) {\n` +
    `     if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;\n` +
    `     const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;\n` +
    `     const tag = p.tagName;\n` +
    `     if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;\n` +
    `     if (p.closest('.konstruktor-find-hit')) return NodeFilter.FILTER_REJECT;\n` +
    `     return NodeFilter.FILTER_ACCEPT;\n` +
    `   }\n` +
    ` });\n` +
    ` const nodes = [];\n` +
    ` while (walker.nextNode()) nodes.push(walker.currentNode);\n` +
    ` for (const node of nodes) {\n` +
    `   const text = node.nodeValue; re.lastIndex = 0;\n` +
    `   let m, last = 0, found = false;\n` +
    `   const frag = document.createDocumentFragment();\n` +
    `   while ((m = re.exec(text))) {\n` +
    `     found = true;\n` +
    `     const s = m.index, e2 = s + m[0].length;\n` +
    `     if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)));\n` +
    `     const span = document.createElement('span');\n` +
    `     span.className = 'konstruktor-find-hit'; span.textContent = text.slice(s, e2);\n` +
    `     frag.appendChild(span);\n` +
    `     last = e2;\n` +
    `     if (m[0].length === 0) re.lastIndex++;\n` +
    `   }\n` +
    `   if (found) {\n` +
    `     if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));\n` +
    `     node.parentNode.replaceChild(frag, node);\n` +
    `   }\n` +
    ` }\n` +
    ` if (!document.getElementById('konstruktor-find-style')) {\n` +
    `   const st = document.createElement('style'); st.id = 'konstruktor-find-style';\n` +
    `   st.textContent = '.konstruktor-find-hit{background:#ffe066;color:#000;border-radius:2px}' +\n` +
    `     '.konstruktor-find-hit.current{background:#ffb700;color:#000}';\n` +
    `   document.head.appendChild(st);\n` +
    ` }\n` +
    ` const hits = Array.from(document.querySelectorAll('.konstruktor-find-hit'));\n` +
    ` hits.forEach((el, i) => el.classList.toggle('current', i === 0));\n` +
    ` window.__konstruktorFind = { hits, active: 0 };\n` +
    ` if (hits[0]) hits[0].scrollIntoView({ block: 'center' });\n` +
    ` return { matches: hits.length };\n` +
    ` })()`
  )
}

// Шаг по подсветке вперед/назад (find:next / find:prev при lastFindCustom).
export function buildStepCustomFindScript(forward: boolean): string {
  return (
    `(() => {\n` +
    ` const st = window.__konstruktorFind;\n` +
    ` const hits = Array.from(document.querySelectorAll('.konstruktor-find-hit'));\n` +
    ` if (hits.length === 0) return { matches: 0 };\n` +
    ` let active = typeof st?.active === 'number' ? st.active : 0;\n` +
    ` active = ((active + ${forward ? '1' : '-1'}) % hits.length + hits.length) % hits.length;\n` +
    ` hits.forEach((el, i) => el.classList.toggle('current', i === active));\n` +
    ` window.__konstruktorFind = { hits, active };\n` +
    ` hits[active].scrollIntoView({ block: 'center' });\n` +
    ` return { matches: hits.length, active: active + 1 };\n` +
    ` })()`
  )
}

// Снятие подсветки при закрытии панели или смене режима поиска.
export function buildClearCustomFindScript(): string {
  return (
    `(() => {\n` +
    ` document.querySelectorAll('.konstruktor-find-hit').forEach((el) => {\n` +
    `   const p = el.parentNode; if (!p) return;\n` +
    `   p.replaceChild(document.createTextNode(el.textContent), el); p.normalize();\n` +
    ` });\n` +
    ` window.__konstruktorFind = { hits: [], active: 0 };\n` +
    ` })()`
  )
}
