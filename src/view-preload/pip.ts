// Hover-кнопка Picture-in-Picture для HTML5-плееров.
//
// Скрипт выполняется в КАЖДОМ фрейме (registerPreloadScript из internal.ts)
// и живёт в изолированном мире preload: DOM общий с сайтом, поэтому кнопку
// видно, но стили и обработчики страницы её не трогают. Привязки к конкретным
// сайтам нет — обнаружение идёт по <video>, поэтому YouTube, Vimeo, Twitch и
// обычные встроенные плееры закрываются одним кодом.
//
// Кнопка видна, пока курсор внутри прямоугольника видео. Клик открывает
// нативное окно Chromium Picture-in-Picture: плавающее, всегда поверх,
// со своими контролами. Своё окно приложение не создаёт: WebContentsView
// принадлежит одному родителю, переносить view ради мини-плеера нельзя.
//
// Кнопка прячется, если pictureInPictureEnabled выключен, видео помечено
// disablePictureInPicture, у видео нет источника или оно уже в PiP.

const MIN_W = 160
const MIN_H = 90
const BTN = 32
const GAP = 8

let host: HTMLDivElement | null = null
let target: HTMLVideoElement | null = null
let raf = 0
let cx = -1
let cy = -1

// Пригодность видео под кнопку. Rect — viewport-координаты, как у position:fixed.
function usable(v: HTMLVideoElement, x: number, y: number): boolean {
  if (!document.pictureInPictureEnabled || v.disablePictureInPicture) return false
  if (document.pictureInPictureElement === v) return false
  if (!v.currentSrc && !v.srcObject) return false
  const r = v.getBoundingClientRect()
  if (r.width < MIN_W || r.height < MIN_H) return false
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

// Видео под точкой. Hit-test (elementsFromPoint) — быстрый путь, но он не
// единственный: плееры вроде YouTube ставят видео pointer-events:none и
// прячут его под оверлеями, тогда hit-test его не отдаст. Фолбэк — чистая
// геометрия: любое видео, чей rect содержит точку. Видео на странице единицы,
// скан раз в rAF дёшев. При пересечении нескольких берём самое маленькое —
// это видимый плеер, а не фоновое превью под ним.
function videoAt(x: number, y: number): HTMLVideoElement | null {
  const stack = document.elementsFromPoint(x, y)
  for (const el of stack) {
    if (el instanceof HTMLVideoElement && usable(el, x, y)) return el
  }
  let found: HTMLVideoElement | null = null
  let foundArea = Infinity
  for (const v of document.querySelectorAll('video')) {
    if (!usable(v, x, y)) continue
    const r = v.getBoundingClientRect()
    const area = r.width * r.height
    if (area < foundArea) {
      found = v
      foundArea = area
    }
  }
  return found
}

// Хост создаётся лениво при первом движении мыши: прелоад выполняется до
// загрузки документа, и documentElement тогда может ещё не существовать.
function ensureHost(): HTMLDivElement {
  if (host && host.isConnected) return host
  const el = document.createElement('div')
  el.id = 'konstruktor-pip'
  el.style.cssText =
    `position:fixed;display:none;z-index:2147483647;` +
    `width:${BTN}px;height:${BTN}px;top:0;left:0;`
  // Shadow DOM с closed-режимом: страница не достучится ни до стилей, ни до
  // кнопки внутри, а :host{all:initial} гасит наследуемые свойства страницы.
  const root = el.attachShadow({ mode: 'closed' })
  root.innerHTML =
    `<style>` +
    `:host{all:initial}` +
    `button{all:unset;display:flex;align-items:center;justify-content:center;` +
    `box-sizing:border-box;width:${BTN}px;height:${BTN}px;border-radius:6px;` +
    `background:rgba(20,20,20,.7);cursor:pointer}` +
    `button:hover{background:rgba(20,20,20,.92)}` +
    `svg{width:18px;height:18px;fill:#fff}` +
    `</style>` +
    `<button type="button" title="Picture-in-picture" aria-label="Picture-in-picture">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true">` +
    `<path d="M21 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 16H3V5h18v14Z"/>` +
    `<path d="M11 7.5h8v6h-8z"/>` +
    `</svg></button>`
  root.querySelector('button')?.addEventListener('click', (e) => {
    // Клик не должен доехать до обработчиков страницы (плей/пауза, клики
    // документа) — всплытие гасим здесь.
    e.stopPropagation()
    const v = target
    if (!v) return
    void v.requestPictureInPicture().catch(() => hide())
  })
  ;(document.documentElement ?? document.body).appendChild(el)
  host = el
  return el
}

function hide(): void {
  target = null
  if (host) host.style.display = 'none'
}

function place(v: HTMLVideoElement): void {
  const el = ensureHost()
  const r = v.getBoundingClientRect()
  const top = Math.round(Math.min(Math.max(r.top + GAP, 0), window.innerHeight - BTN))
  const left = Math.round(Math.min(Math.max(r.right - BTN - GAP, 0), window.innerWidth - BTN))
  el.style.top = `${top}px`
  el.style.left = `${left}px`
  el.style.display = 'block'
  target = v
}

function tick(): void {
  raf = 0
  const v = videoAt(cx, cy)
  if (v) place(v)
  else hide()
}

// Один rAF на серию событий: elementsFromPoint и rect-чтения дорогие,
// а координаты берутся всегда последние.
function schedule(): void {
  if (!raf) raf = requestAnimationFrame(tick)
}

export function installPipHover(): void {
  window.addEventListener(
    'mousemove',
    (e) => {
      cx = e.clientX
      cy = e.clientY
      schedule()
    },
    { passive: true }
  )
  // Скролл и ресайз двигают видео под неподвижным курсором — пересчёт тем же
  // тиком, с последними координатами. scroll не всплывает, ловим capture.
  window.addEventListener('scroll', schedule, { capture: true, passive: true })
  window.addEventListener('resize', schedule, { passive: true })
}
