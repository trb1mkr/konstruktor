// Страница загрузок: список с прогрессом, системными иконками,
// открытием и удалением. Выделено из internalPages.ts.
import { t } from '../i18n'
import { shell } from './shell'

export function buildDownloadsPage(lang: string): string {
  return shell(
    t('downloads.title'),
    `<input id="q" type="search" placeholder="${t('downloads.search')}" autocomplete="off" />
   <div class="toolbar">
     <button id="clear" class="danger">${t('downloads.clear')}</button>
   </div>
   <div id="list"><div class="empty">${t('downloads.loading')}</div></div>
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
           return tr('downloads.progress', {
             percent: pct,
             received: fmtBytes(e.receivedBytes),
             total: fmtBytes(e.totalBytes)
           });
         }
         return tr('downloads.downloading', { size: fmtBytes(e.receivedBytes) });
       }
       if (e.state === 'completed') return fmtBytes(e.totalBytes || e.receivedBytes);
       if (e.state === 'cancelled') return tr('downloads.cancelled');
       return tr('downloads.interrupted');
     }
     async function load(query = '') {
       if (!window.konstruktor) {
         list.innerHTML = '<div class="empty">' + tr('internal.bridgeUnavailable') + '</div>';
         return;
       }
       let entries = [];
       try {
         entries = await window.konstruktor.downloadsSearch(query);
       } catch (err) {
         list.innerHTML = '<div class="empty">' + tr('downloads.loadFailed') + '</div>';
         return;
       }
       if (entries.length === 0) {
         list.innerHTML = '<div class="empty">' + tr('downloads.empty') + '</div>';
         return;
       }
       list.innerHTML = '';
       for (const e of entries) {
         const row = document.createElement('div');
         row.className = 'row';
         const when = new Date(e.startedAt).toLocaleString(window.__I18N_INTL__);
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
           (e.state === 'completed' ? '<button data-open>' + tr('downloads.open') + '</button>' : '') +
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
       if (confirm(tr('downloads.clearConfirm'))) {
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
   </style>`,
    lang
  )
}
