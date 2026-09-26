// Внутренние страницы конструктора. Отдаются через konstruktor://history
// и konstruktor://settings без внешних ресурсов — работают офлайн.
// Рендерятся внутри WebContentsView как обычные вкладки.
export const HISTORY_URL = 'konstruktor://history'
export const SETTINGS_URL = 'konstruktor://settings'
export const DOWNLOADS_URL = 'konstruktor://downloads'

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
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

export const HISTORY_PAGE_HTML = shell(
  'History',
  `<div class="hist-controls">
     <input id="q" type="search" placeholder="Search history…" autocomplete="off" />
     <div class="seg" id="mode">
       <button data-mode="day" class="on">Day</button><button data-mode="month">Month</button><button data-mode="year">Year</button>
     </div>
   </div>
   <div class="toolbar">
     <button id="clear" class="danger">Clear all history</button>
     <span id="stats" class="hint"></span>
   </div>
   <div id="tree"><div class="empty">Loading…</div></div>
   <script>
     // Хронология: main отдаёт плоский список визитов (url/title/at),
     // дерево день → месяц → год строим здесь. Поиск фильтрует на стороне main.
     const tree = document.getElementById('tree');
     const q = document.getElementById('q');
     const stats = document.getElementById('stats');
     let mode = 'day';
     document.getElementById('mode').addEventListener('click', (ev) => {
       const btn = ev.target.closest('[data-mode]');
       if (!btn) return;
       mode = btn.dataset.mode;
       document.querySelectorAll('#mode button').forEach((b) =>
         b.classList.toggle('on', b === btn));
       void load(q.value);
     });
     function pad(n) { return String(n).padStart(2, '0'); }
     function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
     function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
     function yearKey(d) { return String(d.getFullYear()); }
     function fmtDay(d) {
       const today = new Date(); const y = new Date(); y.setDate(y.getDate() - 1);
       if (dayKey(d) === dayKey(today)) return 'Today';
       if (dayKey(d) === dayKey(y)) return 'Yesterday';
       return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
     }
     function fmtMonth(d) { return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
     function groupKey(at) {
       const d = new Date(at);
       if (mode === 'day') return dayKey(d);
       if (mode === 'month') return monthKey(d);
       return yearKey(d);
     }
     function groupLabel(at) {
       const d = new Date(at);
       if (mode === 'day') return fmtDay(d);
       if (mode === 'month') return fmtMonth(d);
       return yearKey(d);
     }
     async function load(query = '') {
       if (!window.konstruktor) {
         tree.innerHTML = '<div class="empty">Bridge unavailable. Reload the page.</div>';
         return;
       }
       let rows = [];
       try {
         rows = await window.konstruktor.historyTimeline(query);
       } catch (err) {
         tree.innerHTML = '<div class="empty">Failed to load history.</div>';
         return;
       }
       if (rows.length === 0) {
         tree.innerHTML = '<div class="empty">No history yet. Visit some sites first.</div>';
         stats.textContent = '';
         return;
       }
       const urls = new Set(rows.map((r) => r.url)).size;
       stats.textContent = rows.length + ' visits · ' + urls + ' sites';
       // Группируем с сохранением порядка (rows уже по убыванию времени).
       const groups = new Map();
       for (const r of rows) {
         const k = groupKey(r.at);
         if (!groups.has(k)) groups.set(k, { at: r.at, items: [] });
         groups.get(k).items.push(r);
       }
       tree.innerHTML = '';
       for (const [key, g] of groups) {
         const details = document.createElement('details');
         details.className = 'group';
         details.open = tree.children.length === 0;
         const sum = document.createElement('summary');
         sum.className = 'group-head';
         const s = document.createElement('span');
         s.textContent = groupLabel(g.at);
         const c = document.createElement('span');
         c.className = 'count';
         c.textContent = g.items.length + (g.items.length === 1 ? ' visit' : ' visits');
         sum.append(s, c);
         details.appendChild(sum);
         for (const r of g.items) {
           const row = document.createElement('div');
           row.className = 'row';
           const fav = r.favicon
             ? '<img class="fav" src="' + r.favicon + '" />'
             : '<span class="fav">◉</span>';
           const time = mode === 'day'
             ? new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
             : new Date(r.at).toLocaleString();
           row.innerHTML = fav + '<div class="meta"><div class="t"></div><div class="u"></div></div>' +
             '<span class="when">' + time + '</span>' +
             '<button data-del title="Delete this visit">✕</button>';
           row.querySelector('.t').textContent = r.title || r.url;
           row.querySelector('.u').textContent = r.url;
           row.style.cursor = 'pointer';
           row.addEventListener('click', (ev) => {
             if (ev.target.closest('[data-del]')) return;
             location.href = r.url;
           });
           row.querySelector('[data-del]').addEventListener('click', async (ev) => {
             ev.stopPropagation();
             await window.konstruktor.historyDeleteVisit(r.url, r.at);
             void load(q.value);
           });
           details.appendChild(row);
         }
         tree.appendChild(details);
       }
     }
     // Поиск с дебаунсом: timeline гоняем не на каждую клавишу.
     let timer = null;
     q.addEventListener('input', () => {
       clearTimeout(timer);
       timer = setTimeout(() => void load(q.value), 250);
     });
     document.getElementById('clear').addEventListener('click', async () => {
       if (confirm('Delete all browsing history?')) {
         await window.konstruktor.historyClear();
         void load(q.value);
       }
     });
     void load();
   </script>
   <style>
     .hist-controls { display: flex; gap: 8px; align-items: center; }
     .hist-controls input { flex: 1; }
     .seg { display: flex; background: var(--pg-panel); border: 1px solid var(--pg-input-border); border-radius: 8px; overflow: hidden; flex-shrink: 0; }
     .seg button { background: transparent; border-radius: 0; padding: 10px 14px; }
     .seg button.on { background: var(--pg-btn); }
     .group { margin-top: 12px; background: var(--pg-panel); border: 1px solid var(--pg-border); border-radius: 10px; overflow: hidden; }
     .group-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; cursor: pointer; font-size: 14px; font-weight: 600; list-style: none; }
     .group-head::-webkit-details-marker { display: none; }
     .group-head:hover { background: var(--pg-hover); }
     .group .row { border: none; border-top: 1px solid var(--pg-border); border-radius: 0; margin-top: 0; }
     .count { font-size: 12px; font-weight: 400; color: var(--pg-dim); }
     .toolbar { align-items: center; }
   </style>`
)

