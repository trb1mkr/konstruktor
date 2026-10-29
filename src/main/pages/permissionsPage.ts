// Страница konstruktor://permissions: решения по разрешениям сайтов.
//
// Отдельная страница, а не раздел в настройках: список растёт вместе с
// числом посещённых сайтов, и в общем потоке настроек он хоронил бы под
// собой и тему, и горячие клавиши. В настройках осталась только кнопка
// перехода.
//
// Решения сгруппированы по САЙТАМ, а внутри сайта — по статусу:
// «Разрешено» и «Заблокировано» подзаголовками. Прежний вид «каждое
// разрешение — статус» читался плохо: строки одного сайта шли вразнобой,
// и понять, что сайту выдано, можно было только вычитывая каждую строку.
//
// Собирается как остальные внутренние страницы: HTML на каждый запрос
// (статические строки — через t(), динамические в скрипте — через tr()).
import { translatorFor } from '../i18n'
import { ALL_SCOPES, SCOPE_ICON, SCOPE_LABEL } from '../permissions/policy'
import { shell } from './shell'

// Адрес страницы проверки разрешений. Внешний сайт, открывается в той же
// вкладке обычной навигацией: он показывает, что браузер спрашивает у
// пользователя на самом деле.
const TEST_SITE = 'https://permission.site'

export function buildPermissionsPage(lang: string): string {
  // Язык — параметр сборки: страница отдаётся в языке СВОЕГО пространства.
  const t = translatorFor(lang)
  // Метаданные областей считаются здесь, а не в скрипте: таблица областей
  // живёт в main (permissions/policy.ts), и подписи переводятся t().
  const scopeMeta = ALL_SCOPES.map((scope) => ({
    scope,
    icon: SCOPE_ICON[scope],
    label: t(SCOPE_LABEL[scope]),
  }))
  return shell(
    t('permissions.settingsTitle'),
    `<p class="hint">${t('permissions.settingsHint')}</p>
   <div class="set"><span>${t('permissions.testTitle')}</span>
     <div class="hint">${t('permissions.testHint')}</div>
     <div class="toolbar"><button type="button" id="test-site">${TEST_SITE}</button></div></div>
   <div class="toolbar">
     <button id="clear-all" class="danger">${t('permissions.clearAll')}</button>
   </div>
   <div id="list"><div class="empty">${t('downloads.loading')}</div></div>
   <style>
     .site { background: var(--pg-panel); border: 1px solid var(--pg-border); border-radius: 10px; margin-top: 10px; padding: 12px 14px; }
     .site-head { display: flex; gap: 12px; align-items: center; }
     .site-origin { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
     /* Подзаголовок статуса: размер и цвет как у обычного текста. Мелкий
        тусклый (.hint) он читался слабее списка, который делит, — а
        делит он список, а не подпись под кнопкой. */
     .group-title { font-size: 14px; color: var(--pg-text); margin: 10px 0 4px; }
     .group-title--first { margin-top: 8px; }
     .entry { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 3px 0; }
     .entry-icon { width: 18px; text-align: center; flex-shrink: 0; }
     /* Кнопка снятия решения: отдельная КВАДРАТНАЯ кнопка справа от
        названия, а не часть строки. Рамка видна всегда: без неё корзина
        читалась как украшение строки, а не как то, что можно нажать. Она
        видна ВСЕГДА, а не по наведению: скрытая кнопка читается как
        отсутствие функции, а список от неё не превращается в стену.
        Размер — как у корзины в меню бейджа (.menu-action). */
     .reset-btn {
       margin-left: auto;
       width: 28px; height: 28px; padding: 0;
       display: inline-flex; align-items: center; justify-content: center;
       background: transparent; color: var(--pg-text);
       border: 1px solid var(--pg-input-border); border-radius: 8px;
       cursor: pointer; font-size: 15px; line-height: 1;
     }
     .reset-btn:hover { background: var(--pg-hover); }
   </style>
   <script>
     (function () {
       var api = window.konstruktor;
       var list = document.getElementById('list');
       var SCOPE_META = ${JSON.stringify(scopeMeta)};

       function scopeById(scope) {
         for (var i = 0; i < SCOPE_META.length; i++) {
           if (SCOPE_META[i].scope === scope) return SCOPE_META[i];
         }
         return null;
       }

       // Подзаголовок статуса: одна строка на группу, а не статус у каждой
       // записи. Пустую группу не рисуем — иначе у сайта с одним запретом
       // висел бы пустой заголовок «Разрешено».
       function groupTitle(icon, text, first) {
         return '<div class="group-title' + (first ? ' group-title--first' : '') + '">' +
           icon + ' ' + text + '</div>';
       }

       function entries(items) {
         return items.map(function (item) {
           var info = scopeById(item.scope);
           var icon = info ? info.icon : '🔒';
           var label = info ? info.label : item.scope;
           return '<div class="entry">' +
             '<span class="entry-icon">' + icon + '</span>' +
             '<span>' + label + '</span>' +
             // Снятие ОДНОЙ области: решение убирается только у неё, остальные
             // решения сайта остаются. После снятия промпт вернётся при
             // следующем запросе именно этой области. data-scope нужен
             // обработчику: он снимает решение точечно.
             '<button class="reset-btn" data-act="reset-scope" data-scope="' + item.scope + '" ' +
               'title="' + tr('permissions.resetScopeHint') + '">🗑️</button>' +
           '</div>';
         }).join('');
       }

       function site(origin, scopes) {
         var allowed = scopes.filter(function (s) { return s.value === 'allow'; });
         var blocked = scopes.filter(function (s) { return s.value !== 'allow'; });
         var body = '';
         if (allowed.length) {
           body += groupTitle('✅', tr('permissions.allowedHeading'), true) + entries(allowed);
         }
         if (blocked.length) {
           body += groupTitle('⛔', tr('permissions.blockedHeading'), allowed.length === 0) +
             entries(blocked);
         }
         return '<div class="site" data-origin="' + origin.replace(/"/g, '&quot;') + '">' +
           '<div class="site-head">' +
             '<div class="site-origin">' + origin + '</div>' +
             '<button class="reset-btn" data-act="reset-site" ' +
               'title="' + tr('permissions.clearSiteHint') + '">🗑️</button>' +
           '</div>' + body +
         '</div>';
       }

       async function load() {
         if (!api || !api.permissionsList) {
           list.innerHTML = '<div class="empty">' + tr('internal.bridgeUnavailable') + '</div>';
           return;
         }
         var rows = await api.permissionsList();
         if (!rows.length) {
           list.innerHTML = '<div class="empty">' + tr('permissions.settingsEmpty') + '</div>';
           return;
         }
         list.innerHTML = rows.map(function (row) { return site(row.origin, row.scopes); }).join('');
       }

       list.addEventListener('click', async function (e) {
         var btn = e.target.closest('button');
         if (!btn) return;
         var card = btn.closest('.site');
         if (!card) return;
         if (btn.dataset.act === 'reset-site') {
           await api.permissionsClearOrigin(card.dataset.origin);
         } else if (btn.dataset.act === 'reset-scope') {
           // Снятие одной области: остальные решения сайта не трогаем.
           await api.permissionsClearScope(card.dataset.origin, btn.dataset.scope);
         } else {
           return;
         }
         await load();
       });

       document.getElementById('clear-all').addEventListener('click', async function () {
         if (!api) return;
         await api.permissionsClearAll();
         await load();
       });

       document.getElementById('test-site').addEventListener('click', function () {
         location.href = '${TEST_SITE}';
       });

       void load();
     })();
   </script>`,
    lang,
  )
}
