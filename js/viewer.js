// ─── viewer.js — Potree init, single-point picking ─────────────────────────────
// Exposes globals: viewer, pointcloud, scene, renderArea, loadPointCloud(),
// fitView(), setPointSize(). Talks to the EXPLORE module for queries.

window.APP = {
  tilesLoaded:   false,
  banks:         [],      // [{index,name,type,attribute,K,D}]
  activeBankIdx: -1,
  activeAttr:    null,    // e.g. "cidx0"
  sentinel:      65535,
  pickMode:      false,
};

var renderArea = document.getElementById('potree_render_area');
var viewer = new Potree.Viewer(renderArea);
viewer.setEDLEnabled(false);
viewer.setFOV(60);
viewer.setPointBudget(5000000);
viewer.loadSettingsFromURL();
viewer.renderer.setClearColor(0x0d0d1a, 1);

var scene = viewer.scene.scene;
var pointcloud = null;
var _cloudBB = null;
var highlightObject = null;

// ─── helpers ──────────────────────────────────────────────────────────────────
function setLoading(msg) {
  document.getElementById('loading-overlay').style.display = 'flex';
  document.getElementById('loading-text').textContent = msg;
}
function clearLoading() { document.getElementById('loading-overlay').style.display = 'none'; }

function showTooltip(msg) {
  var t = document.getElementById('pt-tooltip');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(showTooltip._t);
  showTooltip._t = setTimeout(function(){ t.style.display = 'none'; }, 2600);
}

// ─── load point cloud ──────────────────────────────────────────────────────────
function loadPointCloud(tilesUrl) {
  return new Promise(function(resolve, reject) {
    setLoading('Loading Potree tiles…');
    Potree.loadPointCloud(tilesUrl, 'scene', function(e) {
      try {
        if (pointcloud) {
          // Potree has no removePointCloud(); detach from the scene manually
          var pcs = viewer.scene.pointclouds;
          var idx = pcs.indexOf(pointcloud);
          if (idx >= 0) pcs.splice(idx, 1);
          viewer.scene.scenePointCloud.remove(pointcloud);
          if (pointcloud.dispose) pointcloud.dispose();
        }
        pointcloud = e.pointcloud;
        pointcloud.material.pointSizeType = Potree.PointSizeType.FIXED;
        pointcloud.material.size = parseFloat(document.getElementById('cloud-pt-sz').value);
        viewer.scene.addPointCloud(pointcloud);
        _cloudBB = pointcloud.getBoundingBoxWorld();
        viewer.fitToScreen();
        clearLoading();
        resolve(pointcloud);
      } catch (err) {
        setLoading('Error: ' + err.message);
        reject(err);
      }
    });
  });
}

function fitView() { viewer.fitToScreen(); }
function setPointSize(sz) { if (pointcloud) pointcloud.material.size = sz; }

function highlightPoint(xyz) {
  if (highlightObject) {
    scene.remove(highlightObject);
    highlightObject.geometry.dispose(); highlightObject.material.dispose();
    highlightObject = null;
  }
  if (!xyz) return;
  var sz = _cloudBB ? Math.min(0.5, _cloudBB.min.distanceTo(_cloudBB.max) * 0.0004) : 0.3;
  highlightObject = new THREE.Mesh(
    new THREE.SphereGeometry(sz, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xe94560 }));
  highlightObject.position.set(xyz[0], xyz[1], xyz[2]);
  scene.add(highlightObject);
}

// ─── raw pick ──────────────────────────────────────────────────────────────────
function _potreeRawPick(e) {
  if (!pointcloud) return null;
  var rect = renderArea.getBoundingClientRect();
  var domX = e.clientX - rect.left, domY = e.clientY - rect.top;
  var camera = viewer.scene.getActiveCamera();
  var rendSize = viewer.renderer.getSize(new THREE.Vector2());
  var px = domX * (rendSize.width / rect.width);
  var py = rendSize.height - domY * (rendSize.height / rect.height);
  var ndc = new THREE.Vector2((domX / rect.width) * 2 - 1, -(domY / rect.height) * 2 + 1);
  var ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  return pointcloud.pick(viewer, camera, ray.ray, { x: px, y: py, pickWindowSize: 17 });
}

// ─── single-point query ────────────────────────────────────────────────────────
function _doPointQuery(e) {
  var raw = _potreeRawPick(e);
  if (!raw) { showTooltip('No point hit'); return; }
  var ci = (APP.activeAttr && raw[APP.activeAttr] != null)
    ? Math.round(raw[APP.activeAttr][0]) : -1;
  var hi = raw['pt_id_hi'] ? Math.round(raw['pt_id_hi'][0]) : 0;
  var lo = raw['pt_id_lo'] ? Math.round(raw['pt_id_lo'][0]) : 0;
  var ptId = hi * 65536 + lo;
  if (raw.position) highlightPoint([raw.position.x, raw.position.y, raw.position.z]);
  if (ci < 0 || ci === APP.sentinel) { showTooltip('Point has no cluster in this bank'); return; }
  showTooltip('pt ' + ptId + ' · cluster ' + ci);
  if (window.EXPLORE) EXPLORE.queryClusters([ci], 'point · cluster ' + ci);
}

// ─── pick-mode click routing ───────────────────────────────────────────────────
var _md = null;
renderArea.addEventListener('mousedown', function(e) {
  _md = { x: e.clientX, y: e.clientY };
}, true);

renderArea.addEventListener('contextmenu', function(e){ e.preventDefault(); });

renderArea.addEventListener('click', function(e) {
  if (_md && (e.clientX - _md.x) ** 2 + (e.clientY - _md.y) ** 2 > 25) return; // a drag
  if (!APP.pickMode) return;
  if (!APP.tilesLoaded || APP.activeBankIdx < 0) { showTooltip('Select a scene first'); return; }
  _doPointQuery(e);
});

// no-op resize hook (Potree manages its own canvas)
function resizeRenderer() {}
