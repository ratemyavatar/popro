/* ===== RoPro -> Rokori compatibility runtime =====
 * Emulates the Chrome extension environment RoPro expects, inside Tampermonkey:
 *  - isolated "worlds" (content scripts / background) via a proxy global
 *  - chrome.runtime / storage / alarms / tabs / notifications shims on GM_* APIs
 *  - roblox.com -> www.rokori.com URL rewriting; RoPro's own servers are blocked
 * Data placeholders (double-underscore names) are filled in by build.js.
 */
var realWin = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
var LOG = function () { try { console.debug.apply(console, ['[RoPro→Rokori]'].concat([].slice.call(arguments))); } catch (e) {} };

var MANIFEST = __MANIFEST__;
var API_BASE = __API_BASE__;   // your RoPro-compatible API server
var ASSETS = __ASSETS__;       // path -> data: URI (images, fonts)
var TEXT = __TEXT__;           // path -> text (locales json, _locales messages)
var CSS = __CSS__;             // path -> css text (urls already inlined)
var PAGE_SRC = __PAGE_SRC__;   // path -> page-world js source (web_accessible_resources)
var GROUPS = __GROUPS__;       // [{patterns:[regex src], run_at, js:[], css:[]}]
var OPTIONS = __OPTIONS__;     // {html, css:[], js:[]}
var OPTIONS_PATH = '/ropro/settings';
/* rokori 302s unknown paths (/sandbox, /themes, ...) to /request-error?code=404 on the server.
 * RoPro's own pages are therefore hosted on that error page, with the real route in the fragment
 * (never sent to the server):  /request-error?code=404#ropro=/sandbox  */
var HOST_PAGE = '/request-error?code=404';
var VIRTUAL_RE = /^(\/[a-z]{2}(?:-[a-z]{2})?)?\/(sandbox|themes|ropro\/settings)\/?$/i;
function isVirtualPath(p) { return VIRTUAL_RE.test(p); }
function hostUrlFor(pathAndRest) { return HOST_PAGE + '#ropro=' + encodeURIComponent(pathAndRest); }
function resolveVirtual() {
  var loc = realWin.location, m = loc.hash.match(/^#ropro=(.+)$/);
  if (m) return decodeURIComponent(m[1]);
  if (loc.pathname === '/request-error') { // a refresh of a virtual page lands here without the fragment
    try { var v = JSON.parse(realWin.sessionStorage.getItem('ropro.virtual') || 'null');
      if (v && Date.now() - v.t < 8000) return v.path; } catch (e) {}
  }
  return null;
}
function installVirtualNav() {
  function target(href) {
    try { var u = new URL(href, realWin.location.href);
      if (u.origin === realWin.location.origin && isVirtualPath(u.pathname)) return u.pathname + u.search + u.hash.replace(/^#ropro=.*/, '');
    } catch (e) {} return null;
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]'); if (!a) return;
    var t = target(a.href); if (!t) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.ctrlKey || e.metaKey || a.target === '_blank') realWin.open(hostUrlFor(t), '_blank'); else realWin.location.href = hostUrlFor(t);
  }, true);
  // programmatic navigations (location.href = '/sandbox', etc.)
  if (realWin.navigation && realWin.navigation.addEventListener) {
    realWin.navigation.addEventListener('navigate', function (e) {
      if (!e.cancelable || e.hashChange || e.navigationType === 'traverse') return;
      var t = target(e.destination.url); if (!t) return;
      e.preventDefault(); realWin.location.href = hostUrlFor(t);
    });
  }
}
var EXT_ID = 'adbacgifemdbhdkfppmeilbgppmhaobf';
var EXT_ORIGIN = 'chrome-extension://' + EXT_ID;

