// Страница настроек: все опции браузера + визуальный выбор темы.
// Выделено из internalPages.ts.
//
// Опции языка строятся из реестра LANGUAGES: новый язык = запись
// в реестре + файл каталога, страница при этом не правится.
import { LANGUAGES } from '../../shared/i18n'
import { t } from '../i18n'
import { shell } from './shell'

export function buildSettingsPage(lang: string): string {
  const langOptions = LANGUAGES.map(
    (l) => `\n       <option value="${l.code}">${l.label}</option>`
  ).join('')
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
   <label class="set"><span>${t('settings.f11')}</span>
     <select id="fsmode">
       <option value="window">${t('settings.f11Window')}</option>
       <option value="content">${t('settings.f11Content')}</option>
     </select></label>
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
     const zoomModeSel = document.getElementById('zoommode');
     const zoomSyncCb = document.getElementById('zoom-sync-cb');
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
       locale.value = s.locale || 'auto';
       animCb.checked = s.animations !== false;
       roundedCb.checked = s.roundedCorners === true;
       rememberCb.checked = s.rememberBounds !== false;
       rememberTabsCb.checked = s.rememberTabs !== false;
       zoomModeSel.value = s.zoomMode === 'tab' ? 'tab' : 'origin';
       zoomSyncCb.checked = s.zoomSync === true;
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
         zoomMode: zoomModeSel.value,
         zoomSync: zoomSyncCb.checked,
         fullscreenMode: fsmode.value,
         theme
       });
       ok.textContent = savedMsg(dns.value);
       setTimeout(() => (ok.textContent = ''), 3000);
     });
     function savedMsg(dnsMode) {
       return dnsMode && dnsMode !== 'off'
         ? tr('settings.savedDns')
         : tr('settings.saved');
     }
   </script>`,
    lang
  )
}
