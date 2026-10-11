// Генераторы скриптов совместимости: фоновый, контентный и загрузчик
// service worker'а. Скрипты пишутся В КАТАЛОГ РАСШИРЕНИЯ — иначе
// importScripts не сможет их подтянуть (путь считается от URL расширения).
//
// Почему шим, а не preload: preload в service worker расширения не доходит,
// а мир preload для страниц расширения изолирован от его скриптов (замер
// фазы 0). Поэтому единственный надёжный канал — loopback HTTP + WebSocket,
// а шим живёт в самом расширении и обращается к main через fetch.
//
// Порт и токен стабильны между запусками приложения (см. bridge.ts), но
// файлы всё равно перезаписываются: содержимое шима меняется при правках.
import { createHash } from 'crypto'

export interface ShimConfig {
  port: number
  token: string
}

// Фоновый шим: полифилл отсутствующих chrome.* поверх RPC в main.
export function shimSource(cfg: ShimConfig): string {
  return `// konstruktor compatibility shim. Файл генерируется при загрузке расширения.
;(function () {
  var BASE = 'http://127.0.0.1:${cfg.port}'
  var TOKEN = ${JSON.stringify(cfg.token)}
  var listeners = {}

  function rpc(method, args) {
    return fetch(BASE + '/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, method: method, args: args || [] })
    })
      .then(function (r) { return r.json() })
      .then(function (res) {
        if (!res || res.ok !== true) {
          throw new Error((res && res.error) || 'konstruktor rpc failed: ' + method)
        }
        return res.result
      })
  }

  function on(name, fn) {
    if (typeof fn !== 'function') return
    if (!listeners[name]) listeners[name] = []
    listeners[name].push(fn)
  }
  function off(name, fn) {
    var list = listeners[name] || []
    var i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  function fire(name, args) {
    ;(listeners[name] || []).slice().forEach(function (fn) {
      try { fn.apply(null, args) } catch (e) {}
    })
  }
  function eventOf(name) {
    return {
      addListener: function (fn) { on(name, fn) },
      removeListener: function (fn) { off(name, fn) },
      hasListener: function (fn) { return (listeners[name] || []).indexOf(fn) >= 0 }
    }
  }

  // main -> расширение: события приходят по WebSocket, соединение
  // переподнимается после разрыва (service worker может засыпать).
  function connect() {
    try {
      var ws = new WebSocket(
        BASE.replace('http', 'ws') +
          '/events?token=' +
          encodeURIComponent(TOKEN) +
          '&ext=' +
          encodeURIComponent((chromeObj.runtime && chromeObj.runtime.id) || '')
      )
      ws.onmessage = function (e) {
        try {
          var m = JSON.parse(e.data)
          fire(m.event, m.args || [])
        } catch (err) {}
      }
      ws.onclose = function () { setTimeout(connect, 1000) }
    } catch (e) {
      setTimeout(connect, 1000)
    }
  }
  connect()

  var chromeObj = globalThis.chrome || (globalThis.chrome = {})
  function define(target, name, value) {
    try { target[name] = value } catch (e) {}
  }
  function setLastError(err) {
    try { chromeObj.runtime.lastError = err || undefined } catch (e) {}
  }
  // Chrome принимает и промис, и коллбэк: коллбэк получает undefined
  // и текст ошибки в runtime.lastError.
  function deliver(promise, cb) {
    if (typeof cb !== 'function') return promise
    promise.then(
      function (result) { setLastError(null); cb(result) },
      function (e) {
        setLastError({ message: String((e && e.message) || e) })
        cb(undefined)
      }
    )
    return undefined
  }

  // --- tabs -------------------------------------------------------------
  var tabs = chromeObj.tabs || (chromeObj.tabs = {})
  define(tabs, 'create', function (props, cb) { return deliver(rpc('tabs.create', [props || {}]), cb) })
  define(tabs, 'remove', function (id, cb) { return deliver(rpc('tabs.remove', [id]), cb) })
  define(tabs, 'update', function (id, props, cb) { return deliver(rpc('tabs.update', [id, props || {}]), cb) })
  define(tabs, 'reload', function (id, props, cb) { return deliver(rpc('tabs.reload', [id, props || {}]), cb) })
  // Родной tabs.query возвращает пустой список (у расширения нет понятия
  // активной вкладки — замер фазы 0), поэтому запрос обслуживает main.
  define(tabs, 'query', function (info, cb) { return deliver(rpc('tabs.query', [info || {}]), cb) })
  // Константы-идентификаторы, которых нет в Electron. Без TAB_ID_NONE
  // блокировщики падают: uBlock Origin Lite строит правило DNR
  // с condition.tabIds = [TAB_ID_NONE] (-1), а undefined в tabIds
  // роняет updateSessionRules («expected integer, found undefined»),
  // и режим фильтрации для сайта не применяется.
  if (tabs.TAB_ID_NONE === undefined) define(tabs, 'TAB_ID_NONE', -1)
  if (!tabs.onCreated) define(tabs, 'onCreated', eventOf('tabs.onCreated'))
  define(tabs, 'onUpdated', eventOf('tabs.onUpdated'))
  define(tabs, 'onActivated', eventOf('tabs.onActivated'))
  define(tabs, 'onRemoved', eventOf('tabs.onRemoved'))

  // --- windows ----------------------------------------------------------
  var windows = chromeObj.windows || (chromeObj.windows = {})
  define(windows, 'create', function (props, cb) { return deliver(rpc('windows.create', [props || {}]), cb) })
  define(windows, 'getCurrent', function (cb) { return deliver(rpc('windows.getCurrent', []), cb) })
  define(windows, 'getAll', function (cb) { return deliver(rpc('windows.getAll', []), cb) })
  define(windows, 'update', function (id, props, cb) { return deliver(rpc('windows.update', [id, props || {}]), cb) })
  define(windows, 'remove', function (id, cb) { return deliver(rpc('windows.remove', [id]), cb) })
  define(windows, 'onCreated', eventOf('windows.onCreated'))
  define(windows, 'onRemoved', eventOf('windows.onRemoved'))
  define(windows, 'onFocusChanged', eventOf('windows.onFocusChanged'))
  if (windows.WINDOW_ID_NONE === undefined) define(windows, 'WINDOW_ID_NONE', -1)

  // --- action (browser_action) ------------------------------------------
  var action = chromeObj.action || chromeObj.browserAction || {}
  define(action, 'setBadgeText', function (o, cb) { return deliver(rpc('action.setBadgeText', [o || {}]), cb) })
  define(action, 'setBadgeBackgroundColor', function (o, cb) {
    return deliver(rpc('action.setBadgeBackgroundColor', [o || {}]), cb)
  })
  define(action, 'setTitle', function (o, cb) { return deliver(rpc('action.setTitle', [o || {}]), cb) })
  define(action, 'setIcon', function (o, cb) { return deliver(rpc('action.setIcon', [o || {}]), cb) })
  define(action, 'setPopup', function (o, cb) { return deliver(rpc('action.setPopup', [o || {}]), cb) })
  define(action, 'onClicked', eventOf('action.onClicked'))
  define(chromeObj, 'action', action)
  define(chromeObj, 'browserAction', action)

  // --- contextMenus -----------------------------------------------------
  var menus = chromeObj.contextMenus || (chromeObj.contextMenus = {})
  define(menus, 'create', function (props, cb) {
    var id = (props && props.id) || ''
    return deliver(rpc('contextMenus.create', [props || {}]), cb || function () { return id })
  })
  define(menus, 'update', function (id, props, cb) { return deliver(rpc('contextMenus.update', [id, props || {}]), cb) })
  define(menus, 'remove', function (id, cb) { return deliver(rpc('contextMenus.remove', [id]), cb) })
  define(menus, 'removeAll', function (cb) { return deliver(rpc('contextMenus.removeAll', []), cb) })
  define(menus, 'onClicked', eventOf('contextMenus.onClicked'))

  // --- notifications ----------------------------------------------------
  var notes = chromeObj.notifications || (chromeObj.notifications = {})
  define(notes, 'create', function (id, options, cb) {
    if (typeof options === 'function') { cb = options; options = id; id = '' }
    return deliver(rpc('notifications.create', [id || '', options || {}]), cb)
  })
  define(notes, 'clear', function (id, cb) { return deliver(rpc('notifications.clear', [id]), cb) })
  define(notes, 'getAll', function (cb) { return deliver(rpc('notifications.getAll', []), cb) })
  define(notes, 'onClicked', eventOf('notifications.onClicked'))
  define(notes, 'onClosed', eventOf('notifications.onClosed'))

  // --- alarms -----------------------------------------------------------
  var alarms = chromeObj.alarms || (chromeObj.alarms = {})
  define(alarms, 'create', function (name, info) {
    if (typeof name === 'object') { info = name; name = '' }
    return rpc('alarms.create', [name || '', info || {}])
  })
  define(alarms, 'clear', function (name, cb) { return deliver(rpc('alarms.clear', [name || '']), cb) })
  define(alarms, 'clearAll', function (cb) { return deliver(rpc('alarms.clearAll', []), cb) })
  define(alarms, 'getAll', function (cb) { return deliver(rpc('alarms.getAll', []), cb) })
  define(alarms, 'onAlarm', eventOf('alarms.onAlarm'))

  // --- commands ---------------------------------------------------------
  // Сочетания перехватывает браузер (Chromium в Electron не обслуживает
  // команды расширений) и присылает сюда событие onCommand.
  var commands = chromeObj.commands || (chromeObj.commands = {})
  define(commands, 'getAll', function (cb) { return deliver(rpc('commands.getAll', []), cb) })
  define(commands, 'onCommand', eventOf('commands.onCommand'))

  // --- i18n -------------------------------------------------------------
  // getMessage — СИНХРОННЫЙ в Chrome, и в Electron он уже родной: замер
  // в воркере даёт getMessage = function, вызов возвращает строку, а не
  // промис. Мост же асинхронен: если им перекрыть родной метод, любое
  // расширение, склеивающее строки из getMessage (обычная практика),
  // получает Promise и печатает «[object Promise]» — так ломался попап
  // Tampermonkey (метки меню и подсказка приходили объектами, и рендер
  // подсказки падал на e.replace is not a function). Поэтому родной
  // метод не трогаем вообще; RPC-вариант — только когда родного нет.
  if (!chromeObj.i18n) {
    define(chromeObj, 'i18n', {})
  }
  if (typeof chromeObj.i18n.getMessage !== 'function') {
    define(chromeObj.i18n, 'getMessage', function (key, subs) {
      return rpc('i18n.getMessage', [key, subs || []]).catch(function () { return '' })
    })
  }

  // --- userScripts ------------------------------------------------------
  // Chromium в Electron не отдаёт chrome.userScripts (замер: undefined во
  // всех service worker'ах), но этот API — единственный штатный путь
  // пользовательских скриптов: на нём стоит Tampermonkey, без него он
  // показывает «Allow User Scripts» и не инжектит ничего.
  //
  // Достраиваем его поверх chrome.scripting, который в Electron работает
  // фактически (проверено: зарегистрированный файл исполнился в странице,
  // MAIN-мир даёт window для страницы, изолированный — нет).
  //
  // Разница API: userScripts принимает ТЕКСТ (js: [{code}]), а scripting —
  // ПУТИ к файлам в каталоге расширения. Поэтому код сначала сохраняется
  // файлом: у шима доступа к файловой системе нет (это код расширения),
  // запись делает main по RPC.
  //
  // Мир отображается так: USER_SCRIPT (мир пользовательских скриптов Chrome)
  // -> изолированный мир, MAIN -> MAIN. Полного соответствия USER_SCRIPT
  // достичь нельзя: у него свои правила доступа к странице и свой sandbox.
  var usPermission = false
  try {
    var usMf = chromeObj.runtime && chromeObj.runtime.getManifest && chromeObj.runtime.getManifest()
    var usPerms = (usMf && usMf.permissions) || []
    usPermission = usPerms.indexOf('userScripts') >= 0
  } catch (e) {}
  if (usPermission && chromeObj.scripting && chromeObj.scripting.registerContentScripts) {
    var usPrefix = 'konstruktor-us-'
    var usSafe = function (s) {
      return String(s).replace(/[^A-Za-z0-9_-]/g, '_')
    }
    // Скрипт -> список файлов: код каждого блока сохраняем отдельным файлом,
    // затем регистрируем по путям (scripting других форм не принимает).
    var writeFiles = function (script) {
      var blocks = (script && script.js) || []
      var files = []
      var jobs = []
      for (var bi = 0; bi < blocks.length; bi++) {
        var b = blocks[bi] || {}
        if (typeof b.file === 'string' && b.file) {
          files.push(b.file)
          continue
        }
        var name = usPrefix + usSafe(script.id) + '-' + bi + '.js'
        files.push(name)
        jobs.push(rpc('shim.writeUserScriptFile', [name, String(b.code || '')]))
      }
      return Promise.all(jobs).then(function () {
        return files
      })
    }
    var toRegistered = function (script, files) {
      var world = script.world === 'MAIN' ? 'MAIN' : 'ISOLATED'
      var out = {
        id: String(script.id),
        matches: script.matches || [],
        js: files,
        runAt: script.runAt || 'document_idle',
        allFrames: script.allFrames === true,
        world: world
      }
      if (script.excludeMatches) out.excludeMatches = script.excludeMatches
      if (script.includeGlobs) out.includeGlobs = script.includeGlobs
      if (script.excludeGlobs) out.excludeGlobs = script.excludeGlobs
      return out
    }
    // Повторная регистрация того же id — не ошибка: расширение (например
    // Tampermonkey) зовёт register на каждом старте воркера, а Chromium на
    // занятый id отвечает ошибкой. Поэтому прежняя запись снимается перед
    // новой — вызов становится идемпотентным.
    var registerOne = function (script) {
      return writeFiles(script).then(function (files) {
        var reg = toRegistered(script, files)
        return chromeObj.scripting
          .unregisterContentScripts({ ids: [reg.id] })
          .catch(function () {
            return undefined
          })
          .then(function () {
            return chromeObj.scripting.registerContentScripts([reg])
          })
          .then(function () {
            return undefined
          })
      })
    }
    var userScripts = {
      register: function (scripts) {
        var list = scripts || []
        var chain = Promise.resolve()
        for (var i = 0; i < list.length; i++) {
          chain = chain.then(registerOne.bind(null, list[i]))
        }
        return chain
      },
      unregister: function (filter) {
        var ids = (filter && filter.ids) || null
        if (!ids) {
          return chromeObj.scripting.unregisterContentScripts()
        }
        return chromeObj.scripting.unregisterContentScripts({ ids: ids })
      },
      update: function (scripts) {
        return userScripts.register(scripts || [])
      },
      getScripts: function (filter) {
        var ids = (filter && filter.ids) || null
        return chromeObj.scripting.getRegisteredContentScripts().then(function (list) {
          var out = []
          for (var i = 0; i < (list || []).length; i++) {
            var r = list[i]
            if (r.id.indexOf(usPrefix) === 0) continue
            if (ids && ids.indexOf(r.id) < 0) continue
            out.push({
              id: r.id,
              matches: r.matches || [],
              excludeMatches: r.excludeMatches,
              includeGlobs: r.includeGlobs,
              excludeGlobs: r.excludeGlobs,
              js: (r.js || []).map(function (f) {
                return { file: f }
              }),
              runAt: r.runAt,
              allFrames: r.allFrames === true,
              world: r.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT'
            })
          }
          return out
        })
      },
      // Мир пользовательских скриптов (CSP-послабления и messaging)
      // воспроизвести нельзя — запоминаем настройку и не мешаем вызову.
      configureWorld: function () {
        return Promise.resolve()
      },
      onBeforeScript: eventOf('userScripts.onBeforeScript')
    }
    define(chromeObj, 'userScripts', userScripts)
  }

  // --- permissions ------------------------------------------------------
  // Chromium в Electron не отдаёт chrome.permissions (замер пробником),
  // а расширения обращаются к нему на старте фона: uBlock Origin Lite
  // падал на browser.permissions.onRemoved. Модель разрешений в
  // конструкторе простая: всё, что объявлено в манифесте, уже выдано.
  // Поэтому contains отвечает по объявленному, request/remove — успех,
  // а события существуют, но не срабатывают.
  var perms = chromeObj.permissions || (chromeObj.permissions = {})
  var declaredApis = []
  var declaredOrigins = []
  // Регулярных выражений здесь нет намеренно: шим — это строка-шаблон,
  // и обратный слэш в ней съедается (проверено: /^(\\*|https?)/
  // превращалось в /^(*|https?)/ и воркер не регистрировался).
  function isOriginPattern(item) {
    return (
      item === '<all_urls>' ||
      item.indexOf('://') > 0 ||
      item.indexOf('*') === 0 ||
      item.indexOf('file:') === 0 ||
      item.indexOf('ftp') === 0
    )
  }
  try {
    var mf = chromeObj.runtime && chromeObj.runtime.getManifest && chromeObj.runtime.getManifest()
    var declared = ((mf && mf.permissions) || []).concat((mf && mf.host_permissions) || [])
    for (var di = 0; di < declared.length; di++) {
      var item = String(declared[di])
      if (isOriginPattern(item)) declaredOrigins.push(item)
      else declaredApis.push(item)
    }
  } catch (e) {}
  define(perms, 'getAll', function (cb) {
    return deliver(Promise.resolve({ permissions: declaredApis, origins: declaredOrigins }), cb)
  })
  define(perms, 'contains', function (p, cb) {
    var want = ((p && p.permissions) || []).concat((p && p.origins) || [])
    var missing = want.filter(function (x) {
      return declaredApis.indexOf(x) < 0 && declaredOrigins.indexOf(x) < 0
    })
    return deliver(Promise.resolve(missing.length === 0), cb)
  })
  define(perms, 'request', function (p, cb) {
    return deliver(Promise.resolve(true), cb)
  })
  define(perms, 'remove', function (p, cb) {
    return deliver(Promise.resolve(true), cb)
  })
  define(perms, 'onAdded', eventOf('permissions.onAdded'))
  define(perms, 'onRemoved', eventOf('permissions.onRemoved'))

  // --- downloads --------------------------------------------------------
  var downloads = chromeObj.downloads || (chromeObj.downloads = {})
  define(downloads, 'download', function (options, cb) {
    return deliver(rpc('downloads.download', [options || {}]), cb)
  })

  // --- storage.sync -> storage.local ------------------------------------
  // Chromium в Electron не даёт storage.sync; данные хранятся локально,
  // о чём расширение узнаёт из предупреждений на странице расширений.
  try {
    if (chromeObj.storage && !chromeObj.storage.sync && chromeObj.storage.local) {
      chromeObj.storage.sync = chromeObj.storage.local
    }
  } catch (e) {}

  // --- extension --------------------------------------------------------
  var extension = chromeObj.extension || (chromeObj.extension = {})
  if (!extension.getURL && chromeObj.runtime && chromeObj.runtime.getURL) {
    define(extension, 'getURL', function (path) { return chromeObj.runtime.getURL(path) })
  }

  // --- собственная экосистема: konstruktor.* ----------------------------
  // Собственные расширения получают возможности браузера напрямую,
  // а не через урезанный chrome.*. Права проверяет main по секции
  // capabilities манифеста.
  var native = globalThis.konstruktor || (globalThis.konstruktor = {})
  function nmethod(name) {
    return function () {
      return rpc('konstruktor.' + name, Array.prototype.slice.call(arguments))
    }
  }
  native.version = 1
  native.settings = { get: nmethod('settings.get'), patch: nmethod('settings.patch') }
  native.tabs = { list: nmethod('tabs.list'), open: nmethod('tabs.open') }
  native.history = { query: nmethod('history.query') }
  native.downloads = { list: nmethod('downloads.list') }
  native.storage = {
    get: nmethod('storage.get'),
    set: nmethod('storage.set'),
    remove: nmethod('storage.remove')
  }
  native.notify = nmethod('notify')
  native.openExternal = nmethod('openExternal')

  // Псевдоним: Chromium отдаёт расширениям и chrome, и browser (замер
  // пробником), но населён он частично — обращение к browser.runtime
  // падает (uBlock Origin Lite падал в js/ext.js на browser.runtime.getURL).
  // Дополняем browser недостающими членами chrome.
  if (globalThis.browser && globalThis.browser !== chromeObj) {
    for (var bk in chromeObj) {
      if (Object.prototype.hasOwnProperty.call(chromeObj, bk) || chromeObj[bk]) {
        if (!globalThis.browser[bk]) {
          try {
            globalThis.browser[bk] = chromeObj[bk]
          } catch (e) {}
        }
      }
    }
    // browser.tabs/windows в Electron свои и уже существуют, поэтому цикл
    // выше их не перезаписывает — константы-идентификаторы доставляем явно.
    try {
      if (globalThis.browser.tabs && globalThis.browser.tabs.TAB_ID_NONE === undefined) {
        globalThis.browser.tabs.TAB_ID_NONE = -1
      }
      if (globalThis.browser.windows && globalThis.browser.windows.WINDOW_ID_NONE === undefined) {
        globalThis.browser.windows.WINDOW_ID_NONE = -1
      }
    } catch (e) {}
  }

  globalThis.__konstruktorShim = { rpc: rpc, emit: fire, version: 1 }
})()
`
}