export const SETTINGS_PAGE_HTML = shell(
  'Settings',
  `<label class="set"><span>Search engine URL (%s = query)</span>
     <input id="se" type="text" spellcheck="false" /></label>
   <label class="set"><span>Homepage</span>
     <input id="hp" type="text" spellcheck="false" /></label>
   <label class="check"><input id="dt" type="checkbox" /><span>Open developer tools at startup</span></label>
   <label class="set"><span>Secure DNS (applies after restart)</span>
     <select id="dns">
       <option value="off">System DNS</option>
       <option value="cloudflare">Cloudflare (1.1.1.1)</option>
       <option value="google">Google (8.8.8.8)</option>
       <option value="custom">Custom DoH server…</option>
     </select></label>
   <label class="set" id="dns-custom-wrap" style="display:none"><span>Custom DoH URL</span>
     <input id="dns-custom" type="text" spellcheck="false"
       placeholder="https://example.com/dns-query" /></label>
   <label class="set"><span>Browser language (stub — English only for now)</span>
     <select id="locale">
       <option value="en">English</option>
       <option value="ru">Русский (coming soon)</option>
     </select></label>
   <label class="check"><input id="anim-cb" type="checkbox" /><span>Animations (menus, dialogs, toasts)</span></label>
   <label class="check"><input id="rounded-cb" type="checkbox" /><span>Rounded window corners (windowed mode)</span></label>
   <label class="check"><input id="remember-cb" type="checkbox" /><span>Remember window size and position</span></label>
   <label class="check"><input id="remember-tabs-cb" type="checkbox" /><span>Remember open tabs</span></label>
   <div class="set"><span>Browser theme</span>
     <div class="theme-pick" id="theme-pick">
       <button type="button" data-theme-pick="dark" title="Dark theme">
         <span class="tp-bar"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr"></span>
         <span class="tp-name">Dark</span>
       </button>
       <button type="button" data-theme-pick="light" title="Light theme">
         <span class="tp-bar light"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr light"></span>
         <span class="tp-name">Light</span>
       </button>
       <button type="button" data-theme-pick="system" title="Follow OS theme">
         <span class="tp-bar system"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr system"></span>
         <span class="tp-name">System</span>
       </button>
       <button type="button" data-theme-pick="slate" title="Slate gray-blue theme">
         <span class="tp-bar slate"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr slate"></span>
         <span class="tp-name">Slate</span>
       </button>
     </div>
     <div class="hint">Custom components can opt out with a <code>.theme-lock</code> wrapper.</div></div>
   <label class="set"><span>F11 fullscreen mode</span>
     <select id="fsmode">
       <option value="window">Whole browser — with all controls</option>
       <option value="content">Page only — browser UI hidden</option>
     </select></label>
   <div class="toolbar"><button id="save">Save</button>
     <span id="ok" class="hint"></span></div>
   <p class="hint">Layout presets live in <code>src/renderer/layouts/</code> — copy one into
     <code>src/renderer/App.vue</code> to switch. History and bookmarks are stored in the
     app userData folder. DevTools can also be forced with env
     <code>KONSTRUKTOR_DEVTOOLS=1</code> or flag <code>--devtools</code>.</p>
   <script>
     // Мост window.konstruktor ставит session-preload до парсинга документа.
     const se = document.getElementById('se');
     const hp = document.getElementById('hp');
     const dt = document.getElementById('dt');
     const dns = document.getElementById('dns');
     const dnsWrap = document.getElementById('dns-custom-wrap');
     const dnsCustom = document.getElementById('dns-custom');
     const locale = document.getElementById('locale');
     const animCb = document.getElementById('anim-cb');
     const roundedCb = document.getElementById('rounded-cb');
     const rememberCb = document.getElementById('remember-cb');
     const rememberTabsCb = document.getElementById('remember-tabs-cb');
     const fsmode = document.getElementById('fsmode');
     const themePick = document.getElementById('theme-pick');
     let theme = 'dark';
     function paintTheme() {
       themePick.querySelectorAll('[data-theme-pick]').forEach((b) =>
         b.classList.toggle('picked', b.dataset.themePick === theme));
     }
     themePick.addEventListener('click', (ev) => {
       const b = ev.target.closest('[data-theme-pick]');
       if (!b) return;
       theme = b.dataset.themePick;
       paintTheme();
     });
     const ok = document.getElementById('ok');
     dns.addEventListener('change', () => {
       dnsWrap.style.display = dns.value === 'custom' ? '' : 'none';
     });
     (async () => {
       if (!window.konstruktor) return;
       const s = await window.konstruktor.getSettings();
       se.value = s.searchEngine;
       hp.value = s.homepage;
       dt.checked = s.devtools === true;
       dns.value = s.dnsMode || 'off';
       dnsCustom.value = s.dnsCustom || '';
       locale.value = s.locale || 'en';
       animCb.checked = s.animations !== false;
       roundedCb.checked = s.roundedCorners === true;
       rememberCb.checked = s.rememberBounds !== false;
       rememberTabsCb.checked = s.rememberTabs !== false;
       fsmode.value = s.fullscreenMode === 'content' ? 'content' : 'window';
       theme = s.theme === 'light' || s.theme === 'system' || s.theme === 'slate' ? s.theme : 'dark';
       paintTheme();
       dnsWrap.style.display = dns.value === 'custom' ? '' : 'none';
     })();
     document.getElementById('save').addEventListener('click', async () => {
       await window.konstruktor.saveSettings({
         searchEngine: se.value,
         homepage: hp.value,
         devtools: dt.checked,
         dnsMode: dns.value,
         dnsCustom: dnsCustom.value,
         locale: locale.value,
         animations: animCb.checked,
         roundedCorners: roundedCb.checked,
         rememberBounds: rememberCb.checked,
         rememberTabs: rememberTabsCb.checked,
         fullscreenMode: fsmode.value,
         theme
       });
       ok.textContent = savedMsg(dns.value);
       setTimeout(() => (ok.textContent = ''), 3000);
     });
     function savedMsg(dnsMode) {
       return dnsMode && dnsMode !== 'off'
         ? 'Saved. Restart the browser to apply Secure DNS.'
         : 'Saved.';
     }
   </script>`
)

