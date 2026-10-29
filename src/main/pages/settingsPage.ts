// Страница настроек: все опции браузера + визуальный выбор темы.
// Выделено из internalPages.ts.
//
// Опции языка строятся из реестра LANGUAGES: новый язык = запись
// в реестре + файл каталога, страница при этом не правится.
import { LANGUAGES } from '../../shared/i18n'
import { HOTKEY_ACTIONS, type HotkeyActionId } from '../../shared/hotkey-actions'
import { translatorFor, type Translator } from '../i18n'
import { shell } from './shell'

// Названия действий для таблицы: литеральные ключи i18n (динамический
// ключ не находил бы ни типизация, ни i18n:scan).
//
// Резолв — функция, а не константа модуля: t() синхронен только после
// initI18n(), а импорт модуля случается раньше. Подписи, посчитанные на
// уровне модуля, приходили пустыми: i18next до init отдаёт undefined.
// Переводчица приходит аргументом: язык — свойство ПРОСТРАНСТВА, а
// глобальная t() отдала бы язык процесса.
function hotkeyLabels(t: Translator): Record<HotkeyActionId, string> {
  return {
    reload: t('hotkeys.actions.reload'),
    'close-tab': t('hotkeys.actions.closeTab'),
    'new-tab': t('hotkeys.actions.newTab'),
    'reopen-closed': t('hotkeys.actions.reopenClosed'),
    find: t('hotkeys.actions.find'),
    devtools: t('hotkeys.actions.devtools'),
    fullscreen: t('hotkeys.actions.fullscreen')
  }
}