// Контентный шим: у контент-скрипта родные runtime и storage уже есть,
// достраиваем только давние алиасы.
export function contentShimSource(): string {
  return `// konstruktor content-script shim. Файл генерируется при установке.
;(function () {
  var c = globalThis.chrome
  // Пространство browser в контент-скрипте тоже надо достроить: часть
  // расширений обращается к browser.runtime, а он не населён (см. sw.js).
  if (c && globalThis.browser && globalThis.browser !== c) {
    for (var k in c) {
      if (!globalThis.browser[k]) {
        try {
          globalThis.browser[k] = c[k]
        } catch (e) {}
      }
    }
  }
  if (!c) return
  var extension = c.extension || (c.extension = {})
  if (!extension.getURL && c.runtime && c.runtime.getURL) {
    extension.getURL = function (path) { return c.runtime.getURL(path) }
  }
  if (!extension.getBackgroundPage) {
    extension.getBackgroundPage = function () {
      console.warn('konstruktor: getBackgroundPage недоступен, используйте runtime.sendMessage')
      return null
    }
  }
  if (!c.tabs) c.tabs = {}
  // Константа-идентификатор, которой нет в Electron (см. фоновый шим).
  if (c.tabs.TAB_ID_NONE === undefined) c.tabs.TAB_ID_NONE = -1
  if (!c.tabs.executeScript) {
    c.tabs.executeScript = function () {
      throw new Error('konstruktor: tabs.executeScript недоступен в контент-скрипте, вызывайте chrome.scripting из фона')
    }
  }
})()
`
}

