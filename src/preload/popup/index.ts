// Preload окна попапа расширения (chrome-extension://<id>/popup.html).
//
// Патчит три вещи, без которых попапы блокировщиков в Electron не работают.
//
// 1. tabs.query. Расширения на старте попапа зовут
//    `tabs.query({ active: true, currentWindow: true })`, чтобы узнать вкладку
//    пользователя. В Electron попап — отдельное окно, поэтому «текущим окном»
//    оказывается сам попап: его вкладка это он же (chrome-extension://…), и
//    расширение не находит страницу. uBlock Origin Lite на этом рисует
//    «not a website» вместо обычной панели. Подменяем ответ на вкладку,
//    из-под значка которой попап открыт.
//
// 2. Первое sendMessage. У только что загруженной страницы попапа оно не
//    доставляется: промис не разрешается никогда (фоновый service worker
//    ещё поднимается), тогда как тот же вызов через ~300 мс проходит.
//    uBlock на этом навсегда залипает в состоянии loading. Поэтому первое
//    сообщение пропускаем через прогрев: безобидный пинг с `:` в what
//    (uBlock такие игнорирует), затем таймаут-страховка.
//
// 3. permissions. Chromium в Electron не отдаёт chrome.permissions ни в фоне,
//    ни на страницах расширения. uBlock Origin Lite просит разрешение на хост,
//    когда пользователь поднимает ползунок фильтрации выше «базового» уровня;
//    без API запрос молча не выполняется, и расширение откатывает ползунок
//    в исходное положение. Достраиваем API по модели шима фона (объявленное
//    в манифесте считается выданным, request — успех).
//
// 4. window.close. Расширение может закрыть попап сразу после отправки
//    запроса (MetaMask открывает онбординг вкладкой через tabs.create и в том
//    же тике зовёт window.close). Запросы идут по loopback-мосту асинхронно,
//    и закрытие уносит их вместе со страницей: вкладка не открывается, попап
//    исчезает (замер: RPC tabs.create в лог main не попадал вовсе). Поэтому
//    закрытие из страницы идёт через main: он гасит окно и уничтожает его
//    с задержкой, за которую висящие запросы успевают дойти.
//
// Мир preload изолирован от скриптов страницы, поэтому патч ставим в
// основной мир страницы через webFrame.executeJavaScript — он выполняется
// ДО модулей страницы.
//
// Вкладку забираем синхронным IPC: additionalArguments до preload'а не
// доходят (проверено — в process.argv их нет), а обычный ipcRenderer.send
// асинхронен и опоздал бы к моменту старта модулей страницы.
import { contextBridge, ipcRenderer, webFrame } from 'electron'

interface PopupTab {
  id: number
  url: string
  title: string
  audible?: boolean
}

let tab: PopupTab | null = null
try {
  tab = ipcRenderer.sendSync('popup:tab-info') as PopupTab | null
} catch {
  // Нет данных вкладки — попап покажется без подмены tabs.query.
}

