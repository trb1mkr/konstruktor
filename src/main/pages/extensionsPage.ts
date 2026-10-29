// Страница konstruktor://extensions: список расширений, установка, тумблеры.
// Собирается как остальные внутренние страницы: HTML на каждый запрос
// (статичные строки — через t(), динамические в <script> — через tr()).
//
// Страница не правит реестр напрямую: все действия уходят в main через
// window.konstruktor.*, а состояние приезжает либо ответом, либо пушем
// extensions:state (его шлёт main после любой операции).
import { translatorFor } from '../i18n'
import { shell } from './shell'

// Язык — параметр сборки: страница отдаётся в языке СВОЕГО пространства.
export function buildExtensionsPage(lang: string): string {
  const t = translatorFor(lang)
  return shell(
    t('extensions.title'),
    `<div class="toolbar">
     <button id="inst-folder">${t('extensions.installFolder')}</button>
     <button id="inst-crx">${t('extensions.installArchive')}</button>
     <button id="upd">${t('extensions.checkUpdates')}</button>
   </div>
   <label class="check"><input id="enabled" type="checkbox" /><span>${t('extensions.enabled')}</span></label>
   <label class="check"><input id="devmode" type="checkbox" /><span>${t('extensions.devMode')}</span></label>
   <div id="list"></div>
   <style>
     .ext { background: var(--pg-panel); border: 1px solid var(--pg-border); border-radius: 10px; margin-top: 10px; padding: 12px 14px; }
     .ext-head { display: flex; gap: 12px; align-items: flex-start; }
     .ext-ico { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--pg-btn); font-size: 16px; }
     .ext-meta { flex: 1; min-width: 0; }
     .ext-name { font-size: 15px; display: flex; gap: 8px; align-items: baseline; }
     .ext-ver { font-size: 12px; color: var(--pg-faint); }
     .ext-desc { font-size: 13px; color: var(--pg-dim); margin-top: 2px; }
     .ext-acts { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
     .ext-acts button { padding: 6px 10px; font-size: 12px; }
     .tags { margin-top: 8px; font-size: 12px; color: var(--pg-dim); display: flex; flex-direction: column; gap: 4px; }
     .tags code { background: var(--pg-hover); padding: 1px 5px; border-radius: 4px; margin-right: 4px; }
     .warn { margin-top: 8px; font-size: 12px; color: #e2b04a; }
     .warn ul { margin: 4px 0 0 18px; padding: 0; }
     .err { margin-top: 8px; font-size: 12px; color: #e06c6c; }
   </style>
   <script>
     (function () {
       var api = window.konstruktor;
       var list = document.getElementById('list');
       var enabledBox = document.getElementById('enabled');
       var devBox = document.getElementById('devmode');
       var current = null;

       function esc(s) {
         return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
           return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
         });
       }

       function badges(info) {
         var parts = [];
         parts.push('<code>' + esc(info.source === 'crx' ? tr('extensions.sourceCrx') : tr('extensions.sourceFolder')) + '</code>');
         if (info.permissions.length) parts.push('<code>' + esc(info.permissions.join(' ')) + '</code>');
         if (info.hosts.length) parts.push('<code>' + esc(info.hosts.join(' ')) + '</code>');
         if (!info.permissions.length && !info.hosts.length) parts.push('<code>' + tr('extensions.none') + '</code>');
         return '<div class="tags">' + parts.join('') + '</div>';
       }

       function card(info) {
         var icon = info.action && info.action.icon
           ? '<img class="ext-ico" src="' + esc(info.action.icon) + '" alt="">'
           : '<span class="ext-ico">' + esc((info.name || '?').slice(0, 1).toUpperCase()) + '</span>';
         var warn = info.warnings.length
           ? '<div class="warn">' + tr('extensions.warnings') +
             '<ul>' + info.warnings.map(function (w) { return '<li>' + esc(w) + '</li>' }).join('') + '</ul></div>'
           : '';
         var err = info.error
           ? '<div class="err">' + tr('extensions.error') + ': ' + esc(info.error) + '</div>'
           : '';
         return '<div class="ext" data-id="' + esc(info.id) + '">' +
           '<div class="ext-head">' + icon +
             '<div class="ext-meta">' +
               '<div class="ext-name"><span>' + esc(info.name) + '</span>' +
                 '<span class="ext-ver">' + tr('extensions.version') + ' ' + esc(info.version) + '</span></div>' +
               '<div class="ext-desc">' + esc(info.description) + '</div>' +
             '</div>' +
             '<div class="ext-acts">' +
               '<button data-act="toggle">' + (info.enabled ? tr('extensions.disable') : tr('extensions.enable')) + '</button>' +
               '<button data-act="reload">' + tr('extensions.reload') + '</button>' +
               '<button data-act="folder">' + tr('extensions.openFolder') + '</button>' +
               '<button data-act="remove" class="danger">' + tr('extensions.remove') + '</button>' +
             '</div>' +
           '</div>' + badges(info) + warn + err +
         '</div>';
       }

       function render(state) {
         current = state;
         enabledBox.checked = state.enabled !== false;
         devBox.checked = state.devMode === true;
         if (!state.list.length) {
           list.innerHTML = '<div class="empty">' + tr('extensions.empty') + '</div>';
           return;
         }
         list.innerHTML = state.list.map(card).join('');
       }

       async function refresh() {
         try {
           render(await api.extensionsList());
         } catch (e) {
           list.innerHTML = '<div class="empty">' + tr('internal.bridgeUnavailable') + '</div>';
         }
       }

       list.addEventListener('click', async function (e) {
         var btn = e.target.closest ? e.target.closest('button[data-act]') : null;
         if (!btn) return;
         var host = btn.closest('.ext');
         if (!host) return;
         var id = host.dataset.id;
         var act = btn.dataset.act;
         if (act === 'toggle') {
           var info = current.list.filter(function (i) { return i.id === id })[0];
           if (info && info.enabled) await api.extensionsDisable(id);
           else await api.extensionsEnable(id);
         } else if (act === 'reload') {
           await api.extensionsReload(id);
         } else if (act === 'folder') {
           await api.extensionsOpenFolder(id);
         } else if (act === 'remove') {
           if (confirm(tr('extensions.confirmRemove'))) await api.extensionsRemove(id);
         }
         await refresh();
       });

       document.getElementById('inst-folder').addEventListener('click', async function () {
         await api.extensionsInstallFolder();
         await refresh();
       });
       document.getElementById('inst-crx').addEventListener('click', async function () {
         await api.extensionsInstallArchive();
         await refresh();
       });
       document.getElementById('upd').addEventListener('click', async function () {
         var btn = this;
         btn.disabled = true;
         try {
           var updated = await api.extensionsCheckUpdates();
           btn.textContent = updated && updated.length
             ? tr('extensions.updatedCount', { count: updated.length })
             : tr('extensions.noUpdates');
           await refresh();
         } finally {
           btn.disabled = false;
         }
       });
       enabledBox.addEventListener('change', async function () {
         render(await api.extensionsSetEnabled(enabledBox.checked));
       });
       devBox.addEventListener('change', async function () {
         render(await api.extensionsSetDevMode(devBox.checked));
       });

       if (api.onExtensionsChanged) api.onExtensionsChanged(render);
       refresh();
     })();
   </script>`,
    lang
  )
}
