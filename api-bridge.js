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
 * Cara kerja: setiap pemanggilan google.script.run.xxx(args) diterjemahkan
 * jadi request JSONP (tag <script src="...exec?fn=xxx&args=...">) ke
 * backend GAS. JSONP dipilih (bukan fetch) karena TIDAK tunduk pada aturan
 * CORS browser sama sekali — satu-satunya cara yang terbukti stabil lintas
 * Android/iPhone untuk komunikasi GitHub Pages <-> Apps Script /exec.
 * ======================================================================
 */
(function () {
  if (typeof SO_APP_URL === 'undefined' || !SO_APP_URL) {
    console.error('[api-bridge] SO_APP_URL belum didefinisikan sebelum api-bridge.js dimuat.');
    return;
  }

  var _cbCounter = 0;
  var _pending = {}; // cbName -> { script, timer }

  // Timeout jaringan untuk 1 percobaan JSONP. callServer() di JavaScript.html
  // sudah punya retry/timeout sendiri di atas ini, jadi nilai di sini sengaja
  // dibuat agak longgar (di bawah timeout callServer) supaya callServer yang
  // pegang kendali retry, bukan dua lapis timeout saling tumpang tindih.
  var JSONP_TIMEOUT_MS = 15000;

  function jsonpCall(fnName, args) {
    return new Promise(function (resolve, reject) {
      var cbName = '_soCb_' + (Date.now()) + '_' + (_cbCounter++);

      function cleanup() {
        var entry = _pending[cbName];
        if (entry && entry.timer) clearTimeout(entry.timer);
        if (entry && entry.script && entry.script.parentNode) {
          entry.script.parentNode.removeChild(entry.script);
        }
        delete window[cbName];
        delete _pending[cbName];
      }

      window[cbName] = function (result) {
        cleanup();
        resolve(result);
      };

      var script = document.createElement('script');
      script.async = true;
      script.onerror = function () {
        cleanup();
        reject(new Error('Gagal menghubungi server (jaringan/URL app bermasalah).'));
      };

      var sep = SO_APP_URL.indexOf('?') === -1 ? '?' : '&';
      var url = SO_APP_URL + sep
        + 'fn=' + encodeURIComponent(fnName)
        + '&args=' + encodeURIComponent(JSON.stringify(args || []))
        + '&callback=' + cbName
        + '&_=' + Date.now(); // cache-buster, konsisten dgn pola cache-busting yg sudah dipakai di index_github.html

      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('TIMEOUT'));
      }, JSONP_TIMEOUT_MS);

      _pending[cbName] = { script: script, timer: timer };

      script.src = url;
      document.head.appendChild(script);
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
          jsonpCall(prop, args)
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
