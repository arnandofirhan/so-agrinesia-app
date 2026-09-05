/**
 * api-bridge.js
 * ======================================================================
 * Shim google.script.run supaya SELURUH kode di JavaScript.html (termasuk
 * callServer(), pemanggilan login(...), dan getSoDetail(...)) BISA JALAN
 * TANPA DIUBAH SATU BARIS PUN, walau sekarang di-host di GitHub Pages
 * (origin berbeda dari script.google.com tempat backend GAS berjalan).
 *
 * Wajib dimuat DI ATAS <script src="JavaScript.html"> di index.html, dan
 * variabel global SO_APP_URL (URL /exec Web App GAS) harus sudah didefinisikan
 * SEBELUM file ini dimuat.
 *
 * ======================================================================
 * RIWAYAT PERBAIKAN (baca ini kalau nanti ketemu masalah serupa lagi):
 * ======================================================================
 * v1 (JSONP murni via GET, ?fn=..&args=...&callback=...):
 *   - GAGAL untuk payload besar (import ratusan/ribuan baris) karena
 *     panjang URL/query string terbatas (~8000 karakter).
 *   - Retry otomatis di callServer() bisa memicu fungsi backend yang
 *     tidak idempotent berjalan dobel (mis. createStockOpname), karena
 *     request GET tetap diproses server walau responsnya telat di
 *     browser.
 *   - Callback global "_soCb_..." yang tidak sempat terpanggil (mis. user
 *     pindah halaman sebelum request selesai) menumpuk jadi error
 *     "ReferenceError: _soCb_... is not defined" di console.
 *
 * v2 (POST lewat <form> + <iframe> tersembunyi + postMessage):
 *   - TERNYATA TIDAK BISA DIPAKAI SAMA SEKALI untuk Web App GAS. Google
 *     SELALU me-redirect (HTTP 302) setiap request ke URL .../exec ke URL
 *     internal lain sebelum benar-benar dieksekusi. Untuk request NON-GET
 *     (termasuk POST dari <form>), redirect 302 itu diubah browser
 *     menjadi request GET tanpa body sama sekali (perilaku standar
 *     redirect 302 lintas method) begitu terjadi di dalam <iframe> —
 *     sehingga doPost() di server TIDAK PERNAH benar-benar menerima data
 *     apapun, dan halaman di dalam iframe tidak pernah selesai memuat ->
 *     login macet selamanya di "Memproses..." / berakhir TIMEOUT.
 *
 * v3 (SEKARANG — fetch() biasa, Content-Type: text/plain):
 *   - fetch() (BUKAN iframe/form) mengikuti redirect 302 tsb secara
 *     otomatis SAMBIL TETAP mempertahankan method POST & body-nya (beda
 *     dari perilaku form/iframe) — ini perilaku standar fetch() untuk
 *     redirect 307/308, dan Google Apps Script diketahui mengirim varian
 *     redirect yang kompatibel dengan ini untuk Web App-nya.
 *   - Content-Type SENGAJA "text/plain" (BUKAN "application/json"), supaya
 *     browser menganggap ini "simple request" (tidak memicu preflight
 *     OPTIONS) — GAS tidak pernah merespons OPTIONS, jadi kalau sampai
 *     ada preflight, request itu otomatis gagal total.
 *   - Response akhir dari GAS (setelah redirect) membawa header
 *     "Access-Control-Allow-Origin: *", sehingga BISA dibaca fetch() dari
 *     origin manapun (termasuk GitHub Pages) tanpa perlu trik JSONP/iframe
 *     apapun lagi.
 *   - Payload TIDAK LAGI dibatasi panjang URL sama sekali (data ada di
 *     body request, bukan query string) — inilah yang benar-benar
 *     menyelesaikan masalah "import 900 baris gagal".
 * ======================================================================
 */
(function () {
  if (typeof SO_APP_URL === 'undefined' || !SO_APP_URL) {
    console.error('[api-bridge] SO_APP_URL belum didefinisikan sebelum api-bridge.js dimuat.');
    return;
  }

  var REQUEST_TIMEOUT_MS = 60000;

  function requestServer(fnName, args) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

    var fetchOpts = {
      method: 'POST',
      // "text/plain" dipertahankan APA ADANYA (bukan application/json) —
      // lihat catatan panjang di atas file ini tentang kenapa ini WAJIB
      // supaya tidak memicu CORS preflight yang tidak didukung GAS.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fnName, args: args || [] }),
      redirect: 'follow'
    };
    if (controller) fetchOpts.signal = controller.signal;

    return fetch(SO_APP_URL, fetchOpts)
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) {
          throw new Error('Server merespons dengan status ' + res.status);
        }
        return res.text();
      })
      .then(function (text) {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error('Respons server tidak valid (bukan JSON).');
        }
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          throw new Error('TIMEOUT');
        }
        // Pesan generik untuk kegagalan jaringan murni (offline, DNS,
        // server tidak bisa dihubungi sama sekali) — dipertahankan sama
        // seperti pesan versi-versi sebelumnya supaya UI (callServer,
        // showToast) tidak perlu diubah.
        throw new Error(err && err.message ? err.message : 'Gagal menghubungi server (jaringan/URL app bermasalah).');
      });
  }

  // ---- Shim google.script.run ----
  // Meniru chaining asli: google.script.run.withSuccessHandler(fn).withFailureHandler(fn).namaFungsi(args...)
  // Proxy dipakai supaya SEMUA nama fungsi (login, getDashboardData, saveSoFisik, dst)
  // otomatis tertangani tanpa perlu didaftar satu-satu di sisi frontend.
  function makeRunner(successFn, failureFn) {
    return new Proxy({}, {
      get: function (_target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return makeRunner(fn, failureFn); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return makeRunner(successFn, fn); };
        }
        // withUserObject / withFormElement dkk tidak dipakai kode ini,
        // disediakan sebagai no-op supaya tidak error kalau suatu saat dipakai.
        if (prop === 'withUserObject' || prop === 'withFormElement') {
          return function () { return makeRunner(successFn, failureFn); };
        }
        if (typeof prop !== 'string') return undefined;

        return function () {
          var args = Array.prototype.slice.call(arguments);
          requestServer(prop, args)
            .then(function (res) { if (successFn) successFn(res); })
            .catch(function (err) { if (failureFn) failureFn(err); });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();
