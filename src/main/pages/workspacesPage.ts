// Страница konstruktor://workspaces: список рабочих пространств и
// управление ими.
//
// Пространство — это контейнер данных браузера (вкладки, группы, закладки,
// профиль, настройки, расширения, история). Страница умеет создавать
// пустое пространство, дублировать существующее, править имя/иконку/цвет и
// удалять. Копирование конфигурации — выбором секций: cookies и история
// принадлежат машине и моменту, а не настройке, и не переносятся никогда.
//
// Собирается как остальные внутренние страницы: HTML на каждый запрос
// (статические строки — через t(), динамические в скрипте — через tr()).
import { translatorFor, type Translator } from '../i18n'
import { CONFIG_SECTIONS, type ConfigSection } from '../workspaces/configCopy'
import { shell } from './shell'

// Подписи секций копирования. Литеральные ключи в вызовах t(), а не
// собираемые из id: динамический ключ не находит ни типизация, ни i18n:scan.
// Резолв — функция, а не константа модуля: t() синхронен только после
// initI18n(), а импорт модуля случается раньше. Переводчица — аргументом:
// язык принадлежит пространству.
function sectionLabels(t: Translator): Record<ConfigSection, string> {
  return {
    settings: t('workspaces.sectionSettings'),
    bookmarks: t('workspaces.sectionBookmarks'),
    groups: t('workspaces.sectionGroups'),
    shortcuts: t('workspaces.sectionShortcuts'),
    permissions: t('workspaces.sectionPermissions'),
    extensions: t('workspaces.sectionExtensions')
  }
}

