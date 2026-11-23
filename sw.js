/* حصّالتي – Service Worker */
var VERSION = 'hasalty-v2';
var SHELL_CACHE = VERSION + '-shell';
var RUNTIME_CACHE = VERSION + '-runtime';

var SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

var THREE_HOURS_MS = 3 * 60 * 60 * 1000;
var ONE_DAY_MS = 24 * 60 * 60 * 1000;
var RDB_NAME = 'hasalty-reminders-db', RDB_VER = 1, RSTORE = 'reminders';

/* ---------- التثبيت والتفعيل ---------- */
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf('hasalty-') === 0 && k !== SHELL_CACHE && k !== RUNTIME_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ---------- جلب الملفات ---------- */
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.pathname.indexOf('/api/') === 0) return;

  // الصفحة: الشبكة أولاً ثم النسخة المخزنة عند انقطاع الإنترنت
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put('./index.html', copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }

  // باقي الملفات (محلية + خطوط جوجل): من الذاكرة مع تحديث في الخلفية
  var sameOrigin = url.origin === self.location.origin;
  var isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return;

  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(sameOrigin ? SHELL_CACHE : RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});

/* ---------- IndexedDB (مشترك مع الصفحة) ---------- */
function openRDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(RDB_NAME, RDB_VER);
    req.onupgradeneeded = function (ev) {
      var db = ev.target.result;
      if (!db.objectStoreNames.contains(RSTORE)) db.createObjectStore(RSTORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}
function getState() {
  return openRDB().then(function (db) {
    return new Promise(function (resolve) {
      var r = db.transaction(RSTORE, 'readonly').objectStore(RSTORE).get('state');
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; });
}
function setState(state) {
  return openRDB().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(RSTORE, 'readwrite');
      tx.objectStore(RSTORE).put(state, 'state');
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { resolve(); };
    });
  }).catch(function () {});
}

/* ---------- الرسائل من الصفحة ---------- */
self.addEventListener('message', function (e) {
  var msg = e.data || {};
  if (msg.type === 'UPDATE_REMINDERS_DATA' && msg.data) {
    e.waitUntil(setState(msg.data));
  } else if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ---------- التذكيرات في الخلفية (Periodic Background Sync) ---------- */
function runReminders() {
  return getState().then(function (st) {
    if (!st || !st.enabled) return;
    if (self.Notification && Notification.permission !== 'granted') return;

    var now = Date.now();
    var jobs = [];
    var today = st.todayItems || [];
    var long = st.longItems || [];

    if (today.length && now - (st.lastToday || 0) >= THREE_HOURS_MS) {
      var body = today.length === 1
        ? 'تذكير: لم تقم بشراء "' + today[0] + '" بعد.'
        : 'تذكير: لديك ' + today.length + ' مشتريات لليوم بانتظارك: ' + today.slice(0, 3).join('، ') + (today.length > 3 ? '...' : '');
      jobs.push(self.registration.showNotification('حصّالتي – تذكير بمشتريات اليوم 🛒', {
        body: body, icon: './icons/icon-192.png', badge: './icons/icon.svg',
        tag: 'hasalty-today-reminder', renotify: true, vibrate: [120, 60, 120],
        data: { tab: 'day', url: './index.html?tab=day' },
        actions: [{ action: 'open', title: '🛒 فتح مشتريات اليوم' }]
      }));
      st.lastToday = now;
    }

    if (long.length && now - (st.lastLong || 0) >= ONE_DAY_MS) {
      var lbody = 'لديك ' + long.length + ' أهداف تحويش ومشتريات مستقبلية: ' + long.slice(0, 3).join('، ') + (long.length > 3 ? '...' : '') + '. تفقّد خططك وتقدمك اليوم!';
      jobs.push(self.registration.showNotification('حصّالتي – تذكير بالمدى البعيد والتحويش 🎯', {
        body: lbody, icon: './icons/icon-192.png', badge: './icons/icon.svg',
        tag: 'hasalty-long-reminder', renotify: true, vibrate: [120, 60, 120],
        data: { tab: 'long', url: './index.html?tab=long' },
        actions: [{ action: 'open', title: '🎯 فتح أهداف التحويش' }]
      }));
      st.lastLong = now;
    }

    if (!jobs.length) return;
    return Promise.all(jobs).then(function () { return setState(st); });
  });
}

self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'hasalty-reminders') e.waitUntil(runReminders());
});

/* ---------- الضغط على الإشعار ---------- */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  var tab = d.tab === 'day' ? 'day' : 'long';
  var url = d.url || ('./index.html?tab=' + tab);

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          c.postMessage({ type: 'SWITCH_TAB', tab: tab });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
