// ─── app.js — boot, scene load (static scene.json), UI wiring ─────────────────
// No modal / no /api/init: we fetch ./scene.json, register banks, point Potree
// at the (HF or local) tiles URL, and wire the panel. All compute is client-side.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ─── boot: load the static scene descriptor ─────────────────────────────────
  setLoading('Loading scene…');
  CONFIG.loadScene().then(function (scene) {
    onProjectLoaded(scene);
  }).catch(function (e) {
    setLoading('Failed to load scene.json: ' + e.message);
  });

  function onProjectLoaded(scene) {
    APP.banks = scene.banks;
    APP.sentinel = scene.noise_sentinel || 65535;
    // stamp each bank with its banks dir + register file names with EXPLORE
    scene.banks.forEach(function (b) {
      b._dir = scene.banks_dir;
      EXPLORE.registerBank(b);
    });
    $('status').textContent = (scene.n_points ? scene.n_points.toLocaleString() + ' pts · ' : '') +
      scene.banks.length + ' banks';
    $('foot-info').textContent = scene.name + ' · base: ' + CONFIG.BASE;
    renderBankList();
    loadPointCloud(CONFIG.url(scene.tiles)).then(function () {
      APP.tilesLoaded = true;
      if (APP.banks.length) selectBank(0);
    });
  }

  // ─── bank list ────────────────────────────────────────────────────────────
  function renderBankList() {
    var el = $('bank-list');
    el.innerHTML = '';
    if (!APP.banks.length) { el.innerHTML = '<div class="muted">No banks.</div>'; return; }
    APP.banks.forEach(function (b) {
      var div = document.createElement('div');
      div.className = 'bank-item';
      div.dataset.idx = b.index;
      div.innerHTML =
        '<span class="bk-name">' + b.name + '</span>' +
        '<span class="badge ' + b.type + '">' + b.type + '</span>' +
        '<span class="bk-meta">K=' + b.K + '</span>';
      div.addEventListener('click', function () { selectBank(b.index); });
      el.appendChild(div);
    });
  }

  function selectBank(idx) {
    APP.activeBankIdx = idx;
    var b = APP.banks[idx];
    APP.activeAttr = b.attribute;
    document.querySelectorAll('.bank-item').forEach(function (el) {
      el.classList.toggle('active', +el.dataset.idx === idx);
    });
    $('active-bank-lbl').textContent = b.name + ' (' + b.type + ', K=' + b.K + ')';
    // show/hide text query depending on bank type (CLIP only; not in this build)
    $('text-wrap').style.display = (b.type === 'clip') ? '' : 'none';
    EXPLORE.setActiveBank(b);
    // warm the PCA cache so switching to PCA is instant
    EXPLORE.prefetchPca(idx).catch(function () {});
  }

  // ─── color mode radios ──────────────────────────────────────────────────────
  document.querySelectorAll('input[name="mode"]').forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      $('sim-sec').style.display = (r.value === 'sim') ? '' : 'none';
      EXPLORE.setMode(r.value);
    });
  });
  // let explore.js flip the radio when a query auto-activates sim mode
  window.setModeRadioUI = function (mode) {
    var r = document.querySelector('input[name="mode"][value="' + mode + '"]');
    if (r) { r.checked = true; }
    $('sim-sec').style.display = (mode === 'sim') ? '' : 'none';
  };

  // ─── pick / box toggles ─────────────────────────────────────────────────────
  var btnPick = $('btn-pick'), btnBox = $('btn-box');
  function refreshToggles() {
    btnPick.textContent = '◎ Click a point: ' + (APP.pickMode ? 'ON' : 'OFF');
    btnPick.classList.toggle('active', APP.pickMode);
    btnBox.textContent = '▭ Box a region: ' + (APP.boxMode ? 'ON' : 'OFF');
    btnBox.classList.toggle('active', APP.boxMode);
    renderArea.style.cursor = (APP.pickMode || APP.boxMode) ? 'crosshair' : 'default';
  }
  btnPick.addEventListener('click', function () {
    APP.pickMode = !APP.pickMode; if (APP.pickMode) APP.boxMode = false; refreshToggles();
  });
  btnBox.addEventListener('click', function () {
    APP.boxMode = !APP.boxMode; if (APP.boxMode) APP.pickMode = false; refreshToggles();
  });

  // ─── text query (CLIP — disabled in the DINO static build) ──────────────────
  function runText() {
    var t = $('inp-text').value.trim();
    if (!t) return;
    EXPLORE.queryText(t);
  }
  $('btn-text').addEventListener('click', runText);
  $('inp-text').addEventListener('keydown', function (e) { if (e.key === 'Enter') runText(); });

  // ─── query readout + dim slider ─────────────────────────────────────────────
  window.onQueryActive = function (label) {
    $('query-wrap').style.display = '';
    $('query-lbl').textContent = 'Query: ' + label;
  };
  window.onQueryCleared = function () {
    $('query-wrap').style.display = 'none';
    $('query-lbl').textContent = '—';
  };
  $('sim-dim').addEventListener('input', function (e) {
    $('sim-dim-val').textContent = e.target.value + '%';
    EXPLORE.setDim(parseInt(e.target.value, 10));
  });
  $('btn-clear-query').addEventListener('click', function () { EXPLORE.clearQuery(); });

  // ─── toolbar: point size + fit ──────────────────────────────────────────────
  $('cloud-pt-sz').addEventListener('input', function (e) {
    setPointSize(parseFloat(e.target.value));
  });
  $('btn-fit').addEventListener('click', fitView);

  refreshToggles();
})();
