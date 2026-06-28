// ─── app.js — boot, scene picker (static scenes.json), UI wiring ──────────────
// No modal / no /api/init: we fetch ./scenes.json (a manifest of scenes, each
// with its own base url + a single bank), let the user switch scenes, point
// Potree at the selected scene's tiles, and wire the panel. All compute is
// client-side.

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  APP.scenes = [];
  APP.activeSceneIdx = -1;

  // ─── boot: load the static scene manifest ───────────────────────────────────
  setLoading('Loading scenes…');
  CONFIG.loadScenes().then(function (scenes) {
    onScenesLoaded(scenes);
  }).catch(function (e) {
    setLoading('Failed to load scenes.json: ' + e.message);
  });

  function onScenesLoaded(scenes) {
    APP.scenes = scenes || [];
    if (!APP.scenes.length) { setLoading('scenes.json has no scenes.'); return; }
    renderSceneList();
    selectScene(0);
  }

  // ─── scene list ─────────────────────────────────────────────────────────────
  function renderSceneList() {
    var el = $('scene-list');
    el.innerHTML = '';
    APP.scenes.forEach(function (s, i) {
      var div = document.createElement('div');
      div.className = 'scene-item';
      div.dataset.idx = i;
      div.innerHTML =
        '<span class="sc-name">' + s.name + '</span>' +
        '<span class="badge ' + s.bank.type + '">' + s.bank.type + '</span>' +
        '<span class="sc-meta">K=' + s.bank.K + '</span>';
      div.addEventListener('click', function () { selectScene(i); });
      el.appendChild(div);
    });
  }

  // switch the active scene: flip base, (re)load tiles, activate its single bank
  function selectScene(i) {
    if (i === APP.activeSceneIdx) return;
    APP.activeSceneIdx = i;
    var s = APP.scenes[i];

    CONFIG.setBase(s.base);
    APP.sentinel = s.noise_sentinel || 65535;

    // build the bank object (one per scene); index = scene idx for unique caches
    var bank = {
      index: i, name: s.bank.name, type: s.bank.type, attribute: s.bank.attribute,
      K: s.bank.K, D: s.bank.D, centers: s.bank.centers, pca: s.bank.pca,
    };
    APP.banks = [bank];
    APP.activeBankIdx = i;
    APP.activeAttr = bank.attribute;
    EXPLORE.registerBank(bank);

    document.querySelectorAll('.scene-item').forEach(function (el) {
      el.classList.toggle('active', +el.dataset.idx === i);
    });
    $('status').textContent = (s.n_points ? s.n_points.toLocaleString() + ' pts · ' : '') +
      s.bank.name;
    $('foot-info').textContent = s.name + ' · base: ' + CONFIG.BASE;
    $('active-bank-lbl').textContent = s.bank.name + ' (' + s.bank.type + ', K=' + s.bank.K + ')';

    // EXPLORE re-applies the current color mode against the new bank
    EXPLORE.setActiveBank(bank);
    EXPLORE.prefetchPca(i).catch(function () {});

    // (re)load the point cloud for this scene; loadPointCloud disposes the old one
    APP.tilesLoaded = false;
    loadPointCloud(CONFIG.url(s.tiles)).then(function () {
      APP.tilesLoaded = true;
    });
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

  // ─── pick toggle ────────────────────────────────────────────────────────────
  var btnPick = $('btn-pick');
  function refreshToggles() {
    btnPick.textContent = '◎ Click a point: ' + (APP.pickMode ? 'ON' : 'OFF');
    btnPick.classList.toggle('active', APP.pickMode);
    renderArea.style.cursor = APP.pickMode ? 'crosshair' : 'default';
  }
  btnPick.addEventListener('click', function () {
    APP.pickMode = !APP.pickMode; refreshToggles();
  });

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
