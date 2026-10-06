// Runtime i18n для скриптов внутренних страниц.
//
// Страницы — обычный HTML внутри WebContentsView без доступа к модулям,
// поэтому в их <script> запекается каталог текущего языка (window.__I18N__),
// Intl-локаль (window.__I18N_INTL__) и мини-хелпер window.tr с
// интерполяцией {{параметр}} и множественным числом через Intl.PluralRules.
// Исходник хелпера один здесь и подставляется в каждую страницу.
import { buildResources } from './index'
import { langTag } from './languages'

function flatten(
  tree: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as Record<string, unknown>, path, out)
    } else if (typeof value === 'string') {
      out[path] = value
    }
  }
  return out
}

// Хелпер — готовый JS для вставки в <script>. String.raw обязателен:
// без него обратные слэши regex'а схлопываются в строковом литерале.
const TR_SOURCE = String.raw`(function () {
  var catalog = window.__I18N__ || {};
  var intl = window.__I18N_INTL__ || 'en';
  var rules = null;
  try { rules = new Intl.PluralRules(intl); } catch (e) { rules = null; }
  window.tr = function (key, params) {
    params = params || {};
    var value = catalog[key];
    if (value === undefined && params.count !== undefined) {
      var category = rules ? rules.select(params.count) : (params.count === 1 ? 'one' : 'other');
      value = catalog[key + '_' + category];
      if (value === undefined) value = catalog[key + '_other'];
    }
    if (value === undefined) return key;
    return value.replace(/\{\{(\w+)\}\}/g, function (_match, name) {
      return params[name] !== undefined ? String(params[name]) : '';
    });
  };
})();`

/**
 * <script>-блок для страницы: каталог языка + хелпер tr().
 *
 * Каталог приходит из ресурсов i18next, то есть уже слитым с en
 * (см. buildResources): непереведённый ключ в ru-странице отдаёт
 * английский текст, а не ключ.
 */
export function pageI18nScript(lang: string): string {
  const resources = buildResources()
  const tree = (resources[lang]?.translation ?? resources['en']?.translation) as
    Record<string, unknown> | undefined
  const flat = flatten(typeof tree === 'object' && tree ? tree : {})
  // `</` экранируется иначе перевод закроет тег <script> досрочно.
  const json = JSON.stringify(flat).replace(/<\//g, '<\\/')
  return (
    `<script>window.__I18N__=${json};` +
    `window.__I18N_INTL__=${JSON.stringify(langTag(lang))};${TR_SOURCE}</script>`
  )
}