// Загрузчик service worker'а.
//
// Классический фон: шим вшит прямо в загрузчик, скрипты расширения
// подтягиваются importScripts.
//
// Почему шим вшит, а не importScripts отдельного файла: Chromium кэширует
// РЕЗУЛЬТАТ importScripts вместе с версией скрипта, и при неизменном тексте
// загрузчика воркер может продолжать исполнять прошлую версию шима —
// с прежним адресом моста или со ссылкой на удалённый файл.
//
// Модульный фон (background.type === 'module'): шим идёт отдельным модулем,
// подключаемым СТАТИЧЕСКИМ import'ом, потому что динамический import()
// в service worker запрещён спецификацией HTML и падает с
// «import() is disallowed on ServiceWorkerGlobalScope». Порядок гарантирован:
// статические импорты вычисляются в порядке перечисления, поэтому шим
// успевает объявить chrome.* до тела скриптов расширения.
// От устаревшего шима защищает отпечаток в ИМЕНИ файла (как у загрузчика).
export function swBootSource(
  shim: string,
  scripts: string[],
  isModule: boolean,
  sourceStamp = ''
): string {
  const header =
    '// konstruktor service worker boot. Файл генерируется при загрузке расширения.\n' +
    '// shim: ' +
    shimFingerprint(shim) +
    '\n// files: ' +
    (sourceStamp || 'none') +
    '\n'
  const list = scripts.map((s) => JSON.stringify(s.replace(/\\/g, '/')))
  if (isModule) {
    // Путь со слэша — уже абсолютный от корня расширения: './' + '/js/a.js'
    // дал бы './/js/a.js' в трейсах ошибок.
    const imports = [
      `import './${swShimFileName(shim)}'`,
      ...list.map((s) => {
        const rel = JSON.parse(s) as string
        return `import '${rel.startsWith('/') ? rel : './' + rel}'`
      })
    ]
    return header + imports.join('\n') + '\n'
  }
  return header + shim + `\nimportScripts(${list.join(', ')})\n`
}

// Имя файла шима для модульного фона (см. swBootSource).
export function swShimFileName(shim: string): string {
  return 'konstruktor-sw-shim-' + shimFingerprint(shim) + '.js'
}

// Имя файла загрузчика меняется вместе с шимом и с файлами расширения.
//
// Почему имя, а не только содержимое: Chromium хранит регистрацию
// service worker'а расширения в партиции и при том же URL скрипта
// может продолжать исполнять СТАРУЮ его версию из своего кэша вместе
// с картой подключённых модулей. Практика показала это дважды: после
// удаления отдельного shim-файла воркер продолжал обращаться к
// `konstruktor-shim.js`, а после правки `sw.js` расширения продолжал
// исполнять его прошлую версию (замер пробником: новый код фона
// запускался только после смены имени загрузчика).
// Другой URL -> Chromium обязан поставить новую версию воркера.
export function swBootFileName(shim: string, sourceStamp = ''): string {
  return 'konstruktor-sw-boot-' + shimFingerprint(shim + '\n' + sourceStamp) + '.js'
}

// Отпечаток шима: меняет и имя файла, и текст загрузчика при любой правке.
function shimFingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}
