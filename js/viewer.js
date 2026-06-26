// ─── viewer.js — Potree init, point picking, region-box selection ──────────────
// Exposes globals: viewer, pointcloud, scene, renderArea, loadPointCloud(),
// fitView(), setPointSize(). Talks to the EXPLORE module for queries.

window.APP = {
  tilesLoaded:   false,
  banks:         [],      // [{index,name,type,attribute,K,D}]
  activeBankIdx: -1,
  activeAttr:    null,    // e.g. "cidx0"
  sentinel:      65535,
  pickMode:      false,
  boxMode:       false,
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
        if (pointcloud) { viewer.scene.removePointCloud(pointcloud); scene.remove(pointcloud); }
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

// ─── region (screen rectangle) gather of cluster ids ───────────────────────────
var MAX_REGION_TEST = 400000;
function _gatherClustersInRect(rect) {
  if (!pointcloud || !APP.activeAttr) return [];
  var cam = viewer.scene.getActiveCamera();
  var rb = renderArea.getBoundingClientRect();
  var W = rb.width, H = rb.height;
  var nodes = pointcloud.visibleNodes || [];
  var ids = new Set();
  var v = new THREE.Vector3();

  var total = 0;
  for (var n = 0; n < nodes.length; n++) {
    var g = nodes[n].geometryNode && nodes[n].geometryNode.geometry;
    var a = g && g.getAttribute(APP.activeAttr);
    if (a) total += a.count;
  }
  var stride = Math.max(1, Math.ceil(total / MAX_REGION_TEST));

  for (var ni = 0; ni < nodes.length; ni++) {
    var node = nodes[ni];
    var geo = node.geometryNode && node.geometryNode.geometry;
    if (!geo) continue;
    var cattr = geo.getAttribute(APP.activeAttr);
    var pos = geo.getAttribute('position');
    if (!cattr || !pos) continue;
    var mw = (node.sceneNode && node.sceneNode.matrixWorld) || pointcloud.matrixWorld;
    for (var i = 0; i < pos.count; i += stride) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mw).project(cam);
      if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1 || v.z < -1 || v.z > 1) continue;
      var sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
      if (sx >= rect.x1 && sx <= rect.x2 && sy >= rect.y1 && sy <= rect.y2) {
        var ci = cattr.getX(i);
        if (ci !== APP.sentinel) ids.add(ci);
      }
    }
  }
  return Array.from(ids);
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
  if (!APP.tilesLoaded || APP.activeBankIdx < 0) { showTooltip('Select a bank first'); return; }
  _doPointQuery(e);
});

// ─── box selection (drag a screen rectangle) ───────────────────────────────────
var _box = { active: false, drag: null };
var _boxEl = document.getElementById('box-sel');

function _boxEnabled(e) { return APP.boxMode || e.shiftKey; }

renderArea.addEventListener('mousedown', function(e) {
  if (e.button !== 0 || !_boxEnabled(e)) return;
  if (!APP.tilesLoaded || APP.activeBankIdx < 0) return;
  e.stopImmediatePropagation(); e.preventDefault();
  var rb = renderArea.getBoundingClientRect();
  _box.active = true;
  _box.drag = { x: e.clientX - rb.left, y: e.clientY - rb.top };
  _box.region = null;
}, true);

document.addEventListener('mousemove', function(e) {
  if (!_box.active || !_box.drag) return;
  var rb = renderArea.getBoundingClientRect();
  var cx = e.clientX - rb.left, cy = e.clientY - rb.top;
  _box.region = {
    x1: Math.min(_box.drag.x, cx), y1: Math.min(_box.drag.y, cy),
    x2: Math.max(_box.drag.x, cx), y2: Math.max(_box.drag.y, cy),
  };
  var r = _box.region;
  _boxEl.style.display = 'block';
  _boxEl.style.left = r.x1 + 'px'; _boxEl.style.top = r.y1 + 'px';
  _boxEl.style.width = (r.x2 - r.x1) + 'px'; _boxEl.style.height = (r.y2 - r.y1) + 'px';
});

document.addEventListener('mouseup', function(e) {
  if (!_box.active) return;
  _box.active = false; _box.drag = null;
  _boxEl.style.display = 'none';
  var r = _box.region; _box.region = null;
  if (!r || r.x2 - r.x1 < 6 || r.y2 - r.y1 < 6) return;
  showTooltip('Gathering region…');
  var ids = _gatherClustersInRect(r);
  if (!ids.length) { showTooltip('No points in region'); return; }
  showTooltip(ids.length + ' clusters in region');
  if (window.EXPLORE) EXPLORE.queryClusters(ids, 'region · ' + ids.length + ' clusters');
});

// no-op resize hook (Potree manages its own canvas)
function resizeRenderer() {}