/* ---------------- URL rewriting ---------------- */
var SITE_ORIGIN = 'https://www.rokori.com';
function isBlockedHost(h) { return h === 'ropro.io' || /\.ropro\.io$/.test(h); }
function rewriteUrl(u) {
  if (u == null) return u;
  var s = String(u);
  if (s.indexOf(EXT_ORIGIN) === 0) return getURL(s.slice(EXT_ORIGIN.length));
  try {
    var url = new URL(s, realWin.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return s;
    var h = url.hostname;
    if (h === 'roblox.com' || /\.roblox\.com$/.test(h) || h === 'rokori.com') {
      return SITE_ORIGIN + url.pathname + url.search + url.hash;
    }
    return s;
  } catch (e) { return s; }
}
function blockedUrl(u) {
  try { return isBlockedHost(new URL(String(u), realWin.location.href).hostname); } catch (e) { return false; }
}
var BLOCK_BODY = '{"success":false,"error":"RoPro\'s own servers are not used by the Rokori port"}';

var realFetch = realWin.fetch.bind(realWin);
function wrappedFetch(input, init) {
  var url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
  if (blockedUrl(url)) {
    return Promise.resolve(new Response(BLOCK_BODY, { status: 503, headers: { 'Content-Type': 'application/json' } }));
  }
  var nu = rewriteUrl(url);
  if (input && typeof input === 'object' && 'url' in input) {
    if (nu !== url) input = new Request(nu, input);
  } else input = nu;
  return realFetch(input, init);
}
var RealXHR = realWin.XMLHttpRequest;
function WrappedXHR() { var x = new RealXHR(); var open = x.open;
  x.open = function (method, url) {
    var args = [].slice.call(arguments);
    args[1] = blockedUrl(url) ? 'data:application/json,' + encodeURIComponent(BLOCK_BODY) : rewriteUrl(url);
    return open.apply(x, args);
  };
  return x;
}
WrappedXHR.prototype = RealXHR.prototype;
['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (k, i) { WrappedXHR[k] = i; });

/* ---------------- resources ---------------- */
var blobCache = {};
function normPath(p) { p = String(p || ''); p = p.replace(/^\.?\//, ''); return p.replace(/^\/+/, ''); }
function getURL(p) {
  var raw = String(p || ''), path = normPath(raw), suffix = '';
  var m = path.match(/^([^?#]*)([?#].*)?$/); path = m[1]; suffix = m[2] || '';
  if (path === 'options.html') return SITE_ORIGIN + hostUrlFor(OPTIONS_PATH + suffix.replace(/^#.*/, ''));
  if (ASSETS[path]) return ASSETS[path];
  if (PAGE_SRC[path] != null) return blobUrl(path, PAGE_SRC[path], 'text/javascript');
  if (TEXT[path] != null) return blobUrl(path, TEXT[path], /\.json$/.test(path) ? 'application/json' : 'text/plain');
  if (CSS[path] != null) return blobUrl(path, CSS[path], 'text/css');
  if (/^locales\/.+\.json$/.test(path)) return 'data:application/json,%7B%7D'; // non-bundled language -> empty, i18n falls back to en
  return ASSETS['images/empty.png'] || 'data:,';
}
function blobUrl(key, text, type) {
  if (!blobCache[key]) blobCache[key] = URL.createObjectURL(new Blob([text], { type: type }));
  return blobCache[key];
}

/* ---------------- messaging ---------------- */
function clone(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return undefined; }
}
function makeEvent() {
  var ls = [];
  return {
    _ls: ls,
    addListener: function (f) { if (ls.indexOf(f) < 0) ls.push(f); },
    removeListener: function (f) { var i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
    hasListener: function (f) { return ls.indexOf(f) >= 0; },
    hasListeners: function () { return ls.length > 0; },
    _fire: function () { var a = arguments; ls.slice().forEach(function (f) { try { f.apply(null, a); } catch (e) { LOG('listener error', e); } }); }
  };
}
var TAB = { id: 1, index: 0, windowId: 1, active: true, get url() { return realWin.location.href; }, get title() { return document.title; } };
function dispatch(listeners, msg, sender) {
  return new Promise(function (resolve) {
    var done = false, asyncPending = false;
    function respond(r) { if (done) return; done = true; setTimeout(function () { resolve(clone(r)); }, 0); }
    var m = clone(msg);
    listeners.slice().forEach(function (f) {
      if (done) return;
      try {
        var ret = f(m, sender, respond);
        if (ret === true) asyncPending = true;
        else if (ret && typeof ret.then === 'function') { asyncPending = true; ret.then(respond, function () { respond(undefined); }); }
      } catch (e) { LOG('onMessage error', e); }
    });
    if (!done && !asyncPending) respond(undefined);
  });
}
var bgOnMessage = makeEvent();       // background listeners
var contentOnMessage = makeEvent();  // content-script listeners
function sendTo(event, msg, cb, sender) {
  var p = dispatch(event._ls, msg, sender);
  if (typeof cb === 'function') { p.then(function (r) { cb(r); }); return undefined; }
  return p;
}

/* ---------------- storage (GM-backed) ---------------- */
var storageOnChanged = makeEvent();
function areaKey(a) { return 'chrome.storage.' + a; }
function readArea(a) { var v = GM_getValue(areaKey(a), null); return (v && typeof v === 'object') ? v : {}; }
function writeArea(a, obj, changes) {
  GM_setValue(areaKey(a), obj);
  if (changes && Object.keys(changes).length) storageOnChanged._fire(clone(changes), a);
}
function makeArea(a) {
  function wrap(fn) { return function () { var args = [].slice.call(arguments); var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    var r; try { r = fn.apply(null, args); } catch (e) { r = undefined; LOG('storage', e); }
    var p = Promise.resolve(r); if (cb) { p.then(function (v) { setTimeout(function () { cb(v); }, 0); }); return undefined; } return p; }; }
  return {
    get: wrap(function (keys) {
      var data = readArea(a), out = {};
      if (keys == null) return clone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) { keys.forEach(function (k) { if (k in data) out[k] = clone(data[k]); }); return out; }
      Object.keys(keys).forEach(function (k) { out[k] = (k in data) ? clone(data[k]) : keys[k]; });
      return out;
    }),
    set: wrap(function (items) {
      var data = readArea(a), changes = {};
      Object.keys(items || {}).forEach(function (k) { var nv = clone(items[k]); changes[k] = { oldValue: data[k], newValue: nv }; data[k] = nv; });
      writeArea(a, data, changes);
    }),
    remove: wrap(function (keys) {
      var data = readArea(a), changes = {}; if (typeof keys === 'string') keys = [keys];
      (keys || []).forEach(function (k) { if (k in data) { changes[k] = { oldValue: data[k] }; delete data[k]; } });
      writeArea(a, data, changes);
    }),
    clear: wrap(function () { var data = readArea(a), changes = {}; Object.keys(data).forEach(function (k) { changes[k] = { oldValue: data[k] }; }); writeArea(a, {}, changes); }),
    getBytesInUse: wrap(function () { return JSON.stringify(readArea(a)).length; }),
    setAccessLevel: wrap(function () {}),
    onChanged: makeEvent()
  };
}
var storage = { sync: makeArea('sync'), local: makeArea('local'), session: makeArea('session'), managed: makeArea('managed'), onChanged: storageOnChanged };
if (typeof GM_addValueChangeListener === 'function') {
  ['sync', 'local'].forEach(function (a) {
    GM_addValueChangeListener(areaKey(a), function (name, oldV, newV, remote) {
      if (!remote) return; oldV = oldV || {}; newV = newV || {}; var changes = {};
      Object.keys(Object.assign({}, oldV, newV)).forEach(function (k) {
        if (JSON.stringify(oldV[k]) !== JSON.stringify(newV[k])) changes[k] = { oldValue: oldV[k], newValue: newV[k] };
      });
      if (Object.keys(changes).length) storageOnChanged._fire(changes, a);
    });
  });
}

/* ---------------- alarms ---------------- */
var alarms = {}, alarmOnAlarm = makeEvent();
function cbOrPromise(v, cb) { if (typeof cb === 'function') { setTimeout(function () { cb(v); }, 0); return undefined; } return Promise.resolve(v); }
var alarmsApi = {
  create: function (name, info, cb) {
    if (typeof name === 'object') { cb = info; info = name; name = ''; }
    info = info || {}; this.clear(name);
    var period = info.periodInMinutes ? info.periodInMinutes * 60000 : 0;
    var delay = info.when ? Math.max(0, info.when - Date.now()) : (info.delayInMinutes != null ? info.delayInMinutes * 60000 : period);
    var a = { name: name, scheduledTime: Date.now() + delay, periodInMinutes: info.periodInMinutes };
    var fire = function () { a.scheduledTime = Date.now() + period; alarmOnAlarm._fire({ name: a.name, scheduledTime: Date.now(), periodInMinutes: a.periodInMinutes }); };
    a._t = setTimeout(function () { fire(); if (period) a._i = setInterval(fire, period); else delete alarms[name]; }, delay);
    alarms[name] = a; return cbOrPromise(undefined, cb);
  },
  get: function (name, cb) { if (typeof name === 'function') { cb = name; name = ''; } var a = alarms[name]; return cbOrPromise(a ? { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes } : undefined, cb); },
  getAll: function (cb) { return cbOrPromise(Object.keys(alarms).map(function (k) { var a = alarms[k]; return { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }; }), cb); },
  clear: function (name, cb) { if (typeof name === 'function') { cb = name; name = ''; } var a = alarms[name]; if (a) { clearTimeout(a._t); clearInterval(a._i); delete alarms[name]; } return cbOrPromise(!!a, cb); },
  clearAll: function (cb) { Object.keys(alarms).forEach(function (k) { alarmsApi.clear(k); }); return cbOrPromise(true, cb); },
  onAlarm: alarmOnAlarm
};

/* ---------------- notifications / tabs / i18n ---------------- */
var notifClicked = makeEvent(), notifButton = makeEvent(), notifClosed = makeEvent();
var notificationsApi = {
  create: function (id, opts, cb) {
    if (typeof id === 'object') { cb = opts; opts = id; id = ''; }
    id = id || ('n' + Date.now()); opts = opts || {};
    try {
      GM_notification({ title: opts.title || 'RoPro', text: opts.message || opts.contextMessage || '', image: opts.iconUrl ? rewriteUrl(opts.iconUrl) : undefined,
        onclick: function () { notifClicked._fire(id); }, ondone: function () { notifClosed._fire(id, true); } });
    } catch (e) { LOG('notification', e); }
    return cbOrPromise(id, cb);
  },
  clear: function (id, cb) { return cbOrPromise(true, cb); },
  getAll: function (cb) { return cbOrPromise({}, cb); },
  onClicked: notifClicked, onButtonClicked: notifButton, onClosed: notifClosed
};
function openTab(url) {
  url = rewriteUrl(url);
  try { var ou = new URL(url, realWin.location.href); if (ou.origin === realWin.location.origin && isVirtualPath(ou.pathname)) url = SITE_ORIGIN + hostUrlFor(ou.pathname + ou.search); } catch (e) {}
  try { if (typeof GM_openInTab === 'function') { GM_openInTab(url, { active: true, insert: true }); return; } } catch (e) {}
  realWin.open(url, '_blank');
}
var messages = {};
try { var mj = JSON.parse(TEXT['_locales/en/messages.json'] || '{}'); Object.keys(mj).forEach(function (k) { messages[k.toLowerCase()] = mj[k].message; }); } catch (e) {}
var i18nApi = {
  getMessage: function (k, subs) { var m = messages[String(k).toLowerCase()]; if (m == null) return ''; if (subs != null) { subs = [].concat(subs); m = m.replace(/\$(\d)/g, function (_, n) { return subs[n - 1] != null ? subs[n - 1] : ''; }); } return m; },
  getUILanguage: function () { return navigator.language || 'en'; },
  getAcceptLanguages: function (cb) { return cbOrPromise(navigator.languages || ['en'], cb); }
};

function makeChrome(isBackground) {
  var onMessage = isBackground ? bgOnMessage : contentOnMessage;
  var sender = isBackground ? { id: EXT_ID, url: EXT_ORIGIN + '/background.js' } : { id: EXT_ID, tab: TAB, frameId: 0, url: realWin.location.href, origin: realWin.location.origin };
  var tabsUpdated = makeEvent();
  return {
    runtime: {
      id: EXT_ID, lastError: undefined,
      getURL: getURL,
      getManifest: function () { return clone(MANIFEST); },
      sendMessage: function (a, b, c) {
        var args = [].slice.call(arguments); var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        var msg = (typeof args[0] === 'string' && args.length > 1) ? args[1] : args[0];
        return sendTo(bgOnMessage, msg, cb, sender); // runtime.sendMessage always goes to the extension (background) side
      },
      onMessage: onMessage,
      onInstalled: makeEvent(), onStartup: makeEvent(), onUpdateAvailable: makeEvent(), onConnect: makeEvent(), onMessageExternal: makeEvent(),
      connect: function () { var ev = makeEvent(); return { postMessage: function () {}, disconnect: function () {}, onMessage: ev, onDisconnect: makeEvent() }; },
      reload: function () { realWin.location.reload(); },
      openOptionsPage: function (cb) { openTab(getURL('options.html')); return cbOrPromise(undefined, cb); },
      setUninstallURL: function (u, cb) { return cbOrPromise(undefined, cb); },
      getPlatformInfo: function (cb) { return cbOrPromise({ os: 'win', arch: 'x86-64' }, cb); }
    },
    storage: storage,
    alarms: alarmsApi,
    notifications: notificationsApi,
    i18n: i18nApi,
    tabs: {
      create: function (o, cb) { openTab((o && o.url) || '/'); return cbOrPromise(Object.assign({}, TAB, { id: 2 }), cb); },
      update: function (id, o, cb) { if (typeof id === 'object') { cb = o; o = id; } if (o && o.url) realWin.location.href = rewriteUrl(o.url); return cbOrPromise(TAB, cb); },
      query: function (q, cb) { return cbOrPromise([TAB], cb); },
      get: function (id, cb) { return cbOrPromise(TAB, cb); },
      getCurrent: function (cb) { return cbOrPromise(isBackground ? undefined : TAB, cb); },
      sendMessage: function (tabId, msg, opts, cb) { if (typeof opts === 'function') { cb = opts; } return sendTo(contentOnMessage, msg, cb, { id: EXT_ID, url: EXT_ORIGIN + '/background.js' }); },
      reload: function () { realWin.location.reload(); },
      remove: function (id, cb) { return cbOrPromise(undefined, cb); },
      onUpdated: tabsUpdated, onRemoved: makeEvent(), onActivated: makeEvent(), onCreated: makeEvent()
    },
    declarativeNetRequest: {
      updateSessionRules: function (o, cb) { return cbOrPromise(undefined, cb); },
      updateDynamicRules: function (o, cb) { return cbOrPromise(undefined, cb); },
      getSessionRules: function (cb) { return cbOrPromise([], cb); },
      getDynamicRules: function (cb) { return cbOrPromise([], cb); }
    },
    permissions: { contains: function (p, cb) { return cbOrPromise(true, cb); }, request: function (p, cb) { return cbOrPromise(true, cb); }, getAll: function (cb) { return cbOrPromise({ permissions: MANIFEST.permissions || [], origins: [] }, cb); } },
    action: { setBadgeText: function (o, cb) { return cbOrPromise(undefined, cb); }, setBadgeBackgroundColor: function (o, cb) { return cbOrPromise(undefined, cb); }, onClicked: makeEvent() },
    extension: { getURL: getURL, inIncognitoContext: false }
  };
}

/* ---------------- isolated worlds ---------------- */
var VIRTUAL_URL = null; // set by boot() on RoPro-hosted pages
function makeVirtualLocation() {
  var L = realWin.location;
  function u() { return new URL(VIRTUAL_URL, SITE_ORIGIN); }
  var o = {
    assign: function (x) { L.assign(x); }, replace: function (x) { L.replace(x); }, reload: function () { L.reload(); },
    toString: function () { return u().href; }
  };
  ['href', 'pathname', 'search', 'hash', 'host', 'hostname', 'origin', 'protocol', 'port'].forEach(function (k) {
    Object.defineProperty(o, k, { enumerable: true, get: function () { return u()[k]; },
      set: function (v) { if (k === 'href') L.href = v; else if (k === 'hash') L.hash = v; else { var nu = u(); nu[k] = v; L.href = nu.href; } } });
  });
  return o;
}
/* ---------- Avatar sandbox viewer (replaces https://ropro.io/render/) ----------
 * RoPro's sandbox asks Roblox's /v1/avatar/render for the outfit, then shows the result in an iframe
 * pointing at ropro.io/render. Here the result is shown with rokori's OWN renderers instead:
 *   2D -> the PNG rokori's render server produced;  3D -> rokori's own Thumbnail3d viewer component. */
var RENDER_BG_BASE = 'https://ropro.io/3dviewer/backgrounds/'; // RoPro's static background images
var t3dPromise = null, sandboxViewSeq = 0;
function loadRokoriViewer() {
  if (realWin.RobloxThumbnail3d) return Promise.resolve(realWin.RobloxThumbnail3d);
  if (t3dPromise) return t3dPromise;
  t3dPromise = (async function () {
    var src = GM_getValue('ropro.t3dsrc', null);
    for (var attempt = 0; attempt < 2; attempt++) {
      if (!src || attempt === 1) { // the bundle URL is content-hashed; read the current one from a profile page
        var html = await (await realFetch('/users/profile', { credentials: 'include' })).text();
        var m = html.match(/src="([^"]*-Thumbnails3d\.js[^"]*)"/); if (!m) throw new Error('Thumbnails3d bundle not found');
        src = m[1]; GM_setValue('ropro.t3dsrc', src);
      }
      var ok = await new Promise(function (res) { var sc = document.createElement('script'); sc.src = src; sc.onload = function () { res(true); }; sc.onerror = function () { res(false); }; document.head.appendChild(sc); });
      if (ok && realWin.RobloxThumbnail3d) return realWin.RobloxThumbnail3d;
    }
    throw new Error('Thumbnails3d failed to load');
  })();
  t3dPromise.catch(function () { t3dPromise = null; });
  return t3dPromise;
}
function sandboxViewHost() {
  var frame = document.getElementById('sandboxView');
  var host = document.getElementById('rokoriSandboxView');
  if (!host && frame) {
    host = document.createElement('div'); host.id = 'rokoriSandboxView'; host.className = frame.className;
    host.setAttribute('style', (frame.getAttribute('style') || '') + ';position:relative;overflow:hidden;background-size:cover;background-position:center;');
    host.innerHTML = '<img class="rk-2d" style="position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;display:none" alt="">' +
      '<div class="rk-3d thumbnail-3d-container" style="position:absolute;inset:0;display:none"></div>' +
      '<span class="rk-spin spinner spinner-default" style="position:absolute;inset:0;margin:auto"></span>';
    frame.style.display = 'none'; frame.parentNode.insertBefore(host, frame);
    var lv = document.getElementById('loaderView'); if (lv) lv.remove(); // RoPro's remote loading overlay
  }
  return host;
}
function roproRokoriView(raw, bg) {
  var host = sandboxViewHost(); if (!host) return null;
  var safeBg = String(bg || 'default').replace(/[^a-z0-9_]/gi, '') || 'default';
  host.style.backgroundImage = 'url("' + RENDER_BG_BASE + safeBg + '_background.png")';
  var url = typeof raw === 'string' ? raw : '';
  var img = host.querySelector('.rk-2d'), box = host.querySelector('.rk-3d'), spin = host.querySelector('.rk-spin');
  if (!url || /ropro\.io\/render\/?$/.test(url)) { spin.style.display = ''; return null; } // initial "loading" state
  var seq = ++sandboxViewSeq;
  var abs = new URL(url, SITE_ORIGIN).href;
  spin.style.display = '';
  if (/\/thumbs\/3d\//.test(abs)) {
    loadRokoriViewer().then(function (T3d) {
      if (seq !== sandboxViewSeq) return;
      var React = realWin.React, ReactDOM = realWin.ReactDOM;
      var data = { targetId: seq, state: 'Completed', imageUrl: abs, version: 'TN3' };
      ReactDOM.render(React.createElement(T3d.Thumbnail3d, {
        targetId: seq, type: T3d.ThumbnailTypes ? T3d.ThumbnailTypes.Avatar : 'Avatar', version: String(seq),
        getThumbnailJson: function () { return Promise.resolve({ data: data }); },
        onSuccess: function () { if (seq === sandboxViewSeq) spin.style.display = 'none'; },
        onFailure: function () { if (seq === sandboxViewSeq) spin.style.display = 'none'; }
      }), box);
      img.style.display = 'none'; box.style.display = 'block';
      setTimeout(function () { if (seq === sandboxViewSeq) spin.style.display = 'none'; }, 4000);
    }).catch(function (e) { LOG('3D viewer', e); spin.style.display = 'none'; });
  } else {
    // rokori marks every <img> loading="lazy", and a lazy image hidden with display:none never loads,
    // so preload eagerly and swap in once it's ready.
    var pre = new Image(); pre.loading = 'eager'; pre.decoding = 'async';
    pre.onload = function () { if (seq !== sandboxViewSeq) return; img.loading = 'eager'; img.src = abs; spin.style.display = 'none'; img.style.display = 'block'; box.style.display = 'none'; };
    pre.onerror = function () { if (seq === sandboxViewSeq) spin.style.display = 'none'; };
    pre.src = abs;
  }
  return null; // tells RoPro not to touch its iframe
}

/* ---------- Bio verification (replaces RoPro's in-game emoji verification) ----------
 * Put a generated phrase in your rokori bio, press Verify; ownership is proven by reading the bio back
 * through rokori's API, then RoPro's normal "verified" record is stored locally. */
var VERIFY_WORDS = ['maple', 'otter', 'frost', 'comet', 'pixel', 'cobalt', 'ember', 'willow', 'nova', 'pebble', 'cedar', 'falcon', 'lumen', 'tidal', 'quartz', 'aspen'];
async function rokoriMe() {
  var r = await realFetch('/v1/users/authenticated', { credentials: 'include' }); if (!r.ok) throw new Error('Not logged in');
  return r.json();
}
function rokoriBioVerify() {
  if (document.getElementById('rk-verify')) return;
  var wrap = document.createElement('div'); wrap.id = 'rk-verify';
  wrap.innerHTML = '<style>#rk-verify{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-family:"Builder Sans",Arial,sans-serif}' +
    '#rk-verify .bx{background:#232527;color:#fff;border-radius:12px;width:420px;max-width:calc(100vw - 32px);padding:22px 22px 18px;box-shadow:0 10px 40px rgba(0,0,0,.5);position:relative}' +
    '#rk-verify h3{margin:0 0 6px;font-size:20px;color:#fff}#rk-verify p{margin:6px 0;color:#c9cbcf;font-size:14px;line-height:1.4}' +
    '#rk-verify code{display:block;margin:12px 0;padding:10px 12px;background:#111214;border:1px solid #3a3d42;border-radius:8px;font-size:15px;color:#fff;user-select:all;word-break:break-all}' +
    '#rk-verify .row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}#rk-verify button,#rk-verify a.b{flex:1;padding:9px 10px;border-radius:8px;border:0;cursor:pointer;font-size:14px;font-weight:600;text-align:center;text-decoration:none}' +
    '#rk-verify .pri{background:#335fff;color:#fff}#rk-verify .sec{background:#3a3d42;color:#fff}#rk-verify .x{position:absolute;top:10px;right:12px;background:none;color:#aaa;font-size:20px;flex:none;padding:0 4px}' +
    '#rk-verify .msg{min-height:20px;margin-top:10px;font-size:13px}</style>' +
    '<div class="bx"><button class="x" title="Close">×</button><h3>Verify RoPro User</h3><p>Loading…</p></div>';
  document.body.appendChild(wrap);
  var bx = wrap.querySelector('.bx'), close = function () { wrap.remove(); };
  wrap.querySelector('.x').onclick = close; wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
  var api = function (p, body) {
    return realFetch(API_BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  };
  rokoriMe().then(async function (me) {
    var start = await api('/rokori/verify/start', { userId: me.id });
    if (!start || !start.phrase) throw new Error((start && start.message) || 'server unavailable');
    var phrase = start.phrase;
    bx.innerHTML = '<button class="x" title="Close">×</button><h3>Verify RoPro User</h3>' +
      '<p>Add this phrase anywhere in your rokori bio (About), save it, then press <b>Verify</b>.</p><code></code>' +
      '<div class="row"><button class="sec rk-copy">Copy phrase</button><a class="b sec" href="/my/account#!/info" target="_blank">Edit my bio</a></div>' +
      '<div class="row"><button class="pri rk-go">Verify</button></div><div class="msg"></div>';
    bx.querySelector('code').textContent = phrase;
    bx.querySelector('.x').onclick = close;
    var msg = bx.querySelector('.msg');
    bx.querySelector('.rk-copy').onclick = function () { try { navigator.clipboard.writeText(phrase); msg.style.color = '#9fe6a0'; msg.textContent = 'Copied.'; } catch (e) {} };
    bx.querySelector('.rk-go').onclick = async function () {
      msg.style.color = '#c9cbcf'; msg.textContent = 'Checking your bio…';
      try {
        var res = await api('/rokori/verify/check', { userId: me.id });
        if (!res || res.verified !== true || !res.token) { msg.style.color = '#ff8a8a'; msg.textContent = 'Phrase not found in your bio yet. Save your bio and try again.'; return; }
        var cur = (await storage.sync.get(['userVerification'])).userVerification;
        var dict = (cur && typeof cur === 'object') ? cur : {};
        dict[String(me.id)] = res.token; // issued by the server after it read your bio
        await storage.sync.set({ rpUserID: me.id, rpUsername: res.username || me.name, userVerification: dict });
        msg.style.color = '#9fe6a0'; msg.textContent = 'Verified! You can remove the phrase from your bio now. Reloading…';
        setTimeout(function () { realWin.location.reload(); }, 1500);
      } catch (e) { msg.style.color = '#ff8a8a'; msg.textContent = 'Could not check your bio: ' + (e && e.message || e); }
    };
  }).catch(function (e) { bx.querySelector('p').textContent = 'Could not load your account: ' + (e && e.message || e); });
}

var OVERRIDE_KEYS = { roproRokoriView: 1, rokoriBioVerify: 1, window: 1, self: 1, globalThis: 1, top: 1, parent: 1, frames: 1, chrome: 1, browser: 1, fetch: 1, XMLHttpRequest: 1 };
function makeWorld(name, isBackground) {
  var store = Object.create(null);
  var chromeObj = makeChrome(isBackground);
  var bound = new Map();
  var proxy;
  var special = {
    window: function () { return proxy; }, self: function () { return proxy; }, globalThis: function () { return proxy; },
    frames: function () { return proxy; },
    top: function () { return realWin.top === realWin ? proxy : realWin.top; },
    parent: function () { return realWin.parent === realWin ? proxy : realWin.parent; },
    chrome: function () { return chromeObj; }, browser: function () { return undefined; },
    fetch: function () { return wrappedFetch; }, XMLHttpRequest: function () { return WrappedXHR; },
    roproRokoriView: function () { return roproRokoriView; },
    rokoriBioVerify: function () { return rokoriBioVerify; },
    location: function () { return VIRTUAL_URL ? (vloc || (vloc = makeVirtualLocation())) : realWin.location; }
  };
  var vloc = null;
  proxy = new Proxy(store, {
    has: function (t, k) {
      if (k === Symbol.unscopables) return false;
      if (typeof k !== 'string') return k in store;
      if (k === '__p' || k === '__bind') return false; // loader internals live in the closure
      return (k in store) || OVERRIDE_KEYS[k] === 1 || (k === 'location' && !!VIRTUAL_URL) || !(k in realWin);
    },
    get: function (t, k) {
      if (k === Symbol.unscopables) return undefined;
      if (k in store) return store[k];
      if (typeof k === 'string' && special[k]) return special[k]();
      var v = realWin[k];
      if (typeof v === 'function' && typeof k === 'string' && /^[a-z]/.test(k)) {
        var b = bound.get(v); if (!b) { b = v.bind(realWin); bound.set(v, b); } return b;
      }
      return v;
    },
    set: function (t, k, v) {
      if (k in store) { store[k] = v; return true; }
      if (typeof k === 'string' && (k === 'location' || /^on[a-z]+$/.test(k) || k === 'name' || k === 'status')) { realWin[k] = v; return true; }
      store[k] = v; return true;
    },
    defineProperty: function (t, k, d) { Object.defineProperty(store, k, Object.assign({ configurable: true }, d)); return true; },
    deleteProperty: function (t, k) { delete store[k]; return true; },
    getOwnPropertyDescriptor: function (t, k) { var d = Object.getOwnPropertyDescriptor(store, k); return d; },
    ownKeys: function () { return Reflect.ownKeys(store); }
  });
  function bind(map) {
    Object.keys(map).forEach(function (k) {
      var gs = map[k];
      Object.defineProperty(store, k, { configurable: true, enumerable: true,
        get: function () { try { return gs[0](); } catch (e) { return undefined; } },
        set: function (v) { if (gs[1]) gs[1](v); else Object.defineProperty(store, k, { value: v, writable: true, configurable: true, enumerable: true }); } });
    });
  }
  function run(unitName, unitFactory) {
    if (!unitFactory) { LOG(name, 'missing unit', unitName); return; }
    try { unitFactory(proxy, bind).call(proxy); }
    catch (e) { LOG(name, 'error in', unitName, e); }
  }
  return { name: name, proxy: proxy, store: store, chrome: chromeObj, run: run };
}

/* ---------------- loader ---------------- */
var UNITS = __CONTENT_UNITS__;

function addCss(text) {
  if (typeof GM_addStyle === 'function') return GM_addStyle(text);
  var s = document.createElement('style'); s.textContent = text; (document.head || document.documentElement).appendChild(s); return s;
}
function whenStage(stage, fn) {
  if (stage === 'start') return whenHead(fn); // Chrome guarantees <html> exists at document_start
  var ready = function () {
    if (stage === 'end') fn();
    else { var ric = realWin.requestIdleCallback ? realWin.requestIdleCallback.bind(realWin) : function (f) { setTimeout(f, 50); }; ric(fn, { timeout: 300 }); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
}

/* rokori's own site script hooks HTMLIFrameElement.src and rewrites RoPro theme-frame URLs to its own
 * /themeFrame.php (which 404s). This userscript runs before rokori's scripts, so it keeps the browser's
 * original setter and puts RoPro's theme frames back on the RoPro API server. Other iframes are untouched. */
var NATIVE_IFRAME_SRC = Object.getOwnPropertyDescriptor(realWin.HTMLIFrameElement.prototype, 'src');
var NATIVE_GET_ATTR = realWin.Element.prototype.getAttribute;
var NATIVE_SET_ATTR = realWin.Element.prototype.setAttribute;
var THEME_FRAME_PATH = /^\/(themeFrame|themeFrameVideo)\.php(\?|$)/;
function themeFrameTarget(raw) {
  var u; try { u = new URL(String(raw || ''), realWin.location.href); } catch (e) { return null; }
  if (!THEME_FRAME_PATH.test(u.pathname)) return null;
  if (u.origin === realWin.location.origin || u.origin === new URL(API_BASE).origin) return API_BASE + u.pathname + u.search;
  return null;
}
// Pin a RoPro theme frame to its real URL: set it with the browser's own setter, and ignore later
// rewrites of this element by rokori's shim (instance-level, so nothing else on the page is affected).
function pinThemeFrame(el) {
  if (!el || el.tagName !== 'IFRAME' || el.__rkPinned) return;
  var target = themeFrameTarget(NATIVE_GET_ATTR.call(el, 'src'));
  if (!target) return;
  el.__rkPinned = true;
  Object.defineProperty(el, 'src', { configurable: true,
    get: function () { return NATIVE_IFRAME_SRC.get.call(el); },
    set: function (v) { apply(v); } });
  // rokori's attribute observer writes back via el.setAttribute, which lands here
  el.setAttribute = function (n, v) {
    if (String(n).toLowerCase() === 'src') return apply(v);
    return NATIVE_SET_ATTR.call(el, n, v);
  };
  function apply(v) {
    var t = themeFrameTarget(v); if (!t) return;           // non-theme URLs are ignored for this frame
    target = t;
    if (NATIVE_GET_ATTR.call(el, 'src') !== t) NATIVE_SET_ATTR.call(el, 'src', t); // no-op when unchanged: no ping-pong
  }
  apply(target);
}
function guardThemeFrames() {
  var mo = new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.tagName === 'IFRAME') pinThemeFrame(n); else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(pinThemeFrame);
      });
    });
  });
  whenHead(function () { mo.observe(document.documentElement, { subtree: true, childList: true }); });
}

/* RoPro themes on rokori: the theme fills the whole page behind everything (like RoPro on Roblox),
 * rokori's opaque page layers become transparent and the sidebar translucent. Only while a theme is on. */
/* No paid tiers in this port: hide every upgrade prompt, Plus/Rex section and paid-only feature. */
var PAID_SETTINGS = __PAID_SETTINGS__;
var NO_PAID_UI_CSS = [
  '.rbx-upgrade-now, #upgrade-now-button, #video-upgrade-button, #upgradeTrialBar, #freeTrialBar, #freeTrialInfo, #upgradeCTA, .upgrade-cta,',
  '.upgrade-modal, .ropro-upgrade-modal, .trade_offers_rex_modal, .ropro-gate-locked, .ropro-visual-gate-notice-host,',
  '.ropro-trade-offers-btn-locked, .ropro-trade-search-button-locked, .ropro-trade-panel-dropdown-button-locked, .ropro-sandbox-save-button-locked,',
  '.ropro-body-adjustments-locked, .ropro-body-adjustment-lock-message, .ropro-mutual-option-locked, .ropro-trade-panel-plus-feature-label,',
  'a[href*="ropro.io/upgrade"], a[href*="ropro.io/?upgrade"], a[href*="ropro.io/subscription"], .upgradeText, .upgradeButtonText,',
  /* themes page: animated (Plus/Rex) themes and the color-adjustment upsell */
  '.content.theme-color:has(#videoUpgradeLink):not(:has(.content)), #roproVideoThemeContainer, #hslUpsell, #customThemeCTA, #hslUpgradeLink,',
  /* sandbox: saved outfits are a paid feature */
  '#sandbox h3:has(#createOutfitButton), #createOutfitButton, #outfitNameGroup, #outfitSubtitle, #outfitContainer, #sandbox .nameAndSaveText, #sandbox .pressEnterKeyText,',
  /* settings page: Plus/Rex tabs, subscription controls */
  'a.item[data-tab="second"], a.item[data-tab="third"], .tab[data-tab="second"], .tab[data-tab="third"],',
  '#manageSubscription, #activateSubscription, #standardTierUpgrade, #proTierUpgrade, #subscription, #subscriptionIcon, #subscriptionTier',
  '{ display: none !important; }'
].join('\n') + '\n' + PAID_SETTINGS.map(function (k) { return 'li.ropro-feature-row:has(#' + k + ')'; }).join(',\n') + ' { display: none !important; }';

var THEME_LAYOUT_CSS = [
  'html:has(#roproThemeBackdropFrame), html:has(#roproThemeBackdropFrame) body.rbx-body,',
  'html:has(#roproThemeBackdropFrame) #wrap, html:has(#roproThemeBackdropFrame) #container-main,',
  'html:has(#roproThemeBackdropFrame) #container-main > .content, html:has(#roproThemeBackdropFrame) #content { background-color: transparent !important; }',
  'html:has(#roproThemeBackdropFrame) #roproThemeBackdropFrame { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: -1 !important; pointer-events: none !important; filter: brightness(.7) saturate(1.05); }',
  'html:has(#roproThemeBackdropFrame) #container-main > #roproThemeFrame { display: none !important; }',
  'html:has(#roproThemeBackdropFrame) .left-nav { background-color: rgba(18,18,21,.72) !important; backdrop-filter: blur(6px); }',
  'html:has(#roproThemeBackdropFrame) #header.rbx-header { background-color: rgba(25,26,31,.92) !important; }',
  'html:has(#roproThemeBackdropFrame) #container-main { text-shadow: 0 1px 2px rgba(0,0,0,.9), 0 0 6px rgba(0,0,0,.55); }'
].join('\n');

function boot() {
  guardThemeFrames();
  whenHead(function () { addCss(THEME_LAYOUT_CSS); addCss(NO_PAID_UI_CSS); });
  installVirtualNav();
  var virtual = resolveVirtual();
  var path = realWin.location.pathname, search = realWin.location.search;
  if (virtual) {
    var vu = new URL(virtual, SITE_ORIGIN); path = vu.pathname; search = vu.search; VIRTUAL_URL = vu.href;
    try { realWin.history.replaceState(realWin.history.state, '', virtual); } catch (e) {} // show the RoPro route in the address bar
    realWin.addEventListener('pagehide', function () {
      try { realWin.sessionStorage.setItem('ropro.virtual', JSON.stringify({ path: virtual, t: Date.now() })); } catch (e) {}
    });
  }
  // Background world (one per tab; it's a service worker in Chrome)
  var bg = makeWorld('background', true);
  var firstRun = !GM_getValue('ropro.installed', false);
  bg.run('background.js', __BACKGROUND_UNIT__);
  setTimeout(function () {
    if (firstRun) { GM_setValue('ropro.installed', true); bg.chrome.runtime.onInstalled._fire({ reason: 'install' }); }
    bg.chrome.runtime.onStartup._fire();
  }, 0);

  var content = makeWorld('content', false);
  if (GM_getValue('ropro.debug', false)) realWin.__roproWorlds = { background: bg.proxy, content: content.proxy };

  if (/\/ropro\/settings\/?$/.test(path)) {
    bootOptions(content);
    return;
  }

  var url = 'https://www.rokori.com' + path + search;
  var inv = realWin.location.hash.match(/^#ropro-invite=([0-9a-z]{6})$/i);
  if (inv && /\/games\//.test(path)) {
    var key = inv[1]; try { realWin.history.replaceState(realWin.history.state, '', path + search); } catch (e) {}
    var sendInvite = function () { contentOnMessage._fire({ type: 'invite', key: key }, { id: EXT_ID }, function () {}); };
    realWin.addEventListener('load', function () { setTimeout(sendInvite, 2500); }, { once: true });
  }
  GROUPS.forEach(function (g) {
    var match = g.patterns.some(function (re) { return new RegExp(re).test(url); });
    if (!match) return;
    (g.css || []).forEach(function (c) { if (CSS[c] != null) whenHead(function () { addCss(CSS[c]); }); });
    whenStage(g.run_at, function () { g.js.forEach(function (f) { content.run(f, UNITS[f]); }); });
  });
}
function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn, { once: true }); }
function whenHead(fn) {
  if (document.documentElement) return fn();
  var mo = new MutationObserver(function () { if (document.documentElement) { mo.disconnect(); fn(); } });
  mo.observe(document, { childList: true });
}

function bootOptions(world) {
  // Replace rokori's page with RoPro's settings page.
  var html = OPTIONS.html;
  document.open(); document.write(html); document.close(); // replaces rokori's error page before it parses
  document.title = 'RoPro Settings (Rokori)';
  OPTIONS.css.forEach(function (c) { if (CSS[c] != null) addCss(CSS[c]); });
  addCss(NO_PAID_UI_CSS); // document.write replaced the page, so add it again
  var go = function () {
    OPTIONS.js.forEach(function (f) { world.run(f, UNITS[f]); });
    // options scripts may wait for DOMContentLoaded / load which already fired for the written doc
    setTimeout(function () {
      try { document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true })); } catch (e) {}
      try { realWin.dispatchEvent(new Event('load')); } catch (e) {}
    }, 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); else go();
}

if (typeof GM_registerMenuCommand === 'function') {
  GM_registerMenuCommand('✅ Verify RoPro user (bio)', function () { whenBody(rokoriBioVerify); });
  GM_registerMenuCommand('⚙️ RoPro settings', function () { openTab(SITE_ORIGIN + hostUrlFor(OPTIONS_PATH)); });
}
boot();
