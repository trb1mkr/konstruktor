// HTML-каркас внутренних страниц: doctype, темы, базовый CSS,
// подключение pageI18nScript и ранний резолв темы shell.
// Выделено из internalPages.ts: общий для history/settings/downloads.
//
// Граница: только разметка-каркас вокруг body. Персональный CSS и
// <script> конкретной страницы остаются в её builder-файле.
import { langTag } from '../../shared/i18n'
import { pageI18nScript } from '../../shared/i18n/pageRuntime'

export function shell(title: string, body: string, lang: string): string {
  return `<!DOCTYPE html>
<html lang="${langTag(lang)}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  :root, :root[data-theme='dark'] {
    --pg-bg: #141414; --pg-panel: #1e1e1e; --pg-border: #2c2c2c;
    --pg-input-border: #444; --pg-text: #eee; --pg-dim: #888;
    --pg-faint: #666; --pg-hover: #262626; --pg-btn: #333;
    --pg-btn-hover: #444; --pg-link: #7db3ff;
  }
  :root[data-theme='light'] {
    --pg-bg: #f2f2f2; --pg-panel: #ffffff; --pg-border: #ddd;
    --pg-input-border: #bbb; --pg-text: #1a1a1a; --pg-dim: #555;
    --pg-faint: #999; --pg-hover: #e8e8e8; --pg-btn: #d0d0d0;
    --pg-btn-hover: #bdbdbd; --pg-link: #0b5bd3;
  }
  :root[data-theme='slate'] {
    --pg-bg: #232a35; --pg-panel: #2c3542; --pg-border: #3d4c60;
    --pg-input-border: #4a5a70; --pg-text: #dbe4f0; --pg-dim: #b3c1d4;
    --pg-faint: #7d8ea6; --pg-hover: #3b4a5e; --pg-btn: #46586e;
    --pg-btn-hover: #54687f; --pg-link: #9fc1e8;
  }
  body { margin: 0; font-family: system-ui, sans-serif; background: var(--pg-bg); color: var(--pg-text); }
  header { padding: 20px 28px 0; max-width: 860px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  main { max-width: 860px; margin: 0 auto; padding: 16px 28px 40px; }
  input[type="search"], input[type="text"], select {
    width: 100%; padding: 10px 14px; border-radius: 8px;
    border: 1px solid var(--pg-input-border); background: var(--pg-panel); color: var(--pg-text); outline: none;
  }
  .row { display: flex; gap: 8px; align-items: center; padding: 10px 12px;
    background: var(--pg-panel); border: 1px solid var(--pg-border); border-radius: 10px; margin-top: 8px; }
  .row:hover { background: var(--pg-hover); }
  .fav { width: 16px; height: 16px; flex-shrink: 0; border-radius: 3px; }
  .meta { flex: 1; min-width: 0; }
  .t { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .u { font-size: 12px; color: var(--pg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .when { font-size: 12px; color: var(--pg-faint); flex-shrink: 0; }
  button { background: var(--pg-btn); color: var(--pg-text); border: none; border-radius: 8px;
    padding: 8px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: var(--pg-btn-hover); }
  button.danger { background: #5a2020; color: #eee; }
  button.danger:hover { background: #752a2a; }
  /* Монохромный фокус внутренних страниц: вместо системной синей обводки. */
  input:focus, select:focus { border-color: var(--pg-dim) !important; outline: none; }
  button:focus-visible { outline: 1px solid var(--pg-dim); outline-offset: 1px; }
  .toolbar { display: flex; gap: 8px; margin-top: 12px; }
  .empty { color: var(--pg-faint); text-align: center; padding: 40px 0; }
  label.set { display: flex; flex-direction: column; gap: 6px; font-size: 14px; margin-top: 16px; }
  div.set { display: flex; flex-direction: column; gap: 8px; font-size: 14px; margin-top: 16px; }
  label.check { display: flex; flex-direction: row; align-items: center; gap: 10px; font-size: 14px; margin-top: 16px; cursor: pointer; }
  label.check input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--pg-text); cursor: pointer; }
  .hint { font-size: 12px; color: var(--pg-faint); }
  a { color: var(--pg-link); }
  /* Визуальный выбор темы: мини-макет окна браузера. */
  .theme-pick { display: flex; gap: 12px; flex-wrap: wrap; }
  .theme-pick button { padding: 10px; display: flex; flex-direction: column; gap: 8px; border: 2px solid transparent; }
  .theme-pick button.picked { border-color: var(--pg-text); }
  .tp-bar { display: flex; gap: 4px; align-items: center; background: #252525; border-radius: 6px 6px 0 0; padding: 6px; width: 150px; }
  .tp-bar.light { background: #e8e8e8; }
  .tp-bar.slate { background: #2c3542; }
  .tp-bar.system { background: linear-gradient(90deg, #252525 50%, #e8e8e8 50%); }
  .tp-tab { width: 44px; height: 12px; border-radius: 4px; background: #333; }
  .tp-tab.on { background: #1e1e1e; }
  .tp-bar.light .tp-tab { background: #d4d4d4; }
  .tp-bar.light .tp-tab.on { background: #fff; }
  .tp-bar.slate .tp-tab { background: #3d4c60; }
  .tp-bar.slate .tp-tab.on { background: #232a35; }
  .tp-bar.slate .tp-dot { background: #7d8ea6; }
  .tp-bar.system .tp-tab { background: #555; }
  .tp-bar.system .tp-tab.on { background: #888; }
  .tp-dot { width: 10px; height: 10px; border-radius: 50%; background: #555; margin-left: auto; }
  .tp-bar.light .tp-dot { background: #bbb; }
  .tp-addr { height: 12px; border-radius: 4px; background: #2b2b2b; width: 150px; }
  .tp-addr.light { background: #e0e0e0; }
  .tp-addr.slate { background: #3b4a5e; }
  .tp-addr.system { background: linear-gradient(90deg, #2b2b2b 50%, #e0e0e0 50%); }
  .tp-name { font-size: 13px; }
</style>
${pageI18nScript(lang)}
<script>
  // Тема shell применяется к внутренним страницам: читаем settings
  // до отрисовки, чтобы не мигать темной темой при светлой.
  // 'system' резолвится через matchMedia, остальные как есть.
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
<header><h1>${title}</h1></header>
<main>${body}</main>
</body>
</html>`
}