// Мост в мир страницы: закрытие окна и RPC в main.
// Мир preload изолирован от скриптов страницы, поэтому всё, что нужно
// странице от main, отдаётся через contextBridge (мост виден и инжектируемому
// в основной мир патчу, и скриптам страницы).
contextBridge.exposeInMainWorld('__konstruktorPopup', {
  close: (): void => {
    ipcRenderer.send('popup:close-request')
  },
  rpc: (method: string, args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke('popup:rpc', method, args)
})

// Патч основного мира. Оборачиваем tabs.query и runtime.sendMessage у обоих
// псевдонимов API (chrome и browser): расширения пользуются то одним, то
// другим. Синтетический Tab повторяет форму, которую отдаёт Chromium, —
// иначе код расширения падает на отсутствующем поле.
//
// Здесь же достраиваются две вещи, которых на странице расширения нет.
//
// 1. permissions. Chromium в Electron не отдаёт chrome.permissions ни в фоне,
//    ни на страницах расширения. uBlock Origin Lite просит разрешение на хост,
//    когда пользователь поднимает ползунок фильтрации выше «базового» уровня;
//    без API запрос молча не выполняется, и расширение откатывает ползунок
//    в исходное положение. Модель та же, что и в шиме фона (объявленное
//    в манифесте считается выданным, request — успех).
//
// 2. tabs.create/update/remove/reload и windows.*. На страницах расширения
//    Electron отдаёт урезанный API: tabs.query есть, а этих методов нет
//    (замер 2026-10-11). MetaMask открывает таким вызовом онбординг
//    вкладкой — вызов падал, и попап просто закрывался. Методы обслуживает
//    main через тот же мост, что и фоновый шим; если метод уже есть,
//    он не трогается.
const patch = `(() => {
  const tab = ${JSON.stringify(tab)};
  const bridge = globalThis.__konstruktorPopup;

  // Закрытие из страницы. Обычный window.close уничтожает страницу сразу
  // и уносит ещё не дошедшие до main запросы — просим main закрыть окно
  // с задержкой. Без моста (не должен, но вдруг) оставляем нативное закрытие.
  try {
    if (bridge && typeof bridge.close === 'function') {
      globalThis.close = function () { bridge.close(); };
    }
  } catch {}

  // Недостающие методы chrome.tabs/windows — поверх RPC в main.
  // Почему в основном мире: мир preload изолирован, его подмены до скриптов
  // страницы не доходят (проверено).
  const rpcCall = (method, args, cb) => {
    if (!bridge || typeof bridge.rpc !== 'function') {
      return Promise.reject(new Error('konstruktor popup bridge is unavailable'));
    }
    const p = bridge.rpc(method, args);
    if (typeof cb !== 'function') return p;
    p.then((r) => cb(r), () => cb(undefined));
    return undefined;
  };
  const fill = (api, name, method) => {
    if (!api || typeof api[name] === 'function') return;
    try {
      api[name] = function (...a) {
        const cb = typeof a[a.length - 1] === 'function' ? a.pop() : undefined;
        return rpcCall(method, a, cb);
      };
    } catch {}
  };
  const installApi = (api) => {
    if (!api) return;
    try {
      if (!api.tabs) api.tabs = {};
    } catch { return; }
    fill(api.tabs, 'create', 'tabs.create');
    fill(api.tabs, 'remove', 'tabs.remove');
    fill(api.tabs, 'update', 'tabs.update');
    fill(api.tabs, 'reload', 'tabs.reload');
    fill(api.tabs, 'query', 'tabs.query');
    try {
      if (api.tabs.TAB_ID_NONE === undefined) api.tabs.TAB_ID_NONE = -1;
    } catch {}
    try {
      if (!api.windows) api.windows = {};
    } catch { return; }
    fill(api.windows, 'create', 'windows.create');
    fill(api.windows, 'update', 'windows.update');
    fill(api.windows, 'remove', 'windows.remove');
    fill(api.windows, 'getCurrent', 'windows.getCurrent');
    fill(api.windows, 'getAll', 'windows.getAll');
    try {
      if (api.windows.WINDOW_ID_NONE === undefined) api.windows.WINDOW_ID_NONE = -1;
    } catch {}
  };
  installApi(globalThis.chrome);
  installApi(globalThis.browser);

  const makeEvent = () => ({
    addListener() {},
    removeListener() {},
    hasListener() { return false; }
  });
  const addPermissions = (api) => {
    if (!api) return;
    if (api.permissions && typeof api.permissions.request === 'function') return;
    const declaredApis = [];
    const declaredOrigins = [];
    try {
      const mf = api.runtime && typeof api.runtime.getManifest === 'function'
        ? api.runtime.getManifest()
        : null;
      const list = ((mf && mf.permissions) || []).concat((mf && mf.host_permissions) || []);
      for (let i = 0; i < list.length; i++) {
        const s = String(list[i]);
        if (s === '<all_urls>' || s.indexOf('://') > 0 || s.indexOf('*') === 0 || s.indexOf('file:') === 0) declaredOrigins.push(s);
        else declaredApis.push(s);
      }
    } catch {}
    const describe = { permissions: declaredApis, origins: declaredOrigins };
    const permissions = {
      getAll: (cb) => {
        const r = Promise.resolve(describe);
        if (typeof cb === 'function') { r.then(cb); return; }
        return r;
      },
      contains: (p, cb) => {
        const want = ((p && p.permissions) || []).concat((p && p.origins) || []);
        let ok = true;
        for (let i = 0; i < want.length; i++) {
          if (declaredApis.indexOf(want[i]) < 0 && declaredOrigins.indexOf(want[i]) < 0) { ok = false; break; }
        }
        const r = Promise.resolve(ok);
        if (typeof cb === 'function') { r.then(cb); return; }
        return r;
      },
      request: (p, cb) => {
        const r = Promise.resolve(true);
        if (typeof cb === 'function') { r.then(cb); return; }
        return r;
      },
      remove: (p, cb) => {
        const r = Promise.resolve(true);
        if (typeof cb === 'function') { r.then(cb); return; }
        return r;
      },
      onAdded: makeEvent(),
      onRemoved: makeEvent()
    };
    try { api.permissions = permissions; } catch {}
    if (!api.permissions || typeof api.permissions.request !== 'function') {
      try {
        Object.defineProperty(api, 'permissions', {
          value: permissions, configurable: true, writable: true
        });
      } catch {}
    }
  };
  addPermissions(globalThis.chrome);
  addPermissions(globalThis.browser);
  if (!tab) return;
  const makeTab = () => ({
    id: tab.id,
    index: 0,
    windowId: 0,
    active: true,
    highlighted: true,
    selected: true,
    pinned: false,
    incognito: false,
    eager: true,
    // Звучит ли вкладка — важное поле: по нему расширения решают, есть ли
    // вообще что слушать (AHA Music ищет музыку только у звучащей вкладки).
    // Раньше здесь стояло жёсткое false, и такие расширения отказывались
    // работать, не дойдя до сути.
    audible: tab.audible === true,
    discarded: false,
    frozen: false,
    autoDiscardable: false,
    mutedInfo: { muted: false },
    groupId: -1,
    title: tab.title,
    url: tab.url
  });
  let ready = null;
  const warmUp = (send) => {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        const p = send({ what: 'konstruktor:popup-warmup' });
        if (p && typeof p.then === 'function') p.then(finish, finish);
        else finish();
      } catch { finish(); }
      setTimeout(finish, 350);
    });
    return ready;
  };
  const wrap = (api) => {
    if (!api || !api.tabs || typeof api.tabs.query !== 'function') return;
    if (api.tabs.__kPopupPatched === true) return;
    const origQuery = api.tabs.query.bind(api.tabs);
    // Chrome допускает ОБЕ формы: с колбэком и без (промис). Колбэк терять
    // нельзя — расширение, вызвавшее query(info, cb), иначе не получит ответ
    // НИКОГДА: промис оно не смотрит, а колбэк не вызывается. Именно на этом
    // зависало определение музыки в AHA Music («слушает» бесконечно).
    api.tabs.query = function (q, cb) {
      if (q && q.active === true && (q.currentWindow === true || q.lastFocusedWindow === true)) {
        const list = [makeTab()];
        if (typeof cb === 'function') {
          cb(list);
          return undefined;
        }
        return Promise.resolve(list);
      }
      return origQuery(q, cb);
    };
    if (api.runtime && typeof api.runtime.sendMessage === 'function' && api.runtime.__kPopupMsgPatched !== true) {
      const origSend = api.runtime.sendMessage.bind(api.runtime);
      api.runtime.sendMessage = (...args) => warmUp(origSend).then(() => origSend(...args));
      try { api.runtime.__kPopupMsgPatched = true; } catch {}
    }
    try { api.tabs.__kPopupPatched = true; } catch {}
  };
  wrap(globalThis.chrome);
  wrap(globalThis.browser);
})();`

void webFrame.executeJavaScript(patch).catch(() => undefined)