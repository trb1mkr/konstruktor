// Страница истории: хронология визитов, группировка по дню/месяцу/году,
// поиск и удаление. Выделено из internalPages.ts.
import { t } from '../i18n'
import { shell } from './shell'

export function buildHistoryPage(lang: string): string {
  return shell(
    t('history.title'),
    `<div class="hist-controls">
     <input id="q" type="search" placeholder="${t('history.search')}" autocomplete="off" />
     <div class="seg" id="mode">
       <button data-mode="day" class="on">${t('history.modeDay')}</button><button data-mode="month">${t('history.modeMonth')}</button><button data-mode="year">${t('history.modeYear')}</button>
     </div>
   </div>
   <div class="toolbar">
     <button id="clear" class="danger">${t('history.clearAll')}</button>
     <span id="stats" class="hint"></span>
   </div>
   <div id="tree"><div class="empty">${t('history.loading')}</div></div>
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
       if (dayKey(d) === dayKey(today)) return tr('history.today');
       if (dayKey(d) === dayKey(y)) return tr('history.yesterday');
       return d.toLocaleDateString(window.__I18N_INTL__, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
     }
     function fmtMonth(d) { return d.toLocaleDateString(window.__I18N_INTL__, { month: 'long', year: 'numeric' }); }
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
         tree.innerHTML = '<div class="empty">' + tr('internal.bridgeUnavailable') + '</div>';
         return;
       }
       let rows = [];
       try {
         rows = await window.konstruktor.historyTimeline(query);
       } catch (err) {
         tree.innerHTML = '<div class="empty">' + tr('history.loadFailed') + '</div>';
         return;
       }
       if (rows.length === 0) {
         tree.innerHTML = '<div class="empty">' + tr('history.empty') + '</div>';
         stats.textContent = '';
         return;
       }
       const urls = new Set(rows.map((r) => r.url)).size;
       stats.textContent = tr('history.stats', { visits: rows.length, sites: urls });
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
         c.textContent = tr('history.groupCount', { count: g.items.length });
         sum.append(s, c);
         details.appendChild(sum);
         for (const r of g.items) {
           const row = document.createElement('div');
           row.className = 'row';
           const fav = r.favicon
             ? '<img class="fav" src="' + r.favicon + '" />'
             : '<span class="fav">◉</span>';
           const time = mode === 'day'
             ? new Date(r.at).toLocaleTimeString(window.__I18N_INTL__, { hour: '2-digit', minute: '2-digit' })
             : new Date(r.at).toLocaleString(window.__I18N_INTL__);
           row.innerHTML = fav + '<div class="meta"><div class="t"></div><div class="u"></div></div>' +
             '<span class="when">' + time + '</span>' +
             '<button data-del title="' + tr('history.deleteVisit') + '">✕</button>';
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
       if (confirm(tr('history.clearConfirm'))) {
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
   </style>`,
    lang
  )
}
