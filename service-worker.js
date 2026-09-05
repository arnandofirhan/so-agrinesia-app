/**
 * service-worker.js
 * ======================================================================
 * Caching untuk shell aplikasi (HTML/CSS/JS/ikon) yang di-host di GitHub
 * Pages, supaya:
 *   1. Load pertama & load ulang jadi cepat (asset besar seperti
 *      JavaScript.html/Stylesheet.html tidak perlu diunduh ulang tiap buka).
 *   2. Perpindahan menu tetap instan karena ini SPA (tidak reload halaman).
 *   3. Aplikasi tetap bisa dibuka (shell-nya) walau sinyal jelek — data dari
 *      Google Sheets sendiri TETAP SELALU live lewat request ke GAS, TIDAK
 *      di-cache di sini (supaya stok/SO yang ditampilkan tidak basi).
 *
 * CACHE_VERSION: WAJIB naikkan angka ini (v1 -> v2 -> v3 -> ...) SETIAP
 * KALI kamu push perubahan ke index.html/Stylesheet.html/JavaScript.html/
 * Logo.html/api-bridge.js/manifest.json/icon-*.png — bukan cuma sekali di
 * awal project. Kalau lupa dinaikkan, HP user (termasuk HP kamu sendiri)
 * akan TETAP memakai file versi lama dari cache walau file baru sudah ada
 * di GitHub, karena strategi di bawah ini cache-first (bukan network-first)
 * untuk urusan kecepatan. Ini persis penyebab "Logo.html sudah dipush tapi
 * splash tetap kosong" — versi cache tidak berubah jadi service worker
 * merasa tidak perlu ambil ulang dari jaringan.
 *
 * NAIK KE v12 sebagai bagian dari perbaikan besar: pindah dari JSONP/GET
 * (batas panjang URL, penyebab error import & SO dobel) ke POST lewat
 * iframe tersembunyi. WAJIB dinaikkan supaya SEMUA device (termasuk HP
 * role Store yang sebelumnya masih menampilkan SO yang sudah dihapus
 * Admin) langsung ambil ulang api-bridge.js & JavaScript.html versi baru,
 * bukan terus memakai versi lama dari cache.
 * ======================================================================
 */
var CACHE_VERSION = 'so-shell-v12';
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
  // tampil ke user SELALU yang terbaru. Ini juga otomatis mencakup semua
  // request POST (form submit) ke /exec yang dipakai api-bridge.js
  // sekarang — permintaan non-GET tidak pernah cocok dgn cache manapun,
  // jadi selalu diteruskan langsung ke jaringan seperti request GET lain
  // ke domain ini.
  if (url.indexOf('script.google.com') !== -1 || url.indexOf('googleusercontent.com') !== -1) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Request non-GET (POST dari form iframe, dsb) tidak bisa/tidak boleh
  // dicocokkan ke Cache API (Cache.match hanya untuk GET) — teruskan apa
  // adanya ke jaringan.
  if (event.request.method !== 'GET') {
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
