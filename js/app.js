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

  // a scene declares either a single `bank` (object) or several `banks` (array,
  // different K to explore). Normalise both to an array.
  function bankDefs(s) {
    return (s.banks && s.banks.length) ? s.banks : (s.bank ? [s.bank] : []);
  }

  // ─── scene list ─────────────────────────────────────────────────────────────
  // Each scene is a row; a multi-bank scene also carries an inline K-picker that
  // only shows while that scene is active (CSS: .scene-item.active .bank-options).
  function renderSceneList() {
    var el = $('scene-list');
    el.innerHTML = '';
    APP.scenes.forEach(function (s, i) {
      var defs = bankDefs(s), b0 = defs[0] || {};
      var div = document.createElement('div');
      div.className = 'scene-item';
      div.dataset.idx = i;

      var head = document.createElement('div');
      head.className = 'sc-head';
      head.innerHTML =
        '<span class="sc-name">' + s.name + '</span>' +
        '<span class="badge ' + b0.type + '">' + b0.type + '</span>';
      head.addEventListener('click', function () { selectScene(i); });
      div.appendChild(head);

      if (defs.length > 1) {
        var opts = document.createElement('div');
        opts.className = 'bank-options';
        opts.innerHTML = '<span class="bank-lbl">K</span>';
        defs.forEach(function (b, j) {
          var btn = document.createElement('button');
          btn.className = 'bank-opt';
          btn.dataset.pos = j;
          btn.textContent = b.K;
          btn.title = b.name + ' · K=' + b.K;
          btn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (i !== APP.activeSceneIdx) selectScene(i);   // sets bank 0 first
            selectBank(j);
          });
          opts.appendChild(btn);
        });
        div.appendChild(opts);
      }
      el.appendChild(div);
    });
  }

  // switch the active scene: flip base, (re)load tiles once, then activate a bank.
  // The octree carries every cidxN attribute, so switching K below never reloads
  // tiles — only the active bank's centers/pca differ.
  function selectScene(i) {
    if (i === APP.activeSceneIdx) return;
    APP.activeSceneIdx = i;
    var s = APP.scenes[i];

    CONFIG.setBase(s.base);
    APP.sentinel = s.noise_sentinel || 65535;

    // build one bank object per declared bank; a globally-unique index keeps each
    // bank's EXPLORE caches (centers/pca) separate across scenes and K values.
    APP.banks = bankDefs(s).map(function (b, j) {
      return {
        index: i * 1000 + j, sceneIdx: i, pos: j,
        name: b.name, type: b.type, attribute: b.attribute,
        K: b.K, D: b.D, centers: b.centers, pca: b.pca,
      };
    });
    APP.banks.forEach(function (b) { EXPLORE.registerBank(b); });

    document.querySelectorAll('.scene-item').forEach(function (el) {
      el.classList.toggle('active', +el.dataset.idx === i);
    });
    $('status').textContent = (s.n_points ? s.n_points.toLocaleString() + ' pts · ' : '') + s.name;
    $('foot-info').textContent = s.name + ' · base: ' + CONFIG.BASE;

    // (re)load the point cloud for this scene; loadPointCloud disposes the old one
    APP.tilesLoaded = false;
    loadPointCloud(CONFIG.url(s.tiles)).then(function () {
      APP.tilesLoaded = true;
    });

    selectBank(0);
  }

  // ─── bank (K) switch — swaps the active cluster bank without reloading tiles ──
  function selectBank(j) {
    var bank = APP.banks[j];
    if (!bank) return;
    APP.activeBankIdx = bank.index;
    APP.activeBankPos = j;
    APP.activeAttr = bank.attribute;
    $('active-bank-lbl').textContent = bank.name + ' (' + bank.type + ', K=' + bank.K + ')';
    // highlight the picked K in the active scene's inline picker
    var active = document.querySelector('.scene-item.active');
    if (active) active.querySelectorAll('.bank-opt').forEach(function (b) {
      b.classList.toggle('active', +b.dataset.pos === j);
    });
    // EXPLORE re-applies the current color mode against the new bank
    EXPLORE.setActiveBank(bank);
    EXPLORE.prefetchPca(bank.index).catch(function () {});
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
