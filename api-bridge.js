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
 * PERUBAHAN BESAR (fix error saat import data banyak / SO dobel / console
 * penuh error _soCb_...):
 * ======================================================================
 * Versi SEBELUMNYA memakai JSONP murni: <script src="...exec?fn=..&args=
 * [...]&callback=...">, dengan payload (args) dimasukkan ke QUERY STRING
 * URL. Ini py 2 masalah besar:
 *
 *   1. URL punya batas panjang (umumnya sekitar 8.000 karakter tergantung
 *      browser/server). Saat import ratusan/ribuan baris data, JSON.stringify
 *      dari rows tsb dengan mudah melebihi batas itu -> request gagal total
 *      atau terpotong, walau sudah di-chunk kecil, terutama kalau nama
 *      item/SKU panjang.
 *   2. Setiap request JSONP TETAP diproses server (GAS tetap menjalankan
 *      fungsinya) walau browser sudah "menyerah" duluan karena timeout —
 *      sehingga retry otomatis di callServer() bisa memicu fungsi yang
 *      TIDAK idempotent (mis. createStockOpname) berjalan lebih dari
 *      sekali, menghasilkan data dobel/SO ganda.
 *
 * SEKARANG: request dikirim sebagai POST FORM lewat <iframe> tersembunyi
 * (bukan fetch/XHR) — teknik "hidden iframe form post" ini classic dan
 * TIDAK tunduk pada CORS sama sekali (form POST cross-origin ke iframe
 * selalu diizinkan browser, beda dengan fetch/XHR), dan yang jauh lebih
 * penting: TIDAK ADA batas panjang payload seperti URL/query string,
 * karena data dikirim di form body, bukan di URL. Response dari server
 * (JSON) dikirim balik lewat postMessage() dari halaman yang di-render di
 * dalam iframe tsb (lihat doPost() & buildBridgeResponseHtml_() di
 * Code.gs). Cara ini juga otomatis menghapus SEMUA masalah callback
 * "_soCb_..." nyangkut di window/console — tidak ada lagi global callback
 * yang didaftarkan ke window sama sekali.
 * ======================================================================
 */
(function () {
  if (typeof SO_APP_URL === 'undefined' || !SO_APP_URL) {
    console.error('[api-bridge] SO_APP_URL belum didefinisikan sebelum api-bridge.js dimuat.');
    return;
  }

  var _reqCounter = 0;
  var _pending = {}; // reqId -> { resolve, reject, timer, iframe, onProgress }

  // Timeout jaringan untuk 1 percobaan request. callServer() di
  // JavaScript.html sudah punya retry/timeout sendiri di atas ini, jadi
  // nilai di sini sengaja dibuat agak longgar (di atas timeout callServer
  // untuk operasi besar seperti import) supaya callServer yang pegang
  // kendali retry, bukan dua lapis timeout saling tumpang tindih.
  var REQUEST_TIMEOUT_MS = 60000;

  // Menerima pesan balasan dari iframe (dikirim oleh halaman kecil yang
  // di-render oleh doPost() di Code.gs lewat window.parent.postMessage()).
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.__soBridge !== true) return;
    var entry = _pending[msg.reqId];
    if (!entry) return; // request sudah dibersihkan/timeout/halaman lain sudah pindah -> abaikan diam-diam, TIDAK console.error

    if (msg.type === 'progress') {
      if (entry.onProgress) {
        try { entry.onProgress(msg.progress); } catch (e) { /* jangan biarkan error di UI progress menggagalkan request */ }
      }
      return;
    }

    if (msg.type === 'result') {
      cleanupRequest_(msg.reqId);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || 'Terjadi kesalahan di server.'));
      }
    }
  });

  function cleanupRequest_(reqId) {
    var entry = _pending[reqId];
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.iframe && entry.iframe.parentNode) {
      // Iframe dilepas SETELAH beri jeda singkat (bukan langsung), supaya
      // kalau ada pesan susulan yang masih dalam perjalanan (race), tidak
      // hilang begitu saja. Jeda ini kecil dan tidak terasa oleh user.
      setTimeout(function () {
        if (entry.iframe && entry.iframe.parentNode) {
          entry.iframe.parentNode.removeChild(entry.iframe);
        }
      }, 500);
    }
    delete _pending[reqId];
  }

  // requestServer: mengirim satu panggilan fungsi backend via POST form
  // tersembunyi. onProgress (opsional) dipanggil kalau backend mengirim
  // update progres (dipakai fungsi import besar, lihat Code.gs ->
  // reportProgress_()).
  function requestServer(fnName, args, onProgress) {
    return new Promise(function (resolve, reject) {
      var reqId = 'r' + Date.now() + '_' + (_reqCounter++);

      var iframeName = 'so_bridge_' + reqId;
      var iframe = document.createElement('iframe');
      iframe.name = iframeName;
      iframe.style.display = 'none';
      document.body.appendChild(iframe);

      var form = document.createElement('form');
      form.method = 'POST';
      form.action = SO_APP_URL;
      form.target = iframeName;
      form.style.display = 'none';
      form.enctype = 'application/x-www-form-urlencoded';

      function addField(name, value) {
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      addField('fn', fnName);
      addField('args', JSON.stringify(args || []));
      addField('reqId', reqId);
      // Origin dikirim eksplisit supaya doPost() tahu ke mana harus
      // postMessage() balik (window.parent.postMessage butuh target origin).
      addField('origin', window.location.origin);

      var timer = setTimeout(function () {
        cleanupRequest_(reqId);
        reject(new Error('TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);

      _pending[reqId] = { resolve: resolve, reject: reject, timer: timer, iframe: iframe, onProgress: onProgress };

      document.body.appendChild(form);
      form.submit();
      // Form hanya alat kirim satu kali, boleh langsung dilepas (beda dgn
      // iframe yg masih dipakai utk terima response).
      form.parentNode.removeChild(form);
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

  // Dipakai LANGSUNG (bukan lewat google.script.run) oleh callServer() di
  // JavaScript.html untuk operasi yang butuh progress bar asli (import
  // Item Master / Stock Sistem) — lihat perubahan callServer() &
  // openImportItemModal()/openImportStockModal() di JavaScript.html.
  window.soApiCallWithProgress = requestServer;
})();
