// Стартовая страница-табло в духе Yandex Browser: имя, лозунг, призыв
// кастомизировать и сетка прямоугольных плиток на любимые сайты.
// Плитки хранятся в userData/shortcuts.json, правятся прямо на странице
// (add/edit/remove). Мост window.konstruktor ставит session-preload.
//
// HTML собирается функцией от языка на каждый запрос (см. pageI18nScript):
// статические строки переводятся t(), скрипт страницы — встроенным tr().
import { langTag } from '../shared/i18n'
import { pageI18nScript } from '../shared/i18n/pageRuntime'
import { t } from './i18n'

export const START_URL = 'konstruktor://start'

export function buildStartPage(lang: string): string {
  return `<!DOCTYPE html>
<html lang="${langTag(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Konstruktor</title>
<style>
  * { box-sizing: border-box; }
  :root, :root[data-theme='dark'] {
    --pg-bg: #141414; --pg-panel: #1e1e1e; --pg-border: #333;
    --pg-input-border: #444; --pg-text: #eee; --pg-logo: #fff;
    --pg-dim: #aaa; --pg-soft: #ccc; --pg-faint: #888; --pg-hint: #666;
    --pg-hover: #262626; --pg-btn: #333; --pg-code: #222;
  }
  :root[data-theme='light'] {
    --pg-bg: #f2f2f2; --pg-panel: #ffffff; --pg-border: #ddd;
    --pg-input-border: #bbb; --pg-text: #1a1a1a; --pg-logo: #111;
    --pg-dim: #555; --pg-soft: #333; --pg-faint: #999; --pg-hint: #999;
    --pg-hover: #e8e8e8; --pg-btn: #d0d0d0; --pg-code: #e4e4e4;
  }
  :root[data-theme='slate'] {
    --pg-bg: #232a35; --pg-panel: #2c3542; --pg-border: #3d4c60;
    --pg-input-border: #4a5a70; --pg-text: #dbe4f0; --pg-logo: #e8eef6;
    --pg-dim: #b3c1d4; --pg-soft: #c6d3e4; --pg-faint: #7d8ea6; --pg-hint: #7d8ea6;
    --pg-hover: #3b4a5e; --pg-btn: #46586e; --pg-code: #1c232e;
  }
  body {
    margin: 0; font-family: system-ui, sans-serif; color: var(--pg-text);
    background: var(--pg-bg);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  }
  .hero { text-align: center; margin: 64px 16px 8px; }
  .logo { font-size: 44px; font-weight: 800; letter-spacing: 1px; color: var(--pg-logo); }
  .slogan { color: var(--pg-dim); font-size: 16px; margin-top: 6px; }
  .cta { color: var(--pg-soft); font-size: 13px; margin-top: 10px; }
  .cta code { background: var(--pg-code); padding: 2px 6px; border-radius: 6px; }
  .board {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 12px; width: min(860px, 92vw); margin: 28px 0 16px;
  }
  .tile {
    position: relative; display: flex; flex-direction: column; gap: 8px;
    align-items: flex-start; justify-content: flex-end;
    width: 150px; min-height: 110px; padding: 12px; border-radius: 14px;
    background: var(--pg-panel); border: 1px solid var(--pg-border);
    cursor: pointer; text-align: left; color: var(--pg-text); font: inherit;
  }
  .tile:hover { background: var(--pg-hover); border-color: var(--pg-input-border); }
  .tile .fav { width: 28px; height: 28px; border-radius: 7px; font-size: 20px;
    display: flex; align-items: center; justify-content: center; background: var(--pg-btn); }
  .tile .fav img { width: 28px; height: 28px; border-radius: 7px; }
  .tile .name { font-size: 14px; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; max-width: 100%; }
  .tile .url { font-size: 11px; color: var(--pg-faint); white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; max-width: 100%; }
  .tile .x {
    position: absolute; top: 6px; right: 6px; display: none;
    background: var(--pg-btn); border: none; color: var(--pg-soft); border-radius: 6px;
    width: 22px; height: 22px; cursor: pointer; font-size: 12px; line-height: 1;
  }
  .tile:hover .x { display: block; }
  .tile .x:hover { background: #5a2020; color: #fff; }
  .tile.add {
    align-items: center; justify-content: center; border-style: dashed;
    color: var(--pg-faint); font-size: 28px; min-height: 110px;
  }
  .tile.add:hover { color: var(--pg-text); }
  dialog {
    background: var(--pg-panel); color: var(--pg-text); border: 1px solid var(--pg-input-border); border-radius: 14px;
    padding: 20px; width: min(400px, 90vw);
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
  dialog h3 { margin: 0 0 12px; }
  dialog label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; margin-top: 10px; }
  dialog input {
    padding: 8px 10px; border-radius: 8px; border: 1px solid var(--pg-input-border);
    background: var(--pg-bg); color: var(--pg-text); outline: none;
  }
  dialog .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  dialog button {
    background: var(--pg-btn); color: var(--pg-text); border: none; border-radius: 8px;
    padding: 8px 16px; cursor: pointer;
  }
  dialog button.primary { background: var(--pg-text); color: var(--pg-bg); }
  dialog button.primary:hover { filter: brightness(1.1); }
  .hint { color: var(--pg-hint); font-size: 12px; margin-bottom: 40px; }
</style>
${pageI18nScript(lang)}
<script>
  // Тема shell применяется к стартовой странице до отрисовки.
  try {
    window.konstruktor?.getSettings?.().then((s) => {
      const t = s.theme ?? 'dark';
      const eff = t === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
        : (t === 'slate' || t === 'light' ? t : 'dark');
      document.documentElement.dataset.theme = eff;
    });
  } catch { /* дефолт dark */ }
</script>
</head>
<body>
  <div class="hero">
    <div class="logo">Konstruktor</div>
    <div class="slogan">${t('start.slogan')}</div>
    <div class="cta">${t('start.cta')}</div>
  </div>
  <div class="board" id="board"></div>
  <div class="hint">${t('start.hint')}</div>
  <dialog id="dlg">
    <h3>${t('start.newShortcut')}</h3>
    <label>${t('start.fieldName')}<input id="f-name" placeholder="GitHub" /></label>
    <label>${t('start.fieldUrl')}<input id="f-url" placeholder="https://github.com" spellcheck="false" /></label>
    <div class="row">
      <button id="f-cancel">${t('common.cancel')}</button>
      <button id="f-save" class="primary">${t('common.save')}</button>
    </div>
  </dialog>
  <script>
    const board = document.getElementById('board');
    const dlg = document.getElementById('dlg');
    const fName = document.getElementById('f-name');
    const fUrl = document.getElementById('f-url');

    async function load() {
      if (!window.konstruktor) {
        board.innerHTML = '';
        return;
      }
      let tiles = [];
      try {
        tiles = await window.konstruktor.getShortcuts();
      } catch { tiles = []; }
      board.innerHTML = '';
      for (const t of tiles) {
        const b = document.createElement('button');
        b.className = 'tile';
        const letter = (t.name || t.url || '?')[0].toUpperCase();
        const fav = t.favicon
          ? '<span class="fav"><img src="' + t.favicon + '" /></span>'
          : '<span class="fav">' + letter + '</span>';
        b.innerHTML = fav + '<span class="name"></span><span class="url"></span><span class="x" title="' + tr('start.remove') + '">✕</span>';
        b.querySelector('.name').textContent = t.name || t.url;
        b.querySelector('.url').textContent = hostOf(t.url);
        b.title = t.url;
        b.addEventListener('click', (ev) => {
          if (ev.target.closest('.x')) return;
          location.href = t.url;
        });
        b.querySelector('.x').addEventListener('click', async () => {
          await window.konstruktor.removeShortcut(t.url);
          void load();
        });
        board.appendChild(b);
      }
      const add = document.createElement('button');
      add.className = 'tile add';
      add.textContent = '+';
      add.title = tr('start.addShortcut');
      add.addEventListener('click', () => {
        fName.value = '';
        fUrl.value = '';
        dlg.showModal();
        fName.focus();
      });
      board.appendChild(add);
    }

    function hostOf(u) {
      try { return new URL(u).host; } catch { return u; }
    }

    document.getElementById('f-cancel').addEventListener('click', () => dlg.close());
    document.getElementById('f-save').addEventListener('click', async () => {
      let url = fUrl.value.trim();
      if (!url) return;
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = 'https://' + url;
      await window.konstruktor.addShortcut({ name: fName.value.trim(), url });
      dlg.close();
      void load();
    });
    fUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('f-save').click();
    });

    void load();
  </script>
</body>
</html>
`
}