export function buildSettingsPage(lang: string): string {
  // Язык — параметр сборки: страница отдаётся в языке СВОЕГО пространства.
  const t = translatorFor(lang)
  const langOptions = LANGUAGES.map(
    (l) => `\n       <option value="${l.code}">${l.label}</option>`
  ).join('')
  // Строки таблицы горячих клавиш: действие, его подпись и акселератор по
  // умолчанию. Текущие значения подставляет скрипт страницы из настроек.
  const labels = hotkeyLabels(t)
  const hotkeyRows = HOTKEY_ACTIONS.map((a) => ({
    id: a.id,
    label: labels[a.id],
    def: a.defaultAccelerator
  }))
  return shell(
    t('settings.title'),
    `<label class="set"><span>${t('settings.searchEngine')}</span>
     <input id="se" type="text" spellcheck="false" /></label>
   <label class="set"><span>${t('settings.homepage')}</span>
     <input id="hp" type="text" spellcheck="false" /></label>
   <label class="check"><input id="dt" type="checkbox" /><span>${t('settings.devtools')}</span></label>
   <label class="set"><span>${t('settings.dns.label')}</span>
     <select id="dns">
       <option value="off">${t('settings.dns.system')}</option>
       <option value="cloudflare">Cloudflare (1.1.1.1)</option>
       <option value="google">Google (8.8.8.8)</option>
       <option value="custom">${t('settings.dns.customOption')}</option>
     </select></label>
   <label class="set" id="dns-custom-wrap" style="display:none"><span>${t('settings.dns.customUrl')}</span>
     <input id="dns-custom" type="text" spellcheck="false"
       placeholder="https://example.com/dns-query" /></label>
   <label class="set"><span>${t('settings.language')}</span>
     <select id="locale">
       <option value="auto">${t('settings.languageAuto')}</option>${langOptions}
     </select></label>
   <label class="check"><input id="anim-cb" type="checkbox" /><span>${t('settings.animations')}</span></label>
   <label class="check"><input id="rounded-cb" type="checkbox" /><span>${t('settings.roundedCorners')}</span></label>
   <label class="check"><input id="remember-cb" type="checkbox" /><span>${t('settings.rememberBounds')}</span></label>
   <label class="check"><input id="remember-tabs-cb" type="checkbox" /><span>${t('settings.rememberTabs')}</span></label>
   <div class="set"><span>${t('settings.menuParts')}</span>
     <div class="hint">${t('settings.menuPartsHint')}</div></div>
   <label class="check"><input id="menu-icons-cb" type="checkbox" /><span>${t('settings.menuIcons')}</span></label>
   <label class="check"><input id="menu-text-cb" type="checkbox" /><span>${t('settings.menuText')}</span></label>
   <label class="check"><input id="menu-hotkeys-cb" type="checkbox" /><span>${t('settings.menuHotkeys')}</span></label>
   <label class="check"><input id="menu-hotkeys-hover-cb" type="checkbox" /><span>${t('settings.menuHotkeysHover')}</span></label>
   <div class="hint" id="menu-parts-hint" style="display:none">${t('settings.menuPartsRequired')}</div>
   <div class="set"><span>${t('hotkeys.title')}</span>
     <div class="hint">${t('hotkeys.hint')}</div>
     <table class="hk-table"><tbody id="hk-rows"></tbody></table>
     <div class="toolbar"><button type="button" id="hk-reset">${t('hotkeys.reset')}</button>
       <span id="hk-msg" class="hint"></span></div></div>
   <dialog id="hk-dialog" class="hk-dialog">
     <h3>${t('hotkeys.duplicateTitle')}</h3>
     <p id="hk-dialog-text"></p>
     <p class="hint">${t('hotkeys.duplicate')}</p>
     <div class="hk-dialog-actions"><button type="button" id="hk-dialog-ok">${t('common.ok')}</button></div>
   </dialog>
   <label class="set"><span>${t('settings.pageZoom')}</span>
     <select id="zoommode">
       <option value="origin">${t('settings.zoomOrigin')}</option>
       <option value="tab">${t('settings.zoomTab')}</option>
     </select></label>
   <label class="check"><input id="zoom-sync-cb" type="checkbox" /><span>${t('settings.zoomSync')}</span></label>
   <div class="set"><span>${t('settings.theme')}</span>
     <div class="theme-pick" id="theme-pick">
       <button type="button" data-theme-pick="dark" title="${t('settings.themeDarkTip')}">
         <span class="tp-bar"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr"></span>
         <span class="tp-name">${t('settings.themeDark')}</span>
       </button>
       <button type="button" data-theme-pick="light" title="${t('settings.themeLightTip')}">
         <span class="tp-bar light"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr light"></span>
         <span class="tp-name">${t('settings.themeLight')}</span>
       </button>
       <button type="button" data-theme-pick="system" title="${t('settings.themeSystemTip')}">
         <span class="tp-bar system"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr system"></span>
         <span class="tp-name">${t('settings.themeSystem')}</span>
       </button>
       <button type="button" data-theme-pick="slate" title="${t('settings.themeSlateTip')}">
         <span class="tp-bar slate"><span class="tp-tab on"></span><span class="tp-tab"></span><span class="tp-dot"></span></span>
         <span class="tp-addr slate"></span>
         <span class="tp-name">${t('settings.themeSlate')}</span>
       </button>
     </div>
     <div class="hint">${t('settings.themeHint')}</div></div>
   <label class="set"><span>${t('settings.webContentTheme')}</span>
     <select id="wctheme">
       <option value="follow">${t('settings.webContentFollow')}</option>
       <option value="light">${t('settings.themeLight')}</option>
       <option value="dark">${t('settings.themeDark')}</option>
       <option value="system">${t('settings.themeSystem')}</option>
     </select>
     <div class="hint">${t('settings.webContentHint')}</div></label>
   <label class="set"><span>${t('settings.f11')}</span>
     <select id="fsmode">
       <option value="window">${t('settings.f11Window')}</option>
       <option value="content">${t('settings.f11Content')}</option>
     </select></label>
   <!-- Разрешения сайтов живут на своей странице: список растёт с числом
        посещённых сайтов, и в общем потоке настроек он хоронил бы тему и
        горячие клавиши. Здесь только переход. -->
   <div class="set"><span>${t('permissions.settingsTitle')}</span>
     <div class="hint">${t('permissions.settingsOpenHint')}</div>
     <div class="toolbar"><button type="button" id="open-permissions">${t('permissions.open')}</button></div></div>
   <div class="toolbar"><button id="save">${t('common.save')}</button>
     <span id="ok" class="hint"></span></div>
   <p class="hint">${t('settings.footer')}</p>
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
     const menuIconsCb = document.getElementById('menu-icons-cb');
     const menuTextCb = document.getElementById('menu-text-cb');
     const menuHotkeysCb = document.getElementById('menu-hotkeys-cb');
     const menuHotkeysHoverCb = document.getElementById('menu-hotkeys-hover-cb');
     const menuPartsHint = document.getElementById('menu-parts-hint');
     // Идентифицирующие части пункта, между которыми действует инвариант
     // «хотя бы одна». Хоткей в инвариант НЕ входит: он не идентифицирует
     // пункт, поэтому его можно выключать в любом сочетании.
     const menuPartsBoxes = [menuIconsCb, menuTextCb];
     function menuPartsValid() { return menuPartsBoxes.some((b) => b.checked); }
     // Валидация на месте: последнюю ИДЕНТИФИЦИРУЮЩУЮ часть выключить
     // нельзя. Пункт без иконки и текста неразличим от разделителя, и
     // молча сохранить такое состояние — сломать интерфейс без
     // сообщения. Та же проверка продублирована в main (settingsStore):
     // страница — не единственный вход.
     menuPartsBoxes.forEach((b) =>
       b.addEventListener('change', () => {
         if (menuPartsValid()) { menuPartsHint.style.display = 'none'; return; }
         b.checked = true;
         menuPartsHint.style.display = '';
       }));
     // --- Таблица горячих клавиш ---
     // Действия запечены при сборке страницы, текущие сочетания — из
     // настроек. Захват клавиши: клик по полю и нажатие сочетания;
     // Backspace/Delete снимает сочетание, дубль только предупреждается
     // модальным окном (и красной строкой) — сам не сбрасывается.
     const HK_ACTIONS = ${JSON.stringify(hotkeyRows)};
     const HK_MAC = ${JSON.stringify(process.platform === 'darwin')};
     const hkRowsEl = document.getElementById('hk-rows');
     const hkMsg = document.getElementById('hk-msg');
     const hkDialog = document.getElementById('hk-dialog');
     const hkDialogText = document.getElementById('hk-dialog-text');
     document.getElementById('hk-dialog-ok').addEventListener('click', () => hkDialog.close());
     let hkOverrides = {};
     const hkInputs = {};
     // Захват сочетаний: пока поле таблицы в фокусе, браузерные сочетания
     // молчат — main держит флаг по webContents страницы (см.
     // src/main/hotkeys.ts). Иначе Ctrl+W закрыл бы вкладку настроек прямо
     // в момент ввода, и сочетание не удалось бы набрать.
     //
     // Слушаем focusin/focusout на таблице (события всплывают), а не
     // focus/blur на поле: при переходе по Tab focusout приходит раньше
     // focusin, и пара «выключить — включить» теряла бы захват на середине.
     // Соседнее поле отсекается по relatedTarget.
     function hkSetCapture(on) {
       if (window.konstruktor && window.konstruktor.setHotkeyCapture) {
         window.konstruktor.setHotkeyCapture(on === true);
       }
     }
     hkRowsEl.addEventListener('focusin', (e) => {
       if (e.target.classList.contains('hk-input')) hkSetCapture(true);
     });
     hkRowsEl.addEventListener('focusout', (e) => {
       if (!e.target.classList.contains('hk-input')) return;
       if (hkRowsEl.contains(e.relatedTarget)) return;
       // Модальное предупреждение о дубле — часть того же сеанса ввода:
       // фокус уезжает на кнопку «Ок», и снимать захват на это время не
       // нужно. Состояние после закрытия пересчитывается в close ниже.
       if (hkDialog.open) return;
       hkSetCapture(false);
     });
     hkDialog.addEventListener('close', () => {
       const el = document.activeElement;
       hkSetCapture(el ? el.classList.contains('hk-input') : false);
     });
     // Уход со страницы мимо blur: переход, перезагрузка, закрытие вкладки.
     window.addEventListener('pagehide', () => hkSetCapture(false));
     // Подпись сочетания — тот же вид, что в меню (shared/hotkeys),
     // продублирован: страница — статический HTML без импортов.
     function hkFormat(accel) {
       const parts = accel.split('+').map((p) => p.trim()).filter(Boolean).map((p) => {
         const l = p.toLowerCase();
         if (l === 'cmdorctrl' || l === 'commandorcontrol' || l === 'ctrl' || l === 'control') return HK_MAC ? '⌘' : 'Ctrl';
         if (l === 'shift') return HK_MAC ? '⇧' : 'Shift';
         if (l === 'alt' || l === 'option') return HK_MAC ? '⌥' : 'Alt';
         if (l === 'meta' || l === 'cmd' || l === 'command') return '⌘';
         return p;
       });
       return HK_MAC ? parts.join('') : parts.join('+');
     }
     // Код физической клавиши -> имя для акселератора (обратный разбор).
     function hkKeyName(code) {
       if (!code) return '';
       if (/^Key[A-Z]$/.test(code)) return code.slice(3);
       if (/^Digit[0-9]$/.test(code)) return code.slice(5);
       if (/^F([1-9]|1[0-2])$/.test(code)) return code;
       const map = { Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '\u0060', BracketLeft: '[', BracketRight: ']', Backslash: '\\\\', Space: 'Space' };
       return map[code] || '';
     }
     function hkBuild(e) {
       const parts = [];
       if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl');
       if (e.shiftKey) parts.push('Shift');
       if (e.altKey) parts.push('Alt');
       const name = hkKeyName(e.code);
       if (!name) return '';
       parts.push(name);
       return parts.join('+');
     }
     // Действующее сочетание. Пустая строка = сочетание снято
     // пользователем (Backspace/Delete) и это НЕ дефолт: отличаем по
     // наличию ключа, а не по его значению.
     function hkEff(id) {
       if (Object.prototype.hasOwnProperty.call(hkOverrides, id)) return hkOverrides[id];
       const a = HK_ACTIONS.find((x) => x.id === id);
       return a ? a.def : '';
     }
     function hkLabelOf(id) {
       const a = HK_ACTIONS.find((x) => x.id === id);
       return a ? a.label : id;
     }
     function hkNeedsModifier(accel) {
       const parts = accel.split('+');
       const key = parts[parts.length - 1];
       const hasMod = parts.length > 1;
       return /^[A-Z0-9]$/.test(key) && !hasMod;
     }
     // Дубль считаем по ДЕЙСТВУЮЩИМ значениям: переопределение может
     // совпасть с дефолтом другого действия, а не только с другим
     // переопределением. null — конфликта нет.
     function hkDuplicateOf(id) {
       const v = hkEff(id).trim().toLowerCase();
       if (!v) return null;
       for (const a of HK_ACTIONS) {
         if (a.id !== id && hkEff(a.id).trim().toLowerCase() === v) return a.id;
       }
       return null;
     }
     function hkFirstDuplicate() {
       for (const a of HK_ACTIONS) if (hkDuplicateOf(a.id)) return a.id;
       return null;
     }
     // Модальное предупреждение: значение поля не трогаем — решение за
     // пользователем, а строки-дубли подсвечены красным (см. hkPaint).
     function hkWarnDuplicate(id) {
       const dup = hkDuplicateOf(id);
       if (!dup) return;
       hkDialogText.textContent = tr('hotkeys.duplicateText', {
         key: hkFormat(hkEff(id)),
         action: hkLabelOf(dup)
       });
       if (!hkDialog.open) hkDialog.showModal();
     }
     HK_ACTIONS.forEach((a) => {
       // Имя rowEl, а не tr: локальная переменная tr перекрывала бы
       // хелпер tr() внутри обработчиков (он берётся из замыкания).
       const rowEl = document.createElement('tr');
       const tdLabel = document.createElement('td');
       tdLabel.textContent = a.label;
       const tdKey = document.createElement('td');
       const inp = document.createElement('input');
       inp.type = 'text';
       inp.readOnly = true;
       inp.className = 'hk-input';
       inp.dataset.id = a.id;
       inp.addEventListener('keydown', (e) => {
         if (e.key === 'Escape' || e.key === 'Tab') return;
         e.preventDefault();
         // Backspace/Delete снимает сочетание: поле пустое («не
         // назначено»), клавиша не перехватывается, в меню нет подписи.
         if (e.key === 'Backspace' || e.key === 'Delete') {
           hkOverrides[a.id] = '';
           hkMsg.textContent = '';
           hkPaint();
           return;
         }
         const accel = hkBuild(e);
         if (!accel) return;
         if (hkNeedsModifier(accel)) {
           hkMsg.textContent = tr('hotkeys.needModifier');
           setTimeout(() => (hkMsg.textContent = ''), 2500);
           return;
         }
         hkOverrides[a.id] = accel;
         hkPaint();
         hkMsg.textContent = '';
         hkWarnDuplicate(a.id);
       });
       tdKey.appendChild(inp);
       rowEl.appendChild(tdLabel);
       rowEl.appendChild(tdKey);
       hkRowsEl.appendChild(rowEl);
       hkInputs[a.id] = inp;
     });
     // Перерисовка таблицы: значения полей и подсветка строк. Дубль
     // (одно сочетание у двух действий) — красный, снятое сочетание —
     // оранжевый. Дубль не сбрасывается: подсветка + модальное окно.
     function hkPaint() {
       const seen = {};
       const dup = {};
       for (const a of HK_ACTIONS) {
         const v = hkEff(a.id).trim().toLowerCase();
         if (!v) continue;
         if (seen[v] === undefined) seen[v] = a.id;
         else {
           dup[a.id] = true;
           dup[seen[v]] = true;
         }
       }
       HK_ACTIONS.forEach((a) => {
         const v = hkEff(a.id);
         const inp = hkInputs[a.id];
         inp.value = v ? hkFormat(v) : '';
         inp.placeholder = v ? '' : tr('hotkeys.unbound');
         const rowEl = inp.closest('tr');
         rowEl.classList.toggle('hk-row-dup', dup[a.id] === true);
         rowEl.classList.toggle('hk-row-empty', !v);
       });
     }
     document.getElementById('hk-reset').addEventListener('click', () => {
       hkOverrides = {};
       hkPaint();
       hkMsg.textContent = '';
     });
     const zoomModeSel = document.getElementById('zoommode');
     const zoomSyncCb = document.getElementById('zoom-sync-cb');
     const fsmode = document.getElementById('fsmode');
     const themePick = document.getElementById('theme-pick');
     const wcThemeSel = document.getElementById('wctheme');
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
       locale.value = s.locale || 'auto';
       animCb.checked = s.animations !== false;
       roundedCb.checked = s.roundedCorners === true;
       rememberCb.checked = s.rememberBounds !== false;
       rememberTabsCb.checked = s.rememberTabs !== false;
       menuIconsCb.checked = s.menuShowIcons !== false;
       menuTextCb.checked = s.menuShowText !== false;
       menuHotkeysCb.checked = s.menuShowHotkeys !== false;
       menuHotkeysHoverCb.checked = s.menuHotkeysOnHover === true;
       hkOverrides = {};
       if (s.hotkeys) {
         HK_ACTIONS.forEach((a) => {
           // Пустая строка — тоже состояние (сочетание снято), поэтому
           // проверяем тип, а не истинность значения.
           if (typeof s.hotkeys[a.id] === 'string') hkOverrides[a.id] = s.hotkeys[a.id];
         });
       }
       hkPaint();
       zoomModeSel.value = s.zoomMode === 'tab' ? 'tab' : 'origin';
       zoomSyncCb.checked = s.zoomSync === true;
       fsmode.value = s.fullscreenMode === 'content' ? 'content' : 'window';
       theme = s.theme === 'light' || s.theme === 'system' || s.theme === 'slate' ? s.theme : 'dark';
       paintTheme();
       // Неизвестное значение (битый файл) трактуем как 'follow': так
       // поведение совпадает с дефолтом, а не с произвольной схемой.
       wcThemeSel.value = ['light', 'dark', 'system'].includes(s.webContentTheme)
         ? s.webContentTheme
         : 'follow';
       dnsWrap.style.display = dns.value === 'custom' ? '' : 'none';
     })();
     document.getElementById('save').addEventListener('click', async () => {
       // Страховка формы: до main невалидный набор не уходит. Основной
       // заслон — на change выше, но кнопку могли нажать и после правки
       // разметки/devtools.
       if (!menuPartsValid()) { menuPartsHint.style.display = ''; return; }
       // Дубли сохранение НЕ блокируют: пользователь уже предупреждён
       // модальным окном и красной строкой, решение — за ним.
       const dupId = hkFirstDuplicate();
       if (dupId) hkWarnDuplicate(dupId);
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
         menuShowIcons: menuIconsCb.checked,
         menuShowText: menuTextCb.checked,
         menuShowHotkeys: menuHotkeysCb.checked,
         menuHotkeysOnHover: menuHotkeysHoverCb.checked,
         hotkeys: hkOverrides,
         zoomMode: zoomModeSel.value,
         zoomSync: zoomSyncCb.checked,
         fullscreenMode: fsmode.value,
         theme,
         webContentTheme: wcThemeSel.value
       });
       ok.textContent = savedMsg(dns.value);
       setTimeout(() => (ok.textContent = ''), 3000);
     });
     function savedMsg(dnsMode) {
       return dnsMode && dnsMode !== 'off'
         ? tr('settings.savedDns')
         : tr('settings.saved');
     }
     // Разрешения сайтов живут на отдельной странице (см. permissionsPage):
     // список растёт с числом сайтов и в общем потоке настроек хоронил бы
     // тему и горячие клавиши. Навигация обычная — тот же WebContentsView.
     document.getElementById('open-permissions').addEventListener('click', () => {
       location.href = 'konstruktor://permissions';
     });
   </script>`,
    lang
  )
}
