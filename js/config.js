// ─── config.js — multi-scene config + base-URL resolution + .npy parsing ──────
// Replaces the old server's /api/init. The frontend loads ./scenes.json (a small
// manifest listing every scene) and each scene carries its own BASE url that all
// of its data paths (tiles, centers, pca) resolve against:
//
//   • production: BASE = the HuggingFace dataset resolve URL, e.g.
//       https://huggingface.co/datasets/<user>/<repo>/resolve/main/<scene>
//   • local dev : BASE = "/data"  (tools/serve.py mounts a scene dir there)
//
// One scene is active at a time, so we keep a single mutable BASE that the app
// flips with setBase() on scene switch. Override every scene's base at runtime
// with ?base=<url> — handy for flipping between a local copy and HF without
// re-deploying. Everything else is static files + browser math; no backend.

window.CONFIG = (function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var OVERRIDE = params.get('base');             // forces base for ALL scenes
  var BASE = '';                                 // current scene's base (mutable)

  function setBase(b) { BASE = (OVERRIDE || b || '').replace(/\/+$/, ''); }

  function url(rel) { return BASE + '/' + String(rel).replace(/^\/+/, ''); }

  function loadScenes() {
    // scenes.json ships WITH the frontend (small), data lives under each base.
    return fetch('scenes.json').then(function (r) {
      if (!r.ok) throw new Error('scenes.json ' + r.status);
      return r.json();
    }).then(function (j) { return j.scenes || []; });
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
    get BASE() { return BASE; },
    setBase: setBase,
    url: url,
    loadScenes: loadScenes,
    fetchNpy: fetchNpy,
    fetchBin: fetchBin,
  };
})();
