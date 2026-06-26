// ─── explore.js — full-density recoloring engine (fully client-side) ──────────
// Modes:
//   'rgb' → restore original colors.
//   'pca' → color each point by its cluster's PCA-RGB (precomputed <bank>_pca.bin).
//   'sim' → color each point by its cluster's similarity (heatmap + dim threshold).
// Everything keys on the active bank's cidxN attribute, read straight off the
// loaded Potree geometry — full point density, no per-point round-trip. The only
// per-bank downloads are the [K,D] centers (.npy) and [K,3] pca (.bin); the
// click→similarity cosine is computed here in the browser. No backend.

window.EXPLORE = (function () {
  'use strict';

  var _mode = 'rgb';
  var _bank = -1;          // active bank index
  var _attr = null;        // active cidx attribute name
  var _K = 0, _D = 0;
  var _sentinel = 65535;

  // per-bank file names (filled as banks are registered) + caches
  var _files = {};          // {bank: {dir, centers, pca}}
  var _centersCache = {};   // {bank: {data:Float32Array [K*D] L2-normalised, K, D}}
  var _pcaCache = {};       // {bank: Uint8Array [K*3]}

  // current similarity query
  var _simsK = null;        // Float32Array [K]
  var _simMin = 0, _simMax = 1;
  var _dimThr = 0.35;       // 0..1

  // current pca colors for active bank
  var _pca = null;          // Uint8Array [K*3]

  // recolor bookkeeping
  var _colorBackup = new Map();   // geo → original rgba Float/Uint array copy
  var _version = 0;
  var _raf = null;
  var _active = false;            // is a non-rgb coloring active?

  // ─── inferno-ish colormap ───────────────────────────────────────────────────
  var HEAT = [
    [0.001, 0.000, 0.014], [0.114, 0.046, 0.260], [0.318, 0.071, 0.430],
    [0.515, 0.132, 0.421], [0.715, 0.215, 0.330], [0.880, 0.351, 0.196],
    [0.969, 0.560, 0.118], [0.988, 0.808, 0.145], [0.988, 0.998, 0.645],
  ];
  function _heat(t) {
    var s = Math.min(0.9999, Math.max(0, t)) * (HEAT.length - 1);
    var i = Math.floor(s), f = s - i, a = HEAT[i], b = HEAT[i + 1];
    return [a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f, a[2] + (b[2]-a[2])*f];
  }

  // ─── apply current mode to one geometry's rgba attribute ────────────────────
  function _applyToGeo(geo) {
    var rgbaAttr = geo.getAttribute('rgba') || geo.getAttribute('color');
    var cidxAttr = _attr && geo.getAttribute(_attr);
    if (!rgbaAttr || !cidxAttr) return;
    if (!_colorBackup.has(geo)) _colorBackup.set(geo, rgbaAttr.array.slice());

    var N = cidxAttr.count;
    var rgba = rgbaAttr.array;

    if (_mode === 'pca' && _pca) {
      for (var i = 0; i < N; i++) {
        var ci = cidxAttr.getX(i);
        if (ci === _sentinel || ci >= _K) {
          rgba[i*4]=40; rgba[i*4+1]=40; rgba[i*4+2]=52; rgba[i*4+3]=255;
        } else {
          rgba[i*4]=_pca[ci*3]; rgba[i*4+1]=_pca[ci*3+1]; rgba[i*4+2]=_pca[ci*3+2]; rgba[i*4+3]=255;
        }
      }
    } else if (_mode === 'sim' && _simsK) {
      var thr = _dimThr, span = Math.max(0.001, 1 - thr);
      var sMin = _simMin, sRng = Math.max(0.0001, _simMax - _simMin);
      for (var j = 0; j < N; j++) {
        var cj = cidxAttr.getX(j);
        var t = (cj === _sentinel || cj >= _K) ? -1 : (_simsK[cj] - sMin) / sRng;
        if (t < thr) {
          rgba[j*4]=0; rgba[j*4+1]=0; rgba[j*4+2]=0; rgba[j*4+3]=255;
        } else {
          var br = Math.pow((t - thr) / span, 0.6);
          var c = _heat(t);
          rgba[j*4]=Math.round(c[0]*br*255); rgba[j*4+1]=Math.round(c[1]*br*255);
          rgba[j*4+2]=Math.round(c[2]*br*255); rgba[j*4+3]=255;
        }
      }
    } else {
      return;
    }
    rgbaAttr.needsUpdate = true;
    rgbaAttr._v = _version;
  }

  function _colorNode(node) {
    var gn = node.geometryNode;
    if (!gn || !gn.geometry) return;
    var geo = gn.geometry;
    var rgbaAttr = geo.getAttribute('rgba') || geo.getAttribute('color');
    if (!rgbaAttr || rgbaAttr._v === _version) return;
    _applyToGeo(geo);
  }

  function _loop() {
    if (_active && pointcloud && pointcloud.visibleNodes) {
      var nodes = pointcloud.visibleNodes;
      for (var i = 0; i < nodes.length; i++) _colorNode(nodes[i]);
    }
    _raf = requestAnimationFrame(_loop);
  }
  function _startLoop() { if (!_raf) _raf = requestAnimationFrame(_loop); }

  // newly-loaded nodes recolor immediately (before they'd flash original colors)
  function _patchGeometryLoad() {
    var Cls = window.Potree && Potree.OctreeGeometryNode;
    if (!Cls || Cls._v3patch) return;
    Cls._v3patch = true;
    var sym = Symbol('_geometry');
    Object.defineProperty(Cls.prototype, 'geometry', {
      get: function () { return this[sym]; },
      set: function (g) { this[sym] = g; if (_active && g) _applyToGeo(g); },
      configurable: true,
    });
  }

  function _restoreAll() {
    _colorBackup.forEach(function (backup, geo) {
      var rgbaAttr = geo.getAttribute('rgba') || geo.getAttribute('color');
      if (!rgbaAttr) return;
      rgbaAttr.array.set(backup);
      rgbaAttr.needsUpdate = true;
      delete rgbaAttr._v;
    });
    _colorBackup.clear();
  }

  // re-apply current coloring to all geometries we already touched (param change)
  function _reapply() {
    _version++;
    _colorBackup.forEach(function (backup, geo) { _applyToGeo(geo); });
  }

  // ─── repaint orchestration ──────────────────────────────────────────────────
  function _repaint() {
    _version++;
    if (_mode === 'rgb' || (_mode === 'sim' && !_simsK) || (_mode === 'pca' && !_pca)) {
      _active = false;
      _restoreAll();
      return;
    }
    _active = true;
    _restoreAll();           // start from true originals, then recolor fresh
    _startLoop();
  }

  // ─── data fetch helpers (static files via CONFIG, browser-cached) ───────────
  function _ensureCenters(bank) {
    if (_centersCache[bank]) return Promise.resolve(_centersCache[bank]);
    var f = _files[bank];
    return CONFIG.fetchNpy(f.dir + '/' + f.centers).then(function (npy) {
      // L2-normalise rows so cosine similarity == dot product (the old server
      // normalised centers before both /centers and /sims).
      var data = npy.data, K = npy.shape[0], D = npy.shape[1];
      for (var k = 0; k < K; k++) {
        var base = k * D, n = 0;
        for (var d = 0; d < D; d++) { var v = data[base + d]; n += v * v; }
        n = 1 / (Math.sqrt(n) + 1e-8);
        for (var d2 = 0; d2 < D; d2++) data[base + d2] *= n;
      }
      _centersCache[bank] = { data: data, K: K, D: D };
      return _centersCache[bank];
    });
  }
  function _ensurePca(bank) {
    if (_pcaCache[bank]) return Promise.resolve(_pcaCache[bank]);
    var f = _files[bank];
    return CONFIG.fetchBin(f.dir + '/' + f.pca).then(function (buf) {
      _pcaCache[bank] = new Uint8Array(buf);
      return _pcaCache[bank];
    });
  }

  // ─── client-side cosine similarity:  query cluster ids → sims_k[K] ──────────
  // sims_k[k] = max over query exemplars of  cosine(center_k, center_q)
  // centers are L2-normalised so cosine == dot product.
  function _computeSims(centers, clusterIds) {
    var data = centers.data, K = centers.K, D = centers.D;
    var seen = {}, uq = [];
    for (var i = 0; i < clusterIds.length; i++) {
      var id = clusterIds[i];
      if (id >= 0 && id < K && id !== _sentinel && !seen[id]) { seen[id] = 1; uq.push(id); }
    }
    if (!uq.length) return null;
    var M = uq.length;
    var qc = new Float32Array(M * D);
    for (var m = 0; m < M; m++) {
      var src = uq[m] * D, dst = m * D;
      for (var d = 0; d < D; d++) qc[dst + d] = data[src + d];
    }
    var sims = new Float32Array(K);
    var mn = Infinity, mx = -Infinity;
    for (var k = 0; k < K; k++) {
      var kb = k * D, best = -Infinity;
      for (var mm = 0; mm < M; mm++) {
        var qb = mm * D, dot = 0;
        for (var dd = 0; dd < D; dd++) dot += data[kb + dd] * qc[qb + dd];
        if (dot > best) best = dot;
      }
      sims[k] = best;
      if (best < mn) mn = best;
      if (best > mx) mx = best;
    }
    return { sims: sims, min: mn, max: mx };
  }

  // ─── public API ─────────────────────────────────────────────────────────────
  function registerBank(b) {
    // b carries scene.json fields incl. centers/pca filenames + banks dir.
    _files[b.index] = { dir: b._dir, centers: b.centers, pca: b.pca };
  }

  function setActiveBank(b) {
    _bank = b.index; _attr = b.attribute; _K = b.K; _D = b.D;
    _pca = _pcaCache[_bank] || null;
    _simsK = null;                       // similarity doesn't carry across banks
    if (window.onQueryCleared) window.onQueryCleared();
    if (_mode === 'pca') {
      _ensurePca(_bank).then(function (p) { _pca = p; _repaint(); });
    } else {
      _repaint();
    }
    // warm centers in the background so the first click is instant
    _ensureCenters(_bank).catch(function () {});
  }

  function setMode(mode) {
    _mode = mode;
    if (mode === 'pca' && _bank >= 0) {
      _ensurePca(_bank).then(function (p) { _pca = p; _repaint(); });
    } else {
      _repaint();
    }
  }

  function setDim(pct) { _dimThr = pct / 100; if (_mode === 'sim' && _simsK) _reapply(); }

  function _activateSims(simsK, simMin, simMax, label) {
    _simsK = simsK; _simMin = simMin; _simMax = simMax;
    if (_mode !== 'sim') { setModeRadio('sim'); _mode = 'sim'; }
    if (window.onQueryActive) window.onQueryActive(label);
    _repaint();
  }

  // single point / region: cluster ids → client-side sims_k
  function queryClusters(clusterIds, label) {
    if (_bank < 0) return;
    var bank = _bank;
    showTooltip('Computing similarity…');
    _ensureCenters(bank).then(function (centers) {
      var res = _computeSims(centers, clusterIds);
      if (!res) { showTooltip('No valid query clusters.'); return; }
      _activateSims(res.sims, res.min, res.max, label);
    }).catch(function (e) { showTooltip('Query error: ' + e.message); });
  }

  // text (CLIP banks) — not in the static DINO build yet (added later via
  // browser Transformers.js). DINO banks hide the text box, so this is inert.
  function queryText(text) {
    showTooltip('Text query needs a CLIP bank (coming soon).');
  }

  function clearQuery() {
    _simsK = null;
    if (window.onQueryCleared) window.onQueryCleared();
    _repaint();
  }

  // hook used by _activateSims to flip the UI radio (defined in app.js)
  function setModeRadio(mode) { if (window.setModeRadioUI) window.setModeRadioUI(mode); }

  _patchGeometryLoad();
  _startLoop();

  return {
    registerBank: registerBank,
    setActiveBank: setActiveBank,
    setMode: setMode,
    setDim: setDim,
    queryClusters: queryClusters,
    queryText: queryText,
    clearQuery: clearQuery,
    prefetchPca: function (bank) { return _ensurePca(bank); },
  };
})();
