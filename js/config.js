// ─── config.js — static scene config + base-URL resolution + .npy parsing ─────
// Replaces the old server's /api/init. The frontend loads ./scene.json (written
// by tools/prepare_scene.py) and prepends a BASE url to every data path:
//
//   • local dev : BASE = "/data"  (tools/serve.py mounts the scene dir there)
//   • production: BASE = the HuggingFace dataset resolve URL, e.g.
//       https://huggingface.co/datasets/<user>/<repo>/resolve/main/Graz_new_big
//
// Override the base at runtime with ?base=<url> — handy for flipping between a
// local copy and HF without re-deploying. Everything else (tiles, centers, pca,
// sims) is static files + browser math; there is no backend.

window.CONFIG = (function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  // default base: local dev server mount. Flip to HF via ?base=… or by editing
  // DEFAULT_BASE before deploying.
  var DEFAULT_BASE = 'https://huggingface.co/datasets/Ashkan126/q3dgrz/resolve/main';
  // var DEFAULT_BASE = '/data';
  var BASE = (params.get('base') || DEFAULT_BASE).replace(/\/+$/, '');

  function url(rel) { return BASE + '/' + String(rel).replace(/^\/+/, ''); }

  function loadScene() {
    // scene.json ships WITH the frontend (small), data lives under BASE.
    return fetch('scene.json').then(function (r) {
      if (!r.ok) throw new Error('scene.json ' + r.status);
      return r.json();
    });
  }

  // ─── minimal .npy reader (little-endian <f4 / <f8, C-order) ─────────────────
  function parseNpy(buf) {
    var u8 = new Uint8Array(buf);
    if (u8[0] !== 0x93 || u8[1] !== 0x4e) throw new Error('not a .npy file');
    var major = u8[6];
    var headerLen, headerStart;
    var dv = new DataView(buf);
    if (major === 1) { headerLen = dv.getUint16(8, true); headerStart = 10; }
    else { headerLen = dv.getUint32(8, true); headerStart = 12; }   // v2+
    var header = new TextDecoder('ascii')
      .decode(u8.subarray(headerStart, headerStart + headerLen));
    var descr = (/'descr':\s*'([^']+)'/.exec(header) || [])[1];
    var fortran = /'fortran_order':\s*True/.test(header);
    var shapeM = /'shape':\s*\(([^)]*)\)/.exec(header)[1];
    var shape = shapeM.split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; }).map(Number);
    if (fortran) throw new Error('fortran-order .npy not supported');
    var dataStart = headerStart + headerLen;
    var arr;
    if (descr === '<f4') arr = new Float32Array(buf, dataStart);
    else if (descr === '<f8') arr = new Float32Array(Float64Array.from(
      new Float64Array(buf, dataStart)));            // downcast to f32
    else throw new Error('unsupported npy dtype: ' + descr);
    return { data: arr, shape: shape };
  }

  function fetchNpy(rel) {
    return fetch(url(rel)).then(function (r) {
      if (!r.ok) throw new Error('npy ' + rel + ' ' + r.status);
      return r.arrayBuffer();
    }).then(parseNpy);
  }

  function fetchBin(rel) {
    return fetch(url(rel)).then(function (r) {
      if (!r.ok) throw new Error('bin ' + rel + ' ' + r.status);
      return r.arrayBuffer();
    });
  }

  return {
    BASE: BASE,
    url: url,
    loadScene: loadScene,
    fetchNpy: fetchNpy,
    fetchBin: fetchBin,
  };
})();