export function buildWorkspacesPage(lang: string): string {
  const t = translatorFor(lang)
  const resolved = sectionLabels(t)
  const sections = CONFIG_SECTIONS.map((id) => ({ id, label: resolved[id] }))
  // Подписи, которые нужны скрипту страницы: t() в main уже разрешил язык,
  // а tr() в браузере достаёт их по ключу.
  //
  // «Системное» у default больше нет: пространство стало обычным, его можно
  // удалить (нельзя удалить только последнее оставшееся), и плашка сообщала
  // бы о запрете, которого нет.
  const labels = {
    createTitle: t('workspaces.createTitle'),
    editTitle: t('workspaces.editTitle'),
    open: t('workspaces.open'),
    edit: t('workspaces.edit'),
    duplicate: t('workspaces.duplicate'),
    remove: t('workspaces.remove'),
    badgeRunning: t('workspaces.badgeRunning'),
    detailCreated: t('workspaces.detailCreated'),
    detailOpened: t('workspaces.detailOpened'),
    detailTabs: t('workspaces.detailTabs'),
    detailGroups: t('workspaces.detailGroups'),
    detailBookmarks: t('workspaces.detailBookmarks'),
    neverOpened: t('workspaces.neverOpened'),
    errorRunning: t('workspaces.errorRunning'),
    errorLast: t('workspaces.errorLast'),
    errorFailed: t('workspaces.errorFailed')
  }
  return shell(
    t('workspaces.title'),
    `<p class="hint">${t('workspaces.hint')}</p>
   <div class="toolbar"><button type="button" id="create">➕ ${t('workspaces.create')}</button></div>
   <div class="form-error" id="notice" hidden></div>

   <section id="form" class="card form" hidden>
     <h2 id="form-title"></h2>
     <label class="set"><span>${t('workspaces.name')}</span>
       <input id="f-name" type="text" spellcheck="false"
         placeholder="${t('workspaces.namePlaceholder')}" /></label>
     <div class="pair">
       <label class="set icon-set"><span>${t('workspaces.icon')}</span>
         <input id="f-icon" type="text" spellcheck="false"
           inputmode="text" autocomplete="off" placeholder="🗂️" /></label>
       <label class="set"><span>${t('workspaces.color')}</span>
         <input id="f-color" type="color" value="#888888" /></label>
     </div>
     <div id="copy-block">
       <label class="set"><span>${t('workspaces.copyFrom')}</span>
         <select id="f-copy"></select></label>
       <!-- Подсказка и флажки секций показываются только при выбранном
            источнике. Сам селектор источника виден всегда в режиме
            создания: раньше блок прятался целиком при значении «не
            копировать», и выбрать источник было нечем. -->
       <div id="copy-details">
         <div class="hint">${t('workspaces.copyHint')}</div>
         <div id="sections" class="sections"></div>
       </div>
     </div>
     <div class="form-error" id="form-error" hidden></div>
     <div class="toolbar">
       <button type="button" id="f-save">${t('workspaces.save')}</button>
       <button type="button" id="f-cancel">${t('common.cancel')}</button>
     </div>
   </section>

   <div id="list"><div class="empty">${t('downloads.loading')}</div></div>

   <dialog class="ws-dialog" id="confirm">
     <h3>${t('workspaces.removeTitle')}</h3>
     <p id="confirm-text"></p>
     <div class="ws-dialog-actions">
       <button type="button" id="confirm-yes" class="danger">${t('workspaces.remove')}</button>
       <button type="button" id="confirm-no">${t('common.cancel')}</button>
     </div>
   </dialog>

   <style>
     .card { background: var(--pg-panel); border: 1px solid var(--pg-border);
       border-radius: 12px; padding: 12px 14px; margin-top: 10px; }
     /* Карточка пространства целиком — кнопка раскрытия: клик по любому
        месту, кроме кнопок управления, показывает статистику. */
     .ws-card { position: relative; padding-left: 18px; cursor: pointer; }
     .ws-card:hover { background: var(--pg-hover); }
     .ws-row { display: flex; gap: 14px; align-items: center; }
     /* Иконка пространства: один эмодзи. Фон нейтральный — цвет
        пространства показывается полоской слева, иначе карточка
        превращается в цветное пятно и читается хуже списка. */
     .ws-icon { width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
       display: flex; align-items: center; justify-content: center;
       font-size: 22px; line-height: 1; overflow: hidden;
       background: var(--pg-hover); border: 1px solid var(--pg-border); }
     /* Полоска цвета пространства слева от карточки: тот же приём, что у
        группы вкладок в браузере. */
     .ws-card::before { content: ''; position: absolute; left: 0; top: 10px;
       bottom: 10px; width: 4px; border-radius: 0 3px 3px 0; background: var(--ws-color, var(--pg-border)); }
     .ws-meta { flex: 1; min-width: 0; }
     .ws-name { font-size: 15px; font-weight: 600; display: flex; gap: 8px;
       align-items: center; flex-wrap: wrap; }
     .badge { font-size: 11px; font-weight: 500; padding: 2px 7px; border-radius: 999px;
       background: var(--pg-hover); color: var(--pg-dim); border: 1px solid var(--pg-border); }
     .badge.run { color: var(--pg-text); border-color: var(--pg-dim); }
     /* Треугольник раскрытия: подсказка, что карточка нажимается. */
     .ws-caret { flex-shrink: 0; color: var(--pg-dim); font-size: 12px;
       transition: transform 0.12s ease; }
     .ws-card.open .ws-caret { transform: rotate(180deg); }
     /* Раскрытая статистика: вертикальный список «параметр: значение»,
        по строке на параметр. Сетка карточек читалась как набор плиток,
        а это именно свойства ОДНОГО объекта — их читают сверху вниз. */
     .ws-details { display: flex; flex-direction: column; gap: 6px; margin-top: 12px;
       padding-top: 12px; border-top: 1px solid var(--pg-border); }
     /* Строка — обычный текст, не flex: двоеточие и пробел стоят в потоке,
        поэтому копирование строки даёт «Параметр: значение», а не слипшееся
        «Параметр:значение». */
     .ws-param { font-size: 13px; line-height: 1.35; }
     .ws-param .k { color: var(--pg-dim); }
     .ws-param .v { color: var(--pg-text); }
     .ws-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
     .ws-actions button { padding: 6px 12px; font-size: 13px; }
     .ws-actions button:disabled { opacity: 0.45; cursor: default; }
     .pair { display: flex; gap: 12px; align-items: flex-end; }
     .pair .set { flex: 1; }
     /* Поле иконки — размером с эмодзи: вводится ровно один символ, и
        растянутое на полширины поле обещало бы текст. Правило общих полей
        ввода (input[type="text"] { width: 100% } в shell.ts) перебивается
        только более точным селектором — одной ширины в классе мало. */
     .pair .icon-set { flex: 0 0 auto; }
     .pair .icon-set input[type="text"] { width: 64px; height: 38px; padding: 0 8px;
       text-align: center; font-size: 20px; }
     /* Поле цвета выглядит как остальные поля ввода: та же рамка, скругление
        и высота. У нативного color-input своя серая рамка-рамка вокруг
        образца (border + padding самого контрола), из-за неё он выпадал из
        ряда — снимаем её и переносим оформление на общий стиль. */
     .pair input[type="color"] { width: 64px; height: 38px; padding: 3px;
       border: 1px solid var(--pg-input-border); border-radius: 8px;
       background: var(--pg-panel); cursor: pointer; }
     .pair input[type="color"]::-webkit-color-swatch-wrapper { padding: 0; }
     .pair input[type="color"]::-webkit-color-swatch { border: none; border-radius: 5px; }
     .sections { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 8px; }
     .sections label.check { margin-top: 0; }
     .form h2 { font-size: 16px; margin: 0 0 4px; }
     .form-error { margin-top: 12px; font-size: 13px; color: #ff8a8a; }
     /* Строка уведомления под кнопкой «Создать»: успех — обычным
        приглушённым, отказ — цветом ошибки. Отдельный элемент, а не
        .form-error: успешное «Скопировано: …» красным читалось бы
        как сбой. */
     #notice { margin-top: 12px; font-size: 13px; color: var(--pg-dim); }
     #notice.err { color: #ff8a8a; }
     dialog.ws-dialog { background: var(--pg-panel); color: var(--pg-text);
       border: 1px solid var(--pg-input-border); border-radius: 14px;
       padding: 20px; width: min(420px, 90vw); }
     dialog.ws-dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
     dialog.ws-dialog h3 { margin: 0 0 10px; font-size: 16px; }
     dialog.ws-dialog p { margin: 0 0 8px; font-size: 13px; }
     dialog.ws-dialog .ws-dialog-actions { display: flex; justify-content: flex-end;
       gap: 8px; margin-top: 16px; }
     dialog.ws-dialog .ws-dialog-actions button { padding: 6px 12px; font-size: 13px; }
     @media (max-width: 620px) { .ws-row { flex-wrap: wrap; } .ws-actions { width: 100%; } }
   </style>

   <script>
     (function () {
       var api = window.konstruktor;
       var SECTIONS = ${JSON.stringify(sections)};
       var L = ${JSON.stringify(labels)};
       var listEl = document.getElementById('list');
       var formEl = document.getElementById('form');
       var errorEl = document.getElementById('form-error');
       var sectionsEl = document.getElementById('sections');
       var copySel = document.getElementById('f-copy');
       var confirmDlg = document.getElementById('confirm');
       var rows = [];
       var editingId = null;
       var pendingDelete = null;
       // Раскрытые карточки: набор живёт до перерисовки списка, поэтому
       // состояние переживает load() и не сбрасывается каждым обновлением.
       var expanded = {};
       // Пространства, открытые ИЗ ЭТОЙ страницы. Признак «открыто»
       // объединяется с тем, что видит main: закрытие окна страница не
       // отслеживает (пуша о закрытии в неё нет), и одной отметки хватает —
       // пункт загорается сразу при открытии и не гаснет.
       var openedHere = {};

       function esc(value) {
         return String(value).replace(/[&<>"]/g, function (c) {
           return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
         });
       }
       function dateOf(ts) {
         try { return new Date(ts).toLocaleDateString(window.__I18N_INTL__ || 'en'); }
         catch (e) { return ''; }
       }
       function rowById(id) {
         for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
         return null;
       }
       function sectionLabel(id) {
         for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].id === id) return SECTIONS[i].label;
         return id;
       }

       // Иконка пространства — ровно один эмодзи. Значение приходит из main
       // уже нормализованным (registry.normalizeIcon), но и в форме
       // допускается только он: вставку «Работа 🏢» сворачиваем до 🏢, а
       // чистый текст отбрасываем, иначе в квадрат 40px попадёт слово.
       function emojiOnly(text) {
         var value = String(text);
         var segments;
         try {
           segments = Array.from(
             new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
             function (s) { return s.segment; }
           );
         } catch (e) {
           segments = Array.from(value);
         }
         for (var i = 0; i < segments.length; i++) {
           if (/\\p{Extended_Pictographic}/u.test(segments[i])) return segments[i];
         }
         return '';
       }

       function iconHtml(icon) {
         return esc(icon || '🗂️');
       }

       // Строка статистики в виде «параметр: значение» — по строке на
       // параметр. Значения считает main: странице незачем знать раскладку
       // файлов пространства.
       function stat(label, value) {
         return '<div class="ws-param"><span class="k">' + esc(label) + ':</span> ' +
           '<span class="v">' + esc(value) + '</span></div>';
       }

       function detailsHtml(row) {
         return '<div class="ws-details">' +
           stat(L.detailCreated, dateOf(row.createdAt)) +
           stat(L.detailOpened, row.lastOpenedAt ? dateOf(row.lastOpenedAt) : L.neverOpened) +
           stat(L.detailTabs, row.tabs) +
           stat(L.detailGroups, row.groups) +
           // Закладки вместе с группами: группа на панели закладок — такой
           // же элемент панели, и отдельный счётчик рядом читался бы как
           // «сколько закладок, не считая видимых».
           stat(L.detailBookmarks, row.bookmarks + row.groups) +
         '</div>';
       }

       function card(row) {
         var running = row.running || openedHere[row.id];
         var badges = running
           ? '<span class="badge run">' + esc(L.badgeRunning) + '</span>'
           : '';
         // Удаление есть у КАЖДОГО пространства, включая default: запрет
         // касается только последнего оставшегося, и кнопка гаснет ровно
         // тогда. Скрытая кнопка заставляла бы гадать, почему её нет.
         var onlyOne = rows.length <= 1;
         var del = '<button type="button" class="danger" data-act="delete"' +
           (onlyOne ? ' disabled title="' + esc(L.errorLast) + '"' : '') +
           '>' + esc(L.remove) + '</button>';
         var isOpen = !!expanded[row.id];
         return '<div class="card ws-card' + (isOpen ? ' open' : '') + '" data-id="' +
             esc(row.id) + '" style="--ws-color:' + esc(row.color) + '">' +
           '<div class="ws-row">' +
             '<div class="ws-icon">' + iconHtml(row.icon) + '</div>' +
             '<div class="ws-meta">' +
               '<div class="ws-name">' + esc(row.name) + badges + '</div>' +
             '</div>' +
             '<div class="ws-actions">' +
               '<button type="button" data-act="open">' + esc(L.open) + '</button>' +
               '<button type="button" data-act="edit">' + esc(L.edit) + '</button>' +
               '<button type="button" data-act="duplicate">' + esc(L.duplicate) + '</button>' +
               del +
             '</div>' +
             '<span class="ws-caret" aria-hidden="true">▾</span>' +
           '</div>' +
           (isOpen ? detailsHtml(row) : '') +
         '</div>';
       }

       function render() {
         if (!rows.length) {
           listEl.innerHTML = '<div class="empty">' + tr('workspaces.empty') + '</div>';
           return;
         }
         listEl.innerHTML = rows.map(card).join('');
       }

       function fillCopyOptions() {
         var current = copySel.value;
         var options = ['<option value="none">' + esc(tr('workspaces.copyNone')) + '</option>'];
         rows.forEach(function (row) {
           options.push('<option value="' + esc(row.id) + '">' + esc(row.name) + '</option>');
         });
         copySel.innerHTML = options.join('');
         copySel.value = current && rowById(current) ? current : 'none';
         syncCopyBlock();
       }

       function syncCopyBlock() {
         // Прячем только подсказку и флажки: сам селектор источника нужен,
         // чтобы источник можно было ВЫБРАТЬ (раньше при «не копировать»
         // прятался весь блок вместе с ним).
         document.getElementById('copy-details').hidden = copySel.value === 'none';
       }

       function showError(text) {
         errorEl.textContent = text;
         errorEl.hidden = !text;
       }

       // Уведомление вне формы: отказ в удалении приходит из списка, а
       // форма в этот момент закрыта. window.alert не используем —
       // модальное окно браузера блокирует страницу целиком и выглядит
       // чужим среди своих диалогов.
       function notify(text, isError) {
         var el = document.getElementById('notice');
         el.textContent = text || '';
         el.classList.toggle('err', !!isError);
         el.hidden = !text;
       }

       function showForm(editRow) {
         editingId = editRow ? editRow.id : null;
         document.getElementById('form-title').textContent =
           editRow ? L.editTitle : L.createTitle;
         document.getElementById('f-name').value = editRow ? editRow.name : '';
         document.getElementById('f-icon').value = editRow ? editRow.icon : '🗂️';
         document.getElementById('f-color').value =
           editRow && /^#[0-9a-f]{6}$/i.test(editRow.color) ? editRow.color : '#888888';
         // Секции и источник копирования нужны только при создании:
         // правка параметров существующего пространства конфиг не трогает.
         document.getElementById('copy-block').hidden = !!editRow;
         if (!editRow) fillCopyOptions();
         showError('');
         notify('');
         formEl.hidden = false;
         document.getElementById('f-name').focus();
         document.getElementById('f-name').select();
       }

       function hideForm() {
         editingId = null;
         formEl.hidden = true;
         showError('');
       }

       async function load() {
         if (!api || !api.workspacesList) {
           listEl.innerHTML = '<div class="empty">' + tr('internal.bridgeUnavailable') + '</div>';
           return;
         }
         rows = await api.workspacesList();
         render();
         if (!formEl.hidden && !editingId) fillCopyOptions();
       }

       async function save() {
         var name = document.getElementById('f-name').value.trim();
         if (!name) { document.getElementById('f-name').focus(); return; }
         // Иконка — один эмодзи. Пустое поле и текст без эмодзи дают иконку
         // по умолчанию: отказ в сохранении из-за иконки был бы странным,
         // когда имя уже введено.
         var iconRaw = document.getElementById('f-icon').value;
         var icon = emojiOnly(iconRaw) || '🗂️';
         document.getElementById('f-icon').value = icon;
         var color = document.getElementById('f-color').value;
         var res;
         if (editingId) {
           res = await api.workspacesUpdate({ id: editingId, name: name, icon: icon, color: color });
         } else {
           var from = copySel.value;
           var picked = [];
           if (from !== 'none') {
             var boxes = sectionsEl.querySelectorAll('input[type="checkbox"]');
             for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) picked.push(boxes[i].value);
           }
           res = await api.workspacesCreate({
             name: name, icon: icon, color: color,
             copyFrom: from === 'none' ? undefined : from,
             sections: from === 'none' ? [] : picked
           });
         }
         if (!res || !res.ok) { showError(L.errorFailed); return; }
         // Какие секции скопировались на самом деле: файла могло не быть,
         // и обещать копирование всех отмеченных нельзя.
         var copied = !editingId && res.copied && res.copied.length
           ? tr('workspaces.copied', { sections: res.copied.map(sectionLabel).join(', ') })
           : '';
         hideForm();
         notify(copied);
         await load();
       }

       async function askDelete(row) {
         pendingDelete = row;
         document.getElementById('confirm-text').textContent =
           tr('workspaces.removeConfirm', { name: row.name });
         confirmDlg.showModal();
       }

       document.getElementById('create').addEventListener('click', function () {
         showForm(null);
       });
       document.getElementById('f-cancel').addEventListener('click', hideForm);
       document.getElementById('f-save').addEventListener('click', save);
       copySel.addEventListener('change', syncCopyBlock);

       // Иконка принимает ровно один эмодзи, и это видно сразу: набранный
       // текст не появляется в поле, а вставка «Работа 🏢» сворачивается до
       // 🏢. Молчаливая чистка при сохранении выглядела бы потерей ввода.
       document.getElementById('f-icon').addEventListener('input', function (e) {
         var only = emojiOnly(e.target.value);
         if (only !== e.target.value) e.target.value = only;
       });

       // Enter в форме сохраняет: поле ввода — единственный способ ввести
       // имя, и заставлять искать кнопку мышью незачем.
       formEl.addEventListener('keydown', function (e) {
         if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' &&
             e.target.type !== 'checkbox') {
           e.preventDefault();
           void save();
         }
       });

       // Клик по карточке раскрывает статистику, клик по кнопке выполняет
       // действие. Кнопки лежат ВНУТРИ карточки, поэтому проверка идёт
       // первой: иначе «Удалить» заодно раскрывало бы карточку.
       listEl.addEventListener('click', async function (e) {
         var cardEl = e.target.closest('[data-id]');
         if (!cardEl) return;
         var row = rowById(cardEl.dataset.id);
         if (!row) return;
         var btn = e.target.closest('button');
         if (!btn) {
           expanded[row.id] = !expanded[row.id];
           render();
           return;
         }
         if (btn.disabled) return;
         var act = btn.dataset.act;
         if (act === 'open') {
           btn.disabled = true;
           await api.workspacesOpen(row.id);
           // Отметка «открыто» ставится до перечитывания списка: окно
           // создаётся в main асинхронно по отношению к странице, и без
           // неё плашка загоралась бы не сразу.
           openedHere[row.id] = true;
           await load();
           return;
         }
         if (act === 'edit') { showForm(row); return; }
         if (act === 'duplicate') {
           btn.disabled = true;
           var dup = await api.workspacesDuplicate(row.id);
           btn.disabled = false;
           if (!dup || !dup.ok) showError(L.errorFailed);
           await load();
           return;
         }
         if (act === 'delete') { await askDelete(row); }
       });

       document.getElementById('confirm-no').addEventListener('click', function () {
         pendingDelete = null;
         confirmDlg.close();
       });
       document.getElementById('confirm-yes').addEventListener('click', async function () {
         var row = pendingDelete;
         pendingDelete = null;
         confirmDlg.close();
         if (!row) return;
         var res = await api.workspacesDelete(row.id);
         if (res && !res.ok) {
           // Причина отказа важнее закрытия диалога: «открыто» и
           // «последнее» — разные действия пользователя.
           var map = { running: L.errorRunning, last: L.errorLast };
           notify(map[res.error] || L.errorFailed, true);
         } else {
           delete expanded[row.id];
           delete openedHere[row.id];
           notify('');
         }
         await load();
       });

       // Флажки секций строятся ОДИН раз: набор секций задаёт main
       // (CONFIG_SECTIONS), и страница не должна знать его наизусть.
       // Без этой строки форма создания показывала источник копирования,
       // но не сами секции — и «копировать» означало «копировать всё».
       sectionsEl.innerHTML = SECTIONS.map(function (s) {
         return '<label class="check"><input type="checkbox" value="' + esc(s.id) +
           '" checked /><span>' + esc(s.label) + '</span></label>';
       }).join('');

       void load();
     })();
   </script>`,
    lang
  )
}