export const DOWNLOADS_PAGE_HTML = shell(
  'Downloads',
  `<input id="q" type="search" placeholder="Search downloads…" autocomplete="off" />
   <div class="toolbar">
     <button id="clear" class="danger">Clear list</button>
   </div>
   <div id="list"><div class="empty">Loading…</div></div>
   <script>
     const list = document.getElementById('list');
     const q = document.getElementById('q');
     // Кэш системных иконок: getFileIcon дергаем один раз на файл,
     // иначе секундный рефреш будет спамить main на каждый тик.
     const iconCache = {};
     // Fallback-эмодзи по расширению, пока системная иконка грузится
     // или файл уже удален с диска (getFileIcon вернет пусто).
     function fileEmoji(name) {
       const ext = (name || '').split('.').pop().toLowerCase();
       if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(ext)) return '🖼️';
       if (['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
       if (['mp3','wav','flac','ogg','m4a'].includes(ext)) return '🎵';
       if (['zip','rar','7z','tar','gz'].includes(ext)) return '📦';
       if (['pdf'].includes(ext)) return '📕';
       if (['doc','docx','txt','md','rtf'].includes(ext)) return '📝';
       if (['xls','xlsx','csv'].includes(ext)) return '📊';
       if (['exe','msi'].includes(ext)) return '⚙️';
       return '📄';
     }
     function fmtBytes(n) {
       if (!n || n <= 0) return '—';
       const u = ['B', 'KB', 'MB', 'GB'];
       let i = 0;
       while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
       return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
     }
     function fmtState(e) {
       if (e.state === 'progressing') {
         if (e.totalBytes > 0) {
           const pct = Math.round((e.receivedBytes / e.totalBytes) * 100);
           return pct + '% · ' + fmtBytes(e.receivedBytes) + ' / ' + fmtBytes(e.totalBytes);
         }
         return fmtBytes(e.receivedBytes) + ' downloaded…';
       }
       if (e.state === 'completed') return fmtBytes(e.totalBytes || e.receivedBytes);
       if (e.state === 'cancelled') return 'Cancelled';
       return 'Interrupted';
     }
     async function load(query = '') {
       if (!window.konstruktor) {
         list.innerHTML = '<div class="empty">Bridge unavailable. Reload the page.</div>';
         return;
       }
       let entries = [];
       try {
         entries = await window.konstruktor.downloadsSearch(query);
       } catch (err) {
         list.innerHTML = '<div class="empty">Failed to load downloads.</div>';
         return;
       }
       if (entries.length === 0) {
         list.innerHTML = '<div class="empty">No downloads yet.</div>';
         return;
       }
       list.innerHTML = '';
       for (const e of entries) {
         const row = document.createElement('div');
         row.className = 'row';
         const when = new Date(e.startedAt).toLocaleString();
         const isActive = e.state === 'progressing';
         const pct = isActive && e.totalBytes > 0
           ? Math.min(100, Math.round((e.receivedBytes / e.totalBytes) * 100))
           : 0;
         // Прогресс-бар только для активной загрузки.
         // Завершенные/отмененные строки — без полоски.
         const barHtml = isActive
           ? '<div class="bar"><div class="fill" style="width:' + pct + '%"></div></div>'
           : '';
         row.innerHTML =
           '<span class="fav file-icon" data-icon>⬇</span>' +
           '<div class="meta"><div class="t"></div>' +
           '<div class="u"></div>' + barHtml + '</div>' +
           '<span class="when">' + fmtState(e) + ' · ' + when + '</span>' +
           (e.state === 'completed' ? '<button data-open>Open</button>' : '') +
           '<button data-del>✕</button>';
         row.querySelector('.t').textContent = e.filename || e.url;
         row.querySelector('.u').textContent = e.url;
         // Системная иконка файла: подставляем асинхронно, кэшируем по id.
         // dataURL PNG от app.getFileIcon; fallback — эмодзи по расширению.
         const iconSlot = row.querySelector('[data-icon]');
         iconSlot.textContent = fileEmoji(e.filename);
         if (iconCache[e.id]) {
           if (iconCache[e.id] !== 'emoji') {
             const img = document.createElement('img');
             img.className = 'fav';
             img.src = iconCache[e.id];
             iconSlot.replaceWith(img);
           }
         } else {
           window.konstruktor.downloadsIcon(e.id).then((url) => {
             if (url) {
               iconCache[e.id] = url;
               const img = document.createElement('img');
               img.className = 'fav';
               img.src = url;
               if (iconSlot.isConnected) iconSlot.replaceWith(img);
             } else {
               iconCache[e.id] = 'emoji';
             }
           }).catch(() => { iconCache[e.id] = 'emoji'; });
         }
         const openBtn = row.querySelector('[data-open]');
         if (openBtn) {
           openBtn.addEventListener('click', async (ev) => {
             ev.stopPropagation();
             await window.konstruktor.downloadsOpen(e.id);
           });
         }
         row.querySelector('[data-del]').addEventListener('click', async (ev) => {
           ev.stopPropagation();
           await window.konstruktor.downloadsRemove(e.id);
           void load(q.value);
         });
         list.appendChild(row);
       }
     }
     q.addEventListener('input', () => void load(q.value));
     document.getElementById('clear').addEventListener('click', async () => {
       if (confirm('Clear the downloads list? Files stay on disk.')) {
         await window.konstruktor.downloadsClear();
         void load(q.value);
       }
     });
     // Живое обновление прогресса без polling-нагрузки: раз в секунду.
     setInterval(() => void load(q.value), 1000);
     void load();
   </script>
   <style>
     .bar { height: 4px; background: var(--pg-btn); border-radius: 2px; margin-top: 6px; overflow: hidden; }
     .bar .fill { height: 100%; background: var(--pg-dim); transition: width 0.3s; }
     .file-icon { font-size: 16px; display: inline-flex; align-items: center; justify-content: center; }
     img.fav { width: 32px; height: 32px; }
   </style>`
)
