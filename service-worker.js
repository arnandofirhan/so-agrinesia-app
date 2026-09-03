/**
 * service-worker.js
 * ======================================================================
 * Caching untuk shell aplikasi (HTML/CSS/JS/ikon) yang di-host di GitHub
 * Pages, supaya:
 *   1. Load pertama & load ulang jadi cepat (asset besar seperti
 *      JavaScript.html/Stylesheet.html tidak perlu diunduh ulang tiap buka).
 *   2. Perpindahan menu tetap instan karena ini SPA (tidak reload halaman).
 *   3. Aplikasi tetap bisa dibuka (shell-nya) walau sinyal jelek — data dari
 *      Google Sheets sendiri TETAP SELALU live lewat JSONP ke GAS, TIDAK
 *      di-cache di sini (supaya stok/SO yang ditampilkan tidak basi).
 *
 * CACHE_VERSION: naikkan angka ini (v1 -> v2 -> ...) setiap kali kamu
 * deploy ulang JavaScript.html/Stylesheet.html/index.html, supaya user
 * lama otomatis mendapat versi baru (bukan versi cache basi) tanpa perlu
 * uninstall PWA.
 * ======================================================================
 */
var CACHE_VERSION = 'so-shell-v1';
var SHELL_ASSETS = [
  './index.html',
  './Stylesheet.html',
  './JavaScript.html',
  './Logo.html',
  './api-bridge.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(SHELL_ASSETS);
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_VERSION; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var url = event.request.url;

  // JANGAN PERNAH cache request ke backend GAS (script.google.com /
  // googleusercontent.com) — itu data live (stok, SO, dashboard, dst).
  // Selalu ambil dari jaringan, tanpa fallback cache, supaya data yang
  // tampil ke user SELALU yang terbaru.
  if (url.indexOf('script.google.com') !== -1 || url.indexOf('googleusercontent.com') !== -1) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Shell statis: cache-first (langsung dari cache kalau ada, supaya
  // instan), tapi diam-diam diperbarui di background (stale-while-revalidate)
  // supaya versi berikutnya sudah ter-update tanpa user merasa nunggu.
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var networkFetch = fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(event.request, clone); });
        }
        return response;
      }).catch(function () { return cached; });
      return cached || networkFetch;
    })
  );
});
