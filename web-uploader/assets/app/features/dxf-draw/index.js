// ── DXF Draw Feature Module V2 ──────────────────────────────────────────
// Line drawing on point clouds with snap-to-endpoint, linked drag,
// endpoint visibility toggle, color presets, continuous draw, and undo.

import {
  DRAW_SNAP_THRESHOLD_PX,
  EDIT_SNAP_THRESHOLD_PX,
  ENDPOINT_LINK_EPSILON,
  computeLineEndpoints,
  positionsCoincide,
  dedupeLinkEntries,
  clusterLinkEntries,
} from './topology.js';

const DEFAULT_COLOR = '#3399ff';
const DEFAULT_WIDTH = 2;
const DXF_ENDPOINT_RADIUS = 0.2;
const SHOW_AUTO_EXTRACT_UI = false;
const DRAW_COLORS = [
  '#3399ff', '#33cc33', '#ff3333', '#ff9900', '#cc33ff',
  '#00cccc', '#ffcc00', '#ff66b2', '#66ff66', '#ffffff',
];

// ── ACI color helpers ───────────────────────────────────────────────────
const ACI_REVERSE = new Map();
const ACI_RGB = new Map();
function initAciReverse(aciTable) {
  if (ACI_REVERSE.size && ACI_RGB.size) return;
  for (const [idx, hex] of Object.entries(aciTable)) {
    const normalized = String(hex).toLowerCase();
    const parsed = parseHexColor(normalized);
    ACI_REVERSE.set(normalized, Number(idx));
    if (parsed) ACI_RGB.set(Number(idx), parsed);
  }
}
function parseHexColor(hex) {
  const normalized = String(hex).trim().toLowerCase();
  const match = normalized.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return {
    hex: `#${match[1]}`,
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}
function nearestAci(hex, aciTable) {
  initAciReverse(aciTable);
  const target = parseHexColor(hex);
  if (!target || !ACI_RGB.size) return 7;
  let bestIdx = 7;
  let bestScore = Infinity;
  for (const [idx, rgb] of ACI_RGB.entries()) {
    const dr = rgb.r - target.r;
    const dg = rgb.g - target.g;
    const db = rgb.b - target.b;
    const score = dr * dr + dg * dg + db * db;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  return bestIdx;
}
function hexToAci(hex, aciTable) {
  initAciReverse(aciTable);
  const normalized = String(hex).toLowerCase();
  return ACI_REVERSE.get(normalized) ?? nearestAci(normalized, aciTable);
}
function hexToTrueColor(hex) {
  const parsed = parseHexColor(hex);
  if (!parsed) return null;
  return (parsed.r << 16) | (parsed.g << 8) | parsed.b;
}

// ── Minimal DXF writer ──────────────────────────────────────────────────
function buildDxfString(layers, aciTable, getExportEndpoints) {
  const out = [];
  const w = (s) => out.push(s);
  w('0'); w('SECTION'); w('2'); w('HEADER');
  w('9'); w('$ACADVER'); w('1'); w('AC1015');
  w('0'); w('ENDSEC');
  w('0'); w('SECTION'); w('2'); w('TABLES');
  w('0'); w('TABLE'); w('2'); w('LAYER');
  w('70'); w(String(layers.size));
  for (const [name, layer] of layers) {
    const aci = hexToAci(layer.color, aciTable);
    const trueColor = hexToTrueColor(layer.color);
    w('0'); w('LAYER'); w('2'); w(name); w('70'); w('0');
    w('62'); w(String(aci));
    if (trueColor != null) { w('420'); w(String(trueColor)); }
    w('6'); w('CONTINUOUS');
  }
  w('0'); w('ENDTAB'); w('0'); w('ENDSEC');
  w('0'); w('SECTION'); w('2'); w('ENTITIES');
  for (const [layerName, layer] of layers) {
    for (const line of layer.lines) {
      const ep = getExportEndpoints(line);
      if (!ep) continue;
      const aci = hexToAci(line.color, aciTable);
      const trueColor = hexToTrueColor(line.color);
      w('0'); w('LINE'); w('8'); w(layerName);
      w('62'); w(String(aci));
      if (trueColor != null) { w('420'); w(String(trueColor)); }
      w('10'); w(String(ep.p1.x)); w('20'); w(String(ep.p1.y)); w('30'); w(String(ep.p1.z));
      w('11'); w(String(ep.p2.x)); w('21'); w(String(ep.p2.y)); w('31'); w(String(ep.p2.z));
    }
  }
  w('0'); w('ENDSEC'); w('0'); w('EOF');
  return out.join('\n');
}

// ═════════════════════════════════════════════════════════════════════════
// Feature factory
// ═════════════════════════════════════════════════════════════════════════
export function createDxfDrawFeature({
  viewer, THREE, toast, escapeHtml, refreshSceneTree,
  setToolMode, getToolMode, formatLinearMeasurement, getAciTable,
  translate,
  translateText,
  getActiveDatasetContext,
} = {}) {

  // ── State ─────────────────────────────────────────────────────────────
  const layers = new Map();
  let activeLayer = 'Default';
  let nextLineId = 1;
  let drawing = false;
  let pendingMeasure = null;
  let showEndpoints = false;
  let continuousDraw = false;
  const undoStack = [];          // line IDs in creation order
  const vertexLinks = new Map(); // sphereUuid → Set<{measure, index, sphere}>

  // ── Corner intersection state ──────────────────────────────────────
  let ciState = 'INACTIVE';      // INACTIVE | PICKING_WALL_A | PICKING_WALL_B
  let ciWallA = null;            // { p1: Vector3, p2: Vector3 }
  let ciCorners = [];            // accumulated corner Vector3 positions
  let ciFirstCorner = null;      // for loop closure
  let ciPlaneZ = null;           // session-wide horizontal plane height
  let ciHelpers = [];            // fat-line helpers to cleanup
  let ciPickSession = null;      // active wall-pick listeners / temp measure
  let ciFirstLineEntry = null;   // first committed corner segment
  let ciPrevLineEntry = null;    // previous line entry for vertex linking
  let ciStyleSnapshot = null;    // locked layer/color/width for current CI session
  let activeDrawSession = null;  // active free / constrained drawing session
  let pendingDrawMode = null;    // free | vertical | horizontal | corner
  let controlsBound = false;
  let selectedLineId = null;
  let pointerDownPos = null;
  let continuousDrawTimer = null;
  let floorplanLoading = false;
  let floorplanResult = null;
  let floorplanPreviewVisible = true;
  let floorplanPreviewObjects = [];
  let floorplanSourceMode = 'active';
  let floorplanConfig = {
    zCenter: 1.2,
    thickness: 0.12,
    minWallLength: 1.2,
    mergeTolerance: 0.18,
    autoAlign: true,
    orthogonalOnly: true,
  };

  function ensureLayer(name) {
    if (!layers.has(name)) {
      layers.set(name, { color: DEFAULT_COLOR, lineWidth: DEFAULT_WIDTH, visible: true, lines: [] });
    }
    return layers.get(name);
  }
  ensureLayer(activeLayer);

  function tt(text) {
    return typeof translateText === 'function' ? translateText(text) : text;
  }

  function tk(key, fallback, vars = {}) {
    return typeof translate === 'function' ? translate(key, vars, fallback) : tt(fallback);
  }

  function formatCountLabel(count, unitText) {
    return `${count} ${tt(unitText)}`;
  }

  function getAllLines() {
    const all = [];
    for (const [, layer] of layers) all.push(...layer.lines);
    return all;
  }

  function findLine(lineId) {
    for (const [, layer] of layers) {
      const l = layer.lines.find(x => x.id === lineId);
      if (l) return l;
    }
    return null;
  }

  function applyLineVisualState(line, selected = false) {
    if (!line?.measure) return;
    const baseColor = new THREE.Color(selected ? '#ffd54f' : line.color);
    const baseWidth = selected ? Math.max(line.lineWidth + 1, 4) : line.lineWidth;
    line.measure.color = baseColor;
    line.measure.edges?.forEach(e => {
      if (e.material) {
        e.material.color.copy(baseColor);
        e.material.linewidth = baseWidth;
        e.material.opacity = 1;
        e.material.transparent = false;
      }
    });
    line.measure.spheres?.forEach(s => {
      if (s.material) {
        s.material.color.copy(baseColor);
        s.material.emissive?.setHex(selected ? 0xffd54f : 0x000000);
      }
    });
  }

  function setSelectedLine(lineId, { render = true } = {}) {
    if (selectedLineId === lineId) return;
    const previous = findLine(selectedLineId);
    if (previous) applyLineVisualState(previous, false);
    selectedLineId = lineId ?? null;
    const current = findLine(selectedLineId);
    if (current) applyLineVisualState(current, true);
    if (render) {
      renderPanel();
      refreshSceneTree?.();
    }
  }

  function clearSelectedLine(options) {
    setSelectedLine(null, options);
  }

  // ── Constrained endpoint computation ──────────────────────────────────
  // draggedIndex: which point was just dragged
  //   -1 = initial finalize after drawing (use pt 0 as reference — the first click)
  //    0 or 1 = editing drag (use the dragged point as reference — moves the whole line)
  function getExportEndpoints(line, draggedIndex = -1) {
    const pts = line.measure?.points;
    if (!pts || pts.length < 2) return null;
    return computeLineEndpoints(line.lineType, pts[0].position, pts[1].position, draggedIndex);
  }

  // ── 2D line intersection (XY plane) ─────────────────────────────────
  function intersect2DLines(a1, a2, b1, b2) {
    const dAx = a2.x - a1.x, dAy = a2.y - a1.y;
    const dBx = b2.x - b1.x, dBy = b2.y - b1.y;
    const denom = dAx * dBy - dAy * dBx;
    if (Math.abs(denom) < 1e-10) return null; // parallel
    const t = ((b1.x - a1.x) * dBy - (b1.y - a1.y) * dBx) / denom;
    return new THREE.Vector3(
      a1.x + t * dAx,
      a1.y + t * dAy,
      a1.z
    );
  }

  function constrainPointToPlane(point, z) {
    return new THREE.Vector3(point.x, point.y, z);
  }

  function wallLength2D(p1, p2) {
    return Math.hypot(p2.x - p1.x, p2.y - p1.y);
  }

  function distance2D(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function isDefaultMeasurePoint(point) {
    if (!point?.position) return true;
    return point.position.lengthSq() < 1e-10;
  }

  function isCiActive() {
    return ciState !== 'INACTIVE';
  }

  function isEditingLocked() {
    return drawing || isCiActive();
  }

  function getCurrentStyleSnapshot() {
    const layer = ensureLayer(activeLayer);
    return {
      layerName: activeLayer,
      color: layer.color,
      lineWidth: layer.lineWidth,
    };
  }

  function getOverlayScene() {
    return viewer?.measuringTool?.scene || viewer?.scene?.scene;
  }

  function addOverlayObject(object) {
    const scene = getOverlayScene();
    if (scene && object) scene.add(object);
    return object;
  }

  function updateOverlayDotScale(dot) {
    if (!dot || !viewer?.scene || !viewer?.renderer) return;
    const camera = viewer.scene.getActiveCamera();
    const size = viewer.renderer.getSize(new THREE.Vector2());
    const distance = camera.position.distanceTo(dot.position);
    const projected = globalThis.Potree?.Utils?.projectedRadius?.(1, camera, distance, size.width, size.height);
    if (!projected) return;
    const scale = 15 / projected;
    dot.scale.setScalar(scale);
  }

  function removeOverlayObject(object) {
    if (!object) return;
    object.userData?.cleanup?.();
    object.parent?.remove(object);
    object.traverse?.((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) {
        child.material.forEach(m => m?.dispose?.());
      } else {
        child.material?.dispose?.();
      }
    });
  }

  function clearInputDrag(objectHint = null) {
    const dragObject = viewer?.inputHandler?.drag?.object;
    if (!viewer?.inputHandler) return;
    if (!dragObject || !objectHint || dragObject === objectHint) {
      viewer.inputHandler.startDragging(null);
    }
  }

  function clearContinuousDrawTimer() {
    if (continuousDrawTimer != null) {
      clearTimeout(continuousDrawTimer);
      continuousDrawTimer = null;
    }
  }

  function createOverlayDot(position, color) {
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.4, 10, 10),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(color), depthTest: false, depthWrite: false, transparent: true, opacity: 1 })
    );
    dot.position.copy(position);
    dot.renderOrder = 12;
    const onUpdate = () => updateOverlayDotScale(dot);
    viewer.addEventListener('update', onUpdate);
    dot.userData.cleanup = () => viewer.removeEventListener('update', onUpdate);
    updateOverlayDotScale(dot);
    return addOverlayObject(dot);
  }

  function applyMeasureEndpointRadius(measure) {
    if (!measure || !THREE?.SphereGeometry) return;
    const current = measure.sphereGeometry;
    const next = new THREE.SphereGeometry(DXF_ENDPOINT_RADIUS, 10, 10);
    measure.sphereGeometry = next;
    measure.spheres?.forEach((sphere) => {
      sphere.geometry = next;
    });
    if (current && current !== next) current.dispose?.();
  }

  function getMeasurePointPosition(measure, index) {
    return measure?.points?.[index]?.position || null;
  }

  function syncSphereToMeasurePoint(measure, index) {
    const sphere = measure?.spheres?.[index];
    const position = getMeasurePointPosition(measure, index);
    if (sphere && position) sphere.position.copy(position);
  }

  function setLinkGroup(entries = []) {
    const unique = dedupeLinkEntries(entries);
    for (const entry of unique) {
      vertexLinks.delete(entry.sphere.uuid);
    }
    if (unique.length <= 1) return;
    const group = new Set(unique);
    for (const entry of unique) {
      vertexLinks.set(entry.sphere.uuid, group);
    }
  }

  function repartitionLinkEntries(entries = []) {
    const unique = dedupeLinkEntries(entries);
    for (const entry of unique) {
      vertexLinks.delete(entry.sphere.uuid);
    }
    const clusters = clusterLinkEntries(unique, entry => getMeasurePointPosition(entry.measure, entry.index), ENDPOINT_LINK_EPSILON);
    for (const cluster of clusters) {
      setLinkGroup(cluster);
    }
  }

  function validateEndpointLinks(sphere) {
    const group = vertexLinks.get(sphere?.uuid);
    if (!group) return;
    repartitionLinkEntries(group);
  }

  function applyEndpointPosition(measure, index, position) {
    if (!measure || index < 0 || !position) return;
    measure.setPosition(index, position.clone());
    syncSphereToMeasurePoint(measure, index);
  }

  function getStoredSnapCandidate(sphere, measure) {
    const candidate = sphere?.__dxfSnapCandidate;
    if (!candidate) return null;
    if (candidate.measure === measure) return null;
    return candidate;
  }

  function commitEndpointTopology(measure, index, snap = null) {
    const sphere = measure?.spheres?.[index];
    if (!sphere) return;

    validateEndpointLinks(sphere);

    if (snap?.measure && snap.measure !== measure) {
      const targetSphere = snap.measure.spheres?.[snap.pointIndex];
      if (targetSphere) {
        linkEndpoints(sphere, measure, index, targetSphere, snap.measure, snap.pointIndex);
        validateEndpointLinks(sphere);
      }
    }
  }

  function createOverlayLine(color, opacity = 0.7) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      transparent: opacity < 1,
      opacity,
      depthTest: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 11;
    line.userData.isSimpleOverlayLine = true;
    return addOverlayObject(line);
  }

  function clearFloorplanPreview() {
    floorplanPreviewObjects.forEach(removeOverlayObject);
    floorplanPreviewObjects = [];
  }

  function renderFloorplanPreview(segments = floorplanResult?.segments || []) {
    clearFloorplanPreview();
    if (!floorplanPreviewVisible) return;
    for (const segment of segments) {
      const line = createOverlayLine(segment.orientation === 'vertical' ? '#5ad8a6' : '#7aa6ff', 0.95);
      setOverlayLinePositions(
        line,
        new THREE.Vector3(segment.p1.x, segment.p1.y, segment.p1.z),
        new THREE.Vector3(segment.p2.x, segment.p2.y, segment.p2.z)
      );
      floorplanPreviewObjects.push(line);
    }
  }

  function setOverlayLinePositions(line, p1, p2) {
    if (!line) return;
    if (line.userData?.isSimpleOverlayLine) {
      const positions = line.geometry.attributes.position.array;
      positions[0] = p1.x; positions[1] = p1.y; positions[2] = p1.z;
      positions[3] = p2.x; positions[4] = p2.y; positions[5] = p2.z;
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.computeBoundingSphere();
      return;
    }
    setFatLinePositions(line, p1, p2);
  }

  // ── Corner intersection helpers ─────────────────────────────────────
  function createWallHelper(p1, p2) {
    const dir = p2.clone().sub(p1);
    const len = dir.length();
    dir.normalize();
    const ext = Math.max(2, Math.min(50, len * 3));
    const start = p1.clone().sub(dir.clone().multiplyScalar(ext));
    const end = p2.clone().add(dir.clone().multiplyScalar(ext));
    const line = makeFatLine(0xaaaaaa, 2, 0.5);
    if (!line) return null;
    setFatLinePositions(line, start, end);
    viewer.measuringTool.scene.add(line);
    return line;
  }

  function cleanupCiHelpers() {
    for (const h of ciHelpers) {
      if (!h) continue;
      if (h.points && h.spheres) viewer.scene.removeMeasurement(h);
      else removeOverlayObject(h);
    }
    ciHelpers = [];
  }

  function disposeActiveDrawSession({ removeMeasure = false } = {}) {
    const session = activeDrawSession;
    activeDrawSession = null;
    pendingDrawMode = null;
    clearContinuousDrawTimer();
    if (!session) return;

    session.done = true;
    if (session.onMarkerAdded && session.measure) {
      session.measure.removeEventListener('marker_added', session.onMarkerAdded);
    }
    if (session.lastSphere && session.onDrop) {
      session.lastSphere.removeEventListener('drop', session.onDrop);
    }
    if (session.onUpdate) {
      viewer.removeEventListener('update', session.onUpdate);
    }
    if (session.onCancel) {
      viewer.removeEventListener('cancel_insertions', session.onCancel);
    }
    if (session.onMouseUp) {
      viewer.renderer?.domElement?.removeEventListener('mouseup', session.onMouseUp, true);
    }
    if (session.helper) {
      removeTriangleHelper(session.helper);
    }
    if (removeMeasure && session.measure) {
      clearInputDrag(session.lastSphere || session.measure);
      viewer.scene.removeMeasurement(session.measure);
    }
  }

  function resetCiState() {
    cleanupRoundVisuals();
    for (const m of (ciCornerMeasures || [])) removeDotMeasure(m);
    ciCornerMeasures = [];
    ciRoundVisuals = [];
    cleanupBPreview?.();
    ciIntersectPreview = null;
    ciState = 'INACTIVE';
    ciWallA = null;
    ciCorners = [];
    ciFirstCorner = null;
    ciPlaneZ = null;
    ciPickSession = null;
    ciFirstLineEntry = null;
    ciPrevLineEntry = null;
    ciStyleSnapshot = null;
    drawing = false;
    pendingDrawMode = null;
    renderPanel();
  }

  function disposeActiveCiPick({ resetState = false, keepCorners = true } = {}) {
    const session = ciPickSession;
    ciPickSession = null;

    if (session) {
      session.done = true;
      if (session.tempMeasure && session.onMarkerAdded) {
        session.tempMeasure.removeEventListener('marker_added', session.onMarkerAdded);
      }
      if (session.lastSphere && session.onDrop) {
        session.lastSphere.removeEventListener('drop', session.onDrop);
      }
      if (session.onUpdate) {
        viewer.removeEventListener('update', session.onUpdate);
      }
      if (session.onCancel) {
        viewer.removeEventListener('cancel_insertions', session.onCancel);
      }
      if (session.onMouseUp) {
        viewer.renderer?.domElement?.removeEventListener('mouseup', session.onMouseUp, true);
      }
      if (session.onMouseMove) {
        viewer.renderer?.domElement?.removeEventListener('mousemove', session.onMouseMove, true);
      }
      removeDotMeasure(session.previewMeasure);
      for (const dot of (session.dotMeasures || [])) removeDotMeasure(dot);
    }

    if (resetState) {
      if (!keepCorners) {
        resetCiState();
        return;
      }
      cleanupCiHelpers();
      ciState = 'INACTIVE';
      ciWallA = null;
      drawing = false;
      renderPanel();
    }
  }

  // Create a real DXF line between two corner points
  function createCornerLineSegment(from, to) {
    const style = ciStyleSnapshot || getCurrentStyleSnapshot();
    const layer = ensureLayer(style.layerName);
    const color = style.color;
    const MeasureCtor = globalThis.Potree?.Measure || viewer.scene.measurements?.[0]?.constructor;
    if (!MeasureCtor) {
      toast?.(tk('viewer.dxf.draw.errors.missingMeasureCtor', 'Unable to create corner segment: missing Measure constructor'), 'err');
      return null;
    }

    const measure = new MeasureCtor();
    if (!measure.userData) measure.userData = {};
    measure.userData.isDxfDraw = true;
    applyMeasureEndpointRadius(measure);
    measure.showDistances = false;
    measure.showArea = false;
    measure.showAngles = false;
    measure.showCoordinates = false;
    measure.showHeight = false;
    measure.showEdges = true;
    measure.closed = false;
    measure.maxMarkers = 2;
    measure.name = `${tk('viewer.dxf.draw.names.cornerLine', 'Corner Line')} ${nextLineId}`;
    viewer.scene.addMeasurement(measure);
    measure.addMarker(from.clone());
    measure.addMarker(to.clone());
    measure.setPosition(0, from.clone());
    measure.setPosition(1, to.clone());
    if (measure.spheres?.[0]) measure.spheres[0].position.copy(from);
    if (measure.spheres?.[1]) measure.spheres[1].position.copy(to);

    const c3 = new THREE.Color(color);
    measure.color = c3;
    measure.edges?.forEach(e => {
      e.visible = true;
      if (e.material) { e.material.color.copy(c3); e.material.linewidth = style.lineWidth; e.material.opacity = 1; e.material.transparent = false; }
    });
    measure.spheres?.forEach(s => {
      if (s.material) s.material.color.copy(c3);
      s.visible = showEndpoints;
    });
    measure.update?.();

    // Patch for snap + linked drag
    for (let si = 0; si < measure.spheres.length; si++) patchSphereDrag(measure, si);

    const lineEntry = { id: nextLineId++, layerName: style.layerName, measure, color, lineWidth: style.lineWidth, lineType: 'corner' };
    layer.lines.push(lineEntry);
    undoStack.push(lineEntry.id);

    if (!ciFirstLineEntry) {
      ciFirstLineEntry = lineEntry;
    }

    // Link to previous segment's shared corner
    if (ciPrevLineEntry) {
      const prevSphere1 = ciPrevLineEntry.measure.spheres[1]; // end of prev
      const currSphere0 = measure.spheres[0]; // start of current
      if (prevSphere1 && currSphere0) {
        linkEndpoints(currSphere0, measure, 0, prevSphere1, ciPrevLineEntry.measure, 1);
      }
    }

    ciPrevLineEntry = lineEntry;
    return lineEntry;
  }

  function createImportedLineSegment(from, to, {
    layerName = 'AutoFloorplan',
    color = '#5ad8a6',
    lineWidth = DEFAULT_WIDTH,
    lineType = 'auto-wall',
    namePrefix = tk('viewer.dxf.floorplan.autoWallName', 'Auto Wall'),
  } = {}) {
    const layer = ensureLayer(layerName);
    const MeasureCtor = globalThis.Potree?.Measure || viewer.scene.measurements?.[0]?.constructor;
    if (!MeasureCtor) return null;
    const measure = new MeasureCtor();
    if (!measure.userData) measure.userData = {};
    measure.userData.isDxfDraw = true;
    applyMeasureEndpointRadius(measure);
    measure.showDistances = false;
    measure.showArea = false;
    measure.showAngles = false;
    measure.showCoordinates = false;
    measure.showHeight = false;
    measure.showEdges = true;
    measure.closed = false;
    measure.maxMarkers = 2;
    measure.name = `${namePrefix} ${nextLineId}`;
    viewer.scene.addMeasurement(measure);
    measure.addMarker(from.clone());
    measure.addMarker(to.clone());
    measure.setPosition(0, from.clone());
    measure.setPosition(1, to.clone());
    const c3 = new THREE.Color(color);
    measure.color = c3;
    measure.edges?.forEach(e => {
      e.visible = true;
      if (e.material) {
        e.material.color.copy(c3);
        e.material.linewidth = lineWidth;
        e.material.opacity = 1;
        e.material.transparent = false;
      }
    });
    measure.spheres?.forEach(s => {
      if (s.material) s.material.color.copy(c3);
      s.visible = showEndpoints;
    });
    measure.update?.();
    for (let si = 0; si < measure.spheres.length; si++) patchSphereDrag(measure, si);
    const lineEntry = { id: nextLineId++, layerName, measure, color, lineWidth, lineType };
    layer.lines.push(lineEntry);
    undoStack.push(lineEntry.id);
    return lineEntry;
  }

  function makeDotMeasure(position, color) {
    return createOverlayDot(position, color || '#ffffff');
  }

  function removeDotMeasure(m) {
    removeOverlayObject(m);
  }

  function makePreviewMeasure() {
    return createOverlayLine(0xaaaaaa, 0.7);
  }

  // ── Per-round wall-pick reference visuals (cleaned each round)
  let ciRoundVisuals = [];  // Potree Measure objects for current-round wall previews + dots
  // Session-wide legacy corner dots (kept for cleanup only)
  let ciCornerMeasures = [];

  function cleanupRoundVisuals() {
    for (const m of ciRoundVisuals) removeDotMeasure(m);
    ciRoundVisuals = [];
    cleanupCiHelpers();
  }

  function getFloorplanSourceContext() {
    const context = typeof getActiveDatasetContext === 'function' ? getActiveDatasetContext() : null;
    if (!context) return null;
    if (floorplanSourceMode === 'active' || !context.projectId) {
      return context;
    }
    return { ...context, type: 'scanner', projectId: context.projectId };
  }

  function getFloorplanSourceLabel() {
    const context = getFloorplanSourceContext();
    if (!context) return tk('viewer.dxf.floorplan.noSource', 'No active point cloud');
    if (context.type === 'scanner') {
      return `${tk('viewer.dxf.floorplan.sourceScanner', 'Current scanner project')}: ${context.projectName || context.projectId}`;
    }
    return `${tk('viewer.dxf.floorplan.sourceCloud', 'Current point cloud')}: ${context.cloudName || tk('viewer.dxf.floorplan.unnamedCloud', 'Unnamed cloud')}`;
  }

  async function requestFloorplanExtraction() {
    const context = getFloorplanSourceContext();
    if (!context) {
      toast?.(tk('viewer.dxf.floorplan.errors.needSource', 'Load a point cloud first'), 'warn');
      return;
    }
    floorplanLoading = true;
    renderPanel();
    try {
      const response = await fetch('/api/floorplan/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: context.type === 'scanner' ? context.projectId : null,
          cloudName: context.cloudName || null,
          zCenter: floorplanConfig.zCenter,
          thickness: floorplanConfig.thickness,
          minWallLength: floorplanConfig.minWallLength,
          mergeTolerance: floorplanConfig.mergeTolerance,
          autoAlign: floorplanConfig.autoAlign,
          orthogonalOnly: floorplanConfig.orthogonalOnly,
          debugPreview: true,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || tk('viewer.dxf.floorplan.errors.extractFailed', 'Floorplan extraction failed'));
      }
      floorplanResult = payload;
      renderFloorplanPreview(payload.segments || []);
      toast?.(tk('viewer.dxf.floorplan.toasts.extracted', 'Extracted {{count}} candidate wall segments', {
        count: payload.segments?.length || 0,
      }), 'ok', 2500);
    } catch (error) {
      floorplanResult = null;
      clearFloorplanPreview();
      toast?.(`${tk('viewer.dxf.floorplan.errors.extractFailed', 'Floorplan extraction failed')}: ${error.message}`, 'err', 4200);
    } finally {
      floorplanLoading = false;
      renderPanel();
    }
  }

  function importFloorplanSegments() {
    const imported = importSegments(floorplanResult?.segments || [], {
      layerName: 'AutoFloorplan',
      color: '#5ad8a6',
      lineType: 'auto-wall',
      namePrefix: tk('viewer.dxf.floorplan.autoWallName', 'Auto Wall'),
    });
    if (!imported) {
      toast?.(tk('viewer.dxf.floorplan.errors.noSegments', 'There are no extracted segments to import'), 'warn');
      return;
    }
    activeLayer = 'AutoFloorplan';
    clearFloorplanPreview();
    toast?.(tk('viewer.dxf.floorplan.toasts.imported', 'Imported {{count}} wall candidates into DXF lines', { count: imported }), 'ok', 2500);
    renderPanel();
    refreshSceneTree?.();
  }

  function importSegments(segments = [], {
    layerName = 'AutoFloorplan',
    color = '#5ad8a6',
    lineType = 'auto-wall',
    namePrefix = tk('viewer.dxf.floorplan.autoWallName', 'Auto Wall'),
  } = {}) {
    if (!Array.isArray(segments) || !segments.length) return 0;
    const layer = ensureLayer(layerName);
    layer.color = color;
    let imported = 0;
    for (const segment of segments) {
      if (!segment?.p1 || !segment?.p2) continue;
      const created = createImportedLineSegment(
        new THREE.Vector3(segment.p1.x, segment.p1.y, segment.p1.z ?? 0),
        new THREE.Vector3(segment.p2.x, segment.p2.y, segment.p2.z ?? 0),
        { layerName, color, lineType, namePrefix }
      );
      if (created) imported += 1;
    }
    return imported;
  }

  // Pick exactly 2 points on a wall using raw mouseup + point cloud intersection.
  // opts.onFirstPoint(pt) called immediately after click 1 with 3D point.
  // On success: callback({ p1, p2, planeZ, previewMeasure, dotMeasures[] })
  // Caller owns previewMeasure + dotMeasures; they stay in scene until caller removes them.
  function pickWall(callback, onAbort, opts = {}) {
    const { planeZ = ciPlaneZ, onFirstPoint } = (typeof opts === 'number' ? { planeZ: opts } : opts);
    disposeActiveCiPick();

    const PotreeUtils = globalThis.Potree?.Utils;
    if (!PotreeUtils?.getMousePointCloudIntersection) {
      toast?.('Potree.Utils not available', 'err'); onAbort?.(); return;
    }
    const domEl = viewer.renderer?.domElement;
    if (!domEl) { onAbort?.(); return; }

    const layerColorHex = ensureLayer(activeLayer).color;
    const previewMeasure = makePreviewMeasure();
    const dotMeasures = [];

    const session = { done: false, onMouseUp: null, onMouseMove: null, onCancel: null, previewMeasure, dotMeasures };
    ciPickSession = session;

    const collectedPts = [];

    const _cleanupListeners = () => {
      if (session.onMouseUp) domEl.removeEventListener('mouseup', session.onMouseUp, true);
      if (session.onMouseMove) domEl.removeEventListener('mousemove', session.onMouseMove, true);
      if (session.onCancel) viewer.removeEventListener('cancel_insertions', session.onCancel);
    };

    const abortPick = () => {
      if (session.done) return;
      session.done = true;
      _cleanupListeners();
      removeDotMeasure(previewMeasure);
      for (const dm of dotMeasures) removeDotMeasure(dm);
      ciPickSession = null;
      onAbort?.();
    };

    const getIntersection = (e) => {
      const rect = domEl.getBoundingClientRect();
      return PotreeUtils.getMousePointCloudIntersection(
        new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top),
        viewer.scene.getActiveCamera(), viewer, viewer.scene.pointclouds, { pickClipped: true }
      );
    };

    // Mousemove: preview line from pt1 to cursor
    const onMouseMove = (e) => {
      if (session.done || collectedPts.length !== 1 || !previewMeasure) return;
      const I = getIntersection(e);
      if (!I?.location) return;
      const locked = planeZ ?? collectedPts[0].z;
      const cursor = constrainPointToPlane(I.location, locked);
      setOverlayLinePositions(previewMeasure, collectedPts[0], cursor);
    };
    session.onMouseMove = onMouseMove;
    domEl.addEventListener('mousemove', onMouseMove, true);

    const onMouseUp = (e) => {
      if (session.done) return;
      if (e.button === 2) { abortPick(); return; }
      if (e.button !== 0) return;

      const I = getIntersection(e);
      if (!I?.location) { toast?.(tk('viewer.dxf.draw.errors.pickOnPointCloud', 'Please click on the point cloud'), 'warn'); return; }

      const locked = planeZ ?? (collectedPts.length === 0 ? I.location.z : collectedPts[0].z);
      const pt = constrainPointToPlane(I.location, locked);
      collectedPts.push(pt);

      // Immediately show a properly-sized dot at clicked point
      const dm = makeDotMeasure(pt, layerColorHex);
      if (dm) dotMeasures.push(dm);

      if (collectedPts.length === 1) {
        onFirstPoint?.(pt);   // notify caller that pt1 is locked
        renderPanel();
        return;
      }

      // Got 2 points — finalize
      session.done = true;
      _cleanupListeners();
      ciPickSession = null;

      const p1 = collectedPts[0], p2 = collectedPts[1];
      if (wallLength2D(p1, p2) < 0.05) {
        toast?.(tk('viewer.dxf.draw.errors.wallTooShort', 'Points are too close. Pick two points farther apart along the wall'), 'warn');
        removeDotMeasure(previewMeasure);
        for (const dm of dotMeasures) removeDotMeasure(dm);
        onAbort?.(); return;
      }

      // Finalize preview line to exact p1/p2
      if (previewMeasure) setOverlayLinePositions(previewMeasure, p1, p2);

      callback({ p1, p2, planeZ: locked, previewMeasure, dotMeasures });
    };
    session.onMouseUp = onMouseUp;
    domEl.addEventListener('mouseup', session.onMouseUp, true);

    const onCancel = () => abortPick();
    session.onCancel = onCancel;
    viewer.addEventListener('cancel_insertions', onCancel);
  }



  function startDrawCornerIntersection() {
    if (drawing || ciState !== 'INACTIVE') return;
    drawing = true;
    pendingDrawMode = 'corner';
    ciState = 'PICKING_WALL_A';
    ciCorners = [];
    ciFirstCorner = null;
    ciPlaneZ = null;
    ciFirstLineEntry = null;
    ciPrevLineEntry = null;
    ciStyleSnapshot = getCurrentStyleSnapshot();
    ciRoundVisuals = [];
    ciCornerMeasures = [];
    cleanupCiHelpers();
    renderPanel();
    pickWallA();
  }

  function pickWallA() {
    ciState = 'PICKING_WALL_A';
    renderPanel();
    pickWall((wall) => {
      ciPlaneZ = wall.planeZ;
      ciWallA = wall;
      // Keep wall A visuals as round reference
      if (wall.previewMeasure) ciRoundVisuals.push(wall.previewMeasure);
      for (const dm of (wall.dotMeasures || [])) ciRoundVisuals.push(dm);
      // Extension helper fat line
      const helper = createWallHelper(wall.p1, wall.p2);
      if (helper) ciHelpers.push(helper);
      pickWallB();
    }, () => {
      resetCiState();
    });
  }

  // Real-time intersection preview while picking wall B
  let ciIntersectPreview = null;  // 1-point Measure dot at predicted corner

  function cleanupBPreview() {
    removeDotMeasure(ciIntersectPreview);
    ciIntersectPreview = null;
  }

  function pickWallB() {
    ciState = 'PICKING_WALL_B';
    renderPanel();

    let wallBPt1 = null;
    const domEl = viewer.renderer?.domElement;
    const PotreeUtils = globalThis.Potree?.Utils;

    const intersectPreviewMove = (e) => {
      if (!wallBPt1 || !ciWallA || !domEl || !PotreeUtils) return;
      const rect = domEl.getBoundingClientRect();
      const I = PotreeUtils.getMousePointCloudIntersection(
        new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top),
        viewer.scene.getActiveCamera(), viewer, viewer.scene.pointclouds, { pickClipped: true }
      );
      if (!I?.location) return;
      const cursor = constrainPointToPlane(I.location, ciPlaneZ);
      const corner = intersect2DLines(ciWallA.p1, ciWallA.p2, wallBPt1, cursor);
      if (!corner) { cleanupBPreview(); return; }
      if (!ciIntersectPreview) {
        ciIntersectPreview = makeDotMeasure(corner, '#ffff00');
      } else {
        ciIntersectPreview.position.copy(corner);
      }
    };
    domEl?.addEventListener('mousemove', intersectPreviewMove, true);

    pickWall((wall) => {
      domEl?.removeEventListener('mousemove', intersectPreviewMove, true);
      cleanupBPreview();
      const helper = createWallHelper(wall.p1, wall.p2);
      if (helper) ciHelpers.push(helper);

      // Compute intersection
      const corner = intersect2DLines(ciWallA.p1, ciWallA.p2, wall.p1, wall.p2);
      if (!corner) {
        toast?.(tk('viewer.dxf.draw.errors.parallelWalls', 'The two wall lines are parallel, so no intersection can be computed'), 'warn');
        removeDotMeasure(wall.previewMeasure);
        for (const dm of (wall.dotMeasures || [])) removeDotMeasure(dm);
        if (helper) removeOverlayObject(helper);
        ciHelpers = ciHelpers.filter(h => h !== helper);
        pickWallB(); return;
      }
      const lenA = wallLength2D(ciWallA.p1, ciWallA.p2);
      const lenB = wallLength2D(wall.p1, wall.p2);
      const distFromA = Math.min(distance2D(corner, ciWallA.p1), distance2D(corner, ciWallA.p2));
      const distFromB = Math.min(distance2D(corner, wall.p1), distance2D(corner, wall.p2));
      if (distFromA > lenA * 8 || distFromB > lenB * 8) {
        toast?.(tk('viewer.dxf.draw.errors.intersectionTooFar', 'The intersection is too far from the current wall picks. Please pick again'), 'warn');
        removeDotMeasure(wall.previewMeasure);
        for (const dm of (wall.dotMeasures || [])) removeDotMeasure(dm);
        if (helper) removeOverlayObject(helper);
        ciHelpers = ciHelpers.filter(h => h !== helper);
        pickWallB(); return;
      }

      // Keep wall B visuals as round reference
      if (wall.previewMeasure) ciRoundVisuals.push(wall.previewMeasure);
      for (const dm of (wall.dotMeasures || [])) ciRoundVisuals.push(dm);

      // Record corner
      ciCorners.push(corner);
      if (!ciFirstCorner) ciFirstCorner = corner.clone();

      // Create DXF line between consecutive corners
      if (ciCorners.length >= 2) {
        createCornerLineSegment(ciCorners[ciCorners.length - 2], corner);
        refreshSceneTree?.();
      }
      toast?.(tk('viewer.dxf.draw.toasts.cornerConfirmed', 'Corner {{count}} confirmed', { count: ciCorners.length }), 'info', 1200);

      // Clean round: only remove wall-pick previews, keep corner dots
      cleanupRoundVisuals();

      // Wall B becomes new wall A
      ciWallA = { p1: constrainPointToPlane(wall.p1, ciPlaneZ), p2: constrainPointToPlane(wall.p2, ciPlaneZ) };
      const newHelper = createWallHelper(wall.p1, wall.p2);
      if (newHelper) ciHelpers.push(newHelper);

      renderPanel();
      pickWallB();
    }, () => {
      domEl?.removeEventListener('mousemove', intersectPreviewMove, true);
      cleanupBPreview();
      disposeActiveCiPick();
      if (ciCorners.length === 0) {
        resetCiState();
      } else {
        cleanupRoundVisuals();
        ciState = 'INACTIVE';
        ciWallA = null;
        drawing = false;
        renderPanel();
      }
    }, { planeZ: ciPlaneZ, onFirstPoint: (pt) => { wallBPt1 = pt; } });
  }




  function closeCornerLoop() {
    if (ciCorners.length < 3 || !ciFirstCorner) return;
    disposeActiveCiPick();
    // Draw closing segment from last corner to first corner
    const lastCorner = ciCorners[ciCorners.length - 1];
    const closingLine = createCornerLineSegment(lastCorner, ciFirstCorner);

    if (closingLine?.measure?.spheres?.[1] && ciFirstLineEntry?.measure?.spheres?.[0]) {
      linkEndpoints(
        closingLine.measure.spheres[1],
        closingLine.measure, 1,
        ciFirstLineEntry.measure.spheres[0],
        ciFirstLineEntry.measure, 0
      );
    }

    refreshSceneTree?.();
    toast?.(tk('viewer.dxf.draw.toasts.loopClosed', 'Closed loop with {{count}} corners', { count: ciCorners.length }), 'info');
    resetCiState();
  }

  function finishCornerIntersection() {
    disposeActiveCiPick();
    if (ciCorners.length > 0) {
      toast?.(tk('viewer.dxf.draw.toasts.finishedCorners', 'Finished with {{count}} corners', { count: ciCorners.length }), 'info');
    }
    resetCiState();
  }

  // ── Snap-to-endpoint ──────────────────────────────────────────────────
  function getSnapThresholdForMeasure(measure) {
    return pendingMeasure === measure ? DRAW_SNAP_THRESHOLD_PX : EDIT_SNAP_THRESHOLD_PX;
  }

  function findNearestEndpoint(screenX, screenY, excludeMeasure, thresholdPx = EDIT_SNAP_THRESHOLD_PX) {
    const camera = viewer.scene.getActiveCamera();
    const domEl = viewer.renderer.domElement;
    const w = domEl.clientWidth, h = domEl.clientHeight;
    let best = null, bestDist = Infinity;
    for (const line of getAllLines()) {
      if (line.measure === excludeMeasure) continue;
      for (let pi = 0; pi < line.measure.points.length; pi++) {
        const pos = line.measure.points[pi].position;
        const ndc = pos.clone().project(camera);
        const sx = (ndc.x + 1) * w / 2;
        const sy = (-ndc.y + 1) * h / 2;
        const dist = Math.hypot(sx - screenX, sy - screenY);
        if (dist < thresholdPx && dist < bestDist) {
          bestDist = dist;
          best = { position: pos.clone(), measure: line.measure, line, pointIndex: pi };
        }
      }
    }
    return best;
  }

  function pointToSegmentDistance(screenX, screenY, ax, ay, bx, by) {
    const abx = bx - ax;
    const aby = by - ay;
    const abLenSq = abx * abx + aby * aby;
    if (abLenSq === 0) return Math.hypot(screenX - ax, screenY - ay);
    const t = Math.max(0, Math.min(1, ((screenX - ax) * abx + (screenY - ay) * aby) / abLenSq));
    const px = ax + abx * t;
    const py = ay + aby * t;
    return Math.hypot(screenX - px, screenY - py);
  }

  function findLineAtScreenPoint(screenX, screenY) {
    const camera = viewer.scene.getActiveCamera();
    const domEl = viewer.renderer.domElement;
    const w = domEl.clientWidth;
    const h = domEl.clientHeight;
    let best = null;
    let bestDist = Infinity;
    for (const line of getAllLines()) {
      if (!line.measure?.visible) continue;
      const ep = getExportEndpoints(line);
      if (!ep) continue;
      const p1 = new THREE.Vector3(ep.p1.x, ep.p1.y, ep.p1.z).project(camera);
      const p2 = new THREE.Vector3(ep.p2.x, ep.p2.y, ep.p2.z).project(camera);
      const ax = (p1.x + 1) * w / 2;
      const ay = (-p1.y + 1) * h / 2;
      const bx = (p2.x + 1) * w / 2;
      const by = (-p2.y + 1) * h / 2;
      const dist = pointToSegmentDistance(screenX, screenY, ax, ay, bx, by);
      if (dist < 10 && dist < bestDist) {
        bestDist = dist;
        best = line;
      }
    }
    return best;
  }

  // ── Vertex linking (topology) ─────────────────────────────────────────
  function linkEndpoints(sphereA, measureA, idxA, sphereB, measureB, idxB) {
    const entryA = { measure: measureA, index: idxA, sphere: sphereA };
    const entryB = { measure: measureB, index: idxB, sphere: sphereB };
    const groupA = vertexLinks.get(sphereA.uuid);
    const groupB = vertexLinks.get(sphereB.uuid);
    setLinkGroup([...(groupA || []), ...(groupB || []), entryA, entryB]);
  }

  function propagateDrag(draggedSphere, newPosition) {
    const group = vertexLinks.get(draggedSphere.uuid);
    if (!group) return;
    for (const entry of group) {
      if (entry.sphere === draggedSphere) continue;
      applyEndpointPosition(entry.measure, entry.index, newPosition);
    }
  }

  function unlinkSphere(sphere) {
    const group = vertexLinks.get(sphere.uuid);
    if (!group) return;
    repartitionLinkEntries([...(group || [])].filter(entry => entry.sphere !== sphere));
  }

  // ── Patch sphere drag to support snap + linked drag ───────────────────
  function patchSphereDrag(measure, sphereIndex) {
    const sphere = measure.spheres[sphereIndex];
    if (!sphere || sphere.__dxfDragPatched) return;
    sphere.__dxfDragPatched = true;
    sphere.addEventListener('drag', (e) => {
      const mx = e.drag.end.x, my = e.drag.end.y;
      const idx = measure.spheres.indexOf(e.drag.object);
      const snap = findNearestEndpoint(mx, my, measure, getSnapThresholdForMeasure(measure));
      sphere.__dxfSnapCandidate = snap || null;
      if (snap) {
        if (sphere.material) sphere.material.emissive.setHex(0x00ffff);
        if (pendingMeasure === measure && idx !== -1 && !sphere.__dxfConstrained) {
          applyEndpointPosition(measure, idx, snap.position);
        }
      } else {
        if (sphere.material) sphere.material.emissive.setHex(0x000000);
      }

      if (sphere.__dxfConstrained) return;

      // Propagate to linked endpoints
      if (idx !== -1) {
        propagateDrag(e.drag.object, measure.points[idx].position);
      }
    });

    // On drop: check if we should create a link
    sphere.addEventListener('drop', (e) => {
      const idx = measure.spheres.indexOf(e.drag.object);
      if (idx === -1) return;
      if (sphere.material) sphere.material.emissive.setHex(0x000000);
      if (sphere.__dxfConstrained) return;
      const snap = getStoredSnapCandidate(sphere, measure) || findNearestEndpoint(
        e.drag.end.x,
        e.drag.end.y,
        measure,
        getSnapThresholdForMeasure(measure)
      );
      sphere.__dxfSnapCandidate = null;
      if (snap && snap.measure !== measure) {
        applyEndpointPosition(measure, idx, snap.position);
      }
      commitEndpointTopology(measure, idx, snap);
    });
  }

  // ── Drawing ──────────────────────────────────────────────────────────
  function startDrawLine(snapToPosition) {
    if (drawing) return;
    if (!viewer?.measuringTool) { toast?.(tk('viewer.dxf.draw.errors.viewerNotReady', 'Viewer not ready'), 'err'); return; }

    drawing = true;
    pendingDrawMode = 'free';
    const layer = ensureLayer(activeLayer);
    const color = layer.color;
    const MeasureCtor = globalThis.Potree?.Measure || viewer.scene.measurements?.[0]?.constructor;
    let measure = null;
    let isContinuation = Boolean(snapToPosition && MeasureCtor);

    if (isContinuation) {
      measure = new MeasureCtor();
      if (!measure.userData) measure.userData = {};
      measure.userData.isDxfDraw = true;
      applyMeasureEndpointRadius(measure);
      measure.showDistances = false;
      measure.showArea = false;
      measure.showAngles = false;
      measure.showCoordinates = false;
      measure.showHeight = false;
      measure.showEdges = true;
      measure.closed = false;
      measure.maxMarkers = 2;
      measure.name = `${tk('viewer.dxf.draw.names.line', 'Line')} ${nextLineId}`;
      viewer.scene.addMeasurement(measure);
      measure.addMarker(snapToPosition.clone());
      measure.addMarker(snapToPosition.clone());
      measure.setPosition(0, snapToPosition.clone());
      measure.setPosition(1, snapToPosition.clone());
      if (measure.spheres?.[0]) measure.spheres[0].position.copy(snapToPosition);
      if (measure.spheres?.[1]) measure.spheres[1].position.copy(snapToPosition);
    } else {
      measure = viewer.measuringTool.startInsertion({
        showDistances: false, showArea: false, showAngles: false,
        showCoordinates: false, showHeight: false, showEdges: true,
        closed: false, maxMarkers: 2, name: `${tk('viewer.dxf.draw.names.line', 'Line')} ${nextLineId}`,
      });
      if (!measure.userData) measure.userData = {};
      measure.userData.isDxfDraw = true;
      applyMeasureEndpointRadius(measure);
    }

    // Style edges + spheres to layer color
    const c3 = new THREE.Color(color);
    measure.color = c3;
    measure.edges?.forEach(e => { if (e.material) { e.material.color.copy(c3); e.material.linewidth = layer.lineWidth; } });
    measure.spheres?.forEach(s => { if (s.material) s.material.color.copy(c3); });

    pendingMeasure = measure;
    const lineEntry = { id: nextLineId++, layerName: activeLayer, measure, color, lineWidth: layer.lineWidth, lineType: 'free' };

    // If snapping to a previous endpoint (continuous draw), set first point
    let snapDoneForFirst = false;
    if (snapToPosition) {
      measure.setPosition(0, snapToPosition.clone());
      snapDoneForFirst = true;
    }

    // Patch sphere drag for snap + linked drag
    for (let si = 0; si < measure.spheres.length; si++) {
      patchSphereDrag(measure, si);
    }

    const finalizeLine = () => {
      drawing = false;
      pendingMeasure = null;
      disposeActiveDrawSession();
      layer.lines.push(lineEntry);
      undoStack.push(lineEntry.id);

      if (!showEndpoints) {
        measure.spheres.forEach(s => { s.visible = false; });
      }

      if (snapDoneForFirst && snapToPosition && !isContinuation) {
        const snap = findNearestEndpointByPosition(snapToPosition, measure);
        if (snap) {
          linkEndpoints(measure.spheres[0], measure, 0,
            snap.measure.spheres[snap.pointIndex], snap.measure, snap.pointIndex);
        }
      }

      renderPanel();
      refreshSceneTree?.();

      if (continuousDraw) {
        const lastPos = measure.points[1]?.position?.clone();
        if (lastPos) {
          clearContinuousDrawTimer();
          continuousDrawTimer = setTimeout(() => {
            continuousDrawTimer = null;
            startDrawLine(lastPos);
          }, 50);
        }
      }
    };

    const onMarkerAdded = () => {
      for (let si = 0; si < measure.spheres.length; si++) {
        patchSphereDrag(measure, si);
      }
      if (measure.points.length >= 2) {
        measure.removeEventListener('marker_added', onMarkerAdded);
        const lastSphere = measure.spheres[measure.spheres.length - 1];
        const onDrop = () => {
          lastSphere.removeEventListener('drop', onDrop);
          finalizeLine();
        };
        lastSphere.addEventListener('drop', onDrop);
        if (activeDrawSession) {
          activeDrawSession.lastSphere = lastSphere;
          activeDrawSession.onDrop = onDrop;
        }
      }
    };
    activeDrawSession = { measure, onMarkerAdded, onCancel: null, onMouseUp: null, onDrop: null, lastSphere: null, done: false };
    if (!isContinuation) {
      measure.addEventListener('marker_added', onMarkerAdded);
    } else {
      const lastSphere = measure.spheres[measure.spheres.length - 1];
      const onDrop = () => {
        lastSphere.removeEventListener('drop', onDrop);
        finalizeLine();
      };
      lastSphere.addEventListener('drop', onDrop);
      activeDrawSession.lastSphere = lastSphere;
      activeDrawSession.onDrop = onDrop;
      viewer.inputHandler.startDragging(lastSphere);
    }

    const cancelLine = () => {
      if (pendingMeasure !== measure) return;
      drawing = false;
      pendingMeasure = null;
      clearInputDrag(activeDrawSession?.lastSphere || measure);
      disposeActiveDrawSession({ removeMeasure: true });
      renderPanel();
    };

    const onCancel = () => cancelLine();
    const onMouseUp = (e) => {
      if (e.button === 2 && pendingMeasure === measure) {
        e.preventDefault();
        e.stopImmediatePropagation?.();
        e.stopPropagation();
        cancelLine();
      }
    };
    activeDrawSession.onCancel = onCancel;
    activeDrawSession.onMouseUp = onMouseUp;
    viewer.addEventListener('cancel_insertions', onCancel);
    viewer.renderer?.domElement?.addEventListener('mouseup', onMouseUp, true);

    if (isContinuation && snapToPosition) {
      const snap = findNearestEndpointByPosition(snapToPosition, measure);
      if (snap) {
        linkEndpoints(measure.spheres[0], measure, 0,
          snap.measure.spheres[snap.pointIndex], snap.measure, snap.pointIndex);
      }
    }
    renderPanel();
  }

  // ── Constrained line drawing (vertical / horizontal) ────────────────
  // Self-built triangle helper using Line2/LineGeometry/LineMaterial
  // (grabbed from Potree's measure edges at runtime for proper line width).
  // Rendered via viewer's perspective_overlay pass to avoid EDL occlusion.

  let _Line2Ctor = null, _LineGeoCtor = null, _LineMatCtor = null;

  function ensureLine2Ctors() {
    if (_Line2Ctor) return true;
    // Grab constructors from any existing Potree measure edge
    const measures = viewer.scene.measurements || [];
    for (const m of measures) {
      if (m.edges?.[0]) {
        const edge = m.edges[0];
        _Line2Ctor = edge.constructor;
        _LineGeoCtor = edge.geometry.constructor;
        _LineMatCtor = edge.material.constructor;
        return true;
      }
    }
    return false;
  }

  function makeFatLine(color, linewidth, opacity) {
    if (!ensureLine2Ctors()) return createOverlayLine(color, opacity ?? 1);
    const geo = new _LineGeoCtor();
    geo.setPositions([0, 0, 0, 0, 0, 0]);
    const mat = new _LineMatCtor({
      color, linewidth: linewidth || 2,
      resolution: new THREE.Vector2(1000, 1000),
      depthTest: false, transparent: opacity < 1,
      opacity: opacity ?? 1,
    });
    const line = new _Line2Ctor(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 10;
    return line;
  }

  function setFatLinePositions(line, p1, p2) {
    if (!line) return;
    if (line.userData?.isSimpleOverlayLine) {
      setOverlayLinePositions(line, p1, p2);
      return;
    }
    line.geometry.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);
    line.geometry.verticesNeedUpdate = true;
    line.geometry.computeBoundingSphere();
    line.computeLineDistances();
    // Update resolution for proper rendering
    const size = viewer.renderer.getSize(new THREE.Vector2());
    line.material.resolution.set(size.width, size.height);
  }

  function createTriangleHelper(color) {
    const group = new THREE.Group();
    group.name = 'dxf_triangle_helper';

    // Hypotenuse: dim dashed line
    const hyp = makeFatLine(0xaaaaaa, 2, 0.7);
    // Vertical leg: dim dashed line
    const vert = makeFatLine(0xaaaaaa, 2, 0.7);
    // Horizontal leg: dim dashed line
    const horiz = makeFatLine(0xaaaaaa, 2, 0.7);
    // Constrained leg: solid line in layer color
    const constrained = makeFatLine(new THREE.Color(color), 3, 1.0);

    if (!hyp) return null; // Line2 constructors not available yet

    group.userData = { hyp, vert, horiz, constrained };
    group.add(hyp, vert, horiz, constrained);
    group.visible = false;

    // Add to measuringTool.scene for overlay rendering (avoids EDL)
    viewer.measuringTool.scene.add(group);
    return group;
  }

  function updateTriangleHelper(helper, a, b, lineType, color) {
    if (!helper) return;
    // Corner: projection of b onto the constraint plane through a
    // Horizontal: corner = (b.x, b.y, a.z) — below/above b at a's height
    // Vertical:   corner = (a.x, a.y, b.z) — below/above a at b's height
    const corner = lineType === 'horizontal'
      ? new THREE.Vector3(b.x, b.y, a.z)
      : new THREE.Vector3(a.x, a.y, b.z);

    const { hyp, vert, horiz, constrained } = helper.userData;
    // Hypotenuse: a → b
    setFatLinePositions(hyp, a, b);
    // Vertical leg: corner → b
    setFatLinePositions(vert, corner, b);
    // Horizontal leg: a → corner
    setFatLinePositions(horiz, a, corner);
    // Constrained leg (the line that will be kept): a → corner
    setFatLinePositions(constrained, a, corner);
    if (constrained?.material) constrained.material.color.set(color);

    helper.visible = true;
  }

  function removeTriangleHelper(helper) {
    if (!helper) return;
    helper.parent?.remove(helper);
    helper.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  function startDrawConstrained(lineType) {
    if (drawing) return;
    if (!viewer?.measuringTool) { toast?.(tk('viewer.dxf.draw.errors.viewerNotReady', 'Viewer not ready'), 'err'); return; }

    drawing = true;
    pendingDrawMode = lineType;
    const layer = ensureLayer(activeLayer);
    const color = layer.color;
    const label = lineType === 'vertical'
      ? tk('viewer.dxf.draw.tool.vertical', 'Vertical')
      : tk('viewer.dxf.draw.tool.horizontal', 'Horizontal');

    // Use a plain measure — no showHeight, no showEdges (we draw our own)
    const measure = viewer.measuringTool.startInsertion({
      showDistances: false, showArea: false, showAngles: false,
      showCoordinates: false, showHeight: false, showEdges: false,
      closed: false, maxMarkers: 2, name: `${label} ${nextLineId}`,
    });
    if (!measure.userData) measure.userData = {};
    measure.userData.isDxfDraw = true;
    applyMeasureEndpointRadius(measure);

    const c3 = new THREE.Color(color);
    measure.color = c3;
    measure.spheres?.forEach(s => { if (s.material) s.material.color.copy(c3); });

    // Create triangle helper (already added to measuringTool.scene internally)
    const helper = createTriangleHelper(color);

    // Update helper on every viewer update
    const onUpdate = () => {
      if (measure.points.length >= 2) {
        const a = measure.points[0].position;
        const b = measure.points[1].position;
        updateTriangleHelper(helper, a, b, lineType, color);
        if (helper) helper.visible = true;
      } else if (helper) {
        helper.visible = false;
      }
    };
    viewer.addEventListener('update', onUpdate);

    pendingMeasure = measure;
    const lineEntry = {
      id: nextLineId++, layerName: activeLayer, measure, color,
      lineWidth: layer.lineWidth, lineType,
    };

    for (let si = 0; si < measure.spheres.length; si++) {
      patchSphereDrag(measure, si);
    }

    const onMarkerAdded = () => {
      for (let si = 0; si < measure.spheres.length; si++) {
        patchSphereDrag(measure, si);
      }
      if (measure.points.length >= 2) {
        measure.removeEventListener('marker_added', onMarkerAdded);

        // Don't finalize yet — the second sphere is still being dragged.
        // Wait for the second sphere's drop event to finalize.
        const lastSphere = measure.spheres[measure.spheres.length - 1];
        const onSecondDrop = () => {
          lastSphere.removeEventListener('drop', onSecondDrop);
          drawing = false;
          pendingMeasure = null;
          disposeActiveDrawSession();

          finalizeConstrainedLine(measure, lineEntry);

          layer.lines.push(lineEntry);
          undoStack.push(lineEntry.id);

          if (!showEndpoints) {
            measure.spheres.forEach(s => { s.visible = false; });
          }

          renderPanel();
          refreshSceneTree?.();
          toast?.(`${label} ${tt('added')}`, 'info', 1200);
        };
        lastSphere.addEventListener('drop', onSecondDrop);
        if (activeDrawSession) {
          activeDrawSession.lastSphere = lastSphere;
          activeDrawSession.onDrop = onSecondDrop;
        }
      }
    };
    measure.addEventListener('marker_added', onMarkerAdded);

    const cancelConstrained = () => {
      if (pendingMeasure !== measure) return;
      drawing = false;
      pendingMeasure = null;
      clearInputDrag(activeDrawSession?.lastSphere || measure);
      disposeActiveDrawSession({ removeMeasure: true });
      renderPanel();
    };
    const onCancel = () => cancelConstrained();
    const onMouseUp = (e) => {
      if (e.button === 2 && pendingMeasure === measure) {
        e.preventDefault();
        e.stopImmediatePropagation?.();
        e.stopPropagation();
        cancelConstrained();
      }
    };
    activeDrawSession = {
      measure, helper, onUpdate, onMarkerAdded, onCancel, onMouseUp,
      onDrop: null, lastSphere: null, done: false,
    };
    viewer.addEventListener('cancel_insertions', onCancel);
    viewer.renderer?.domElement?.addEventListener('mouseup', onMouseUp, true);
    renderPanel();
  }

  // After the user places 2 points (or drops after drag), compute the
  // constrained endpoints, move the measure points there, show the edge.
  function finalizeConstrainedLine(measure, lineEntry, draggedIndex = -1) {
    const ep = getExportEndpoints(lineEntry, draggedIndex);
    if (!ep) return;

    // Move measure points to the constrained positions
    const newP0 = new THREE.Vector3(ep.p1.x, ep.p1.y, ep.p1.z);
    const newP1 = new THREE.Vector3(ep.p2.x, ep.p2.y, ep.p2.z);
    measure.setPosition(0, newP0);
    measure.setPosition(1, newP1);

    // Also move the sphere positions directly (Potree may not sync them)
    if (measure.spheres[0]) measure.spheres[0].position.copy(newP0);
    if (measure.spheres[1]) measure.spheres[1].position.copy(newP1);

    // Show the edge as a solid line in layer color
    measure.showEdges = true;
    measure.showHeight = false;
    const c3 = new THREE.Color(lineEntry.color);
    measure.edges?.forEach(e => {
      e.visible = true;
      if (e.material) {
        e.material.color.copy(c3);
        e.material.linewidth = lineEntry.lineWidth;
        e.material.opacity = 1;
        e.material.transparent = false;
      }
    });
    // Hide height visualization if it was left on
    if (measure.heightEdge) measure.heightEdge.visible = false;
    if (measure.heightLabel) measure.heightLabel.visible = false;

    measure.update?.();

    validateEndpointLinks(measure.spheres?.[0]);
    validateEndpointLinks(measure.spheres?.[1]);

    // Patch drag for constrained editing (only first time)
    patchConstrainedDrag(measure, lineEntry);
  }

  function patchConstrainedDrag(measure, lineEntry) {
    for (let si = 0; si < measure.spheres.length; si++) {
      const sphere = measure.spheres[si];
      const sphereIdx = si;
      if (sphere.__constrainedDragPatched) continue;
      sphere.__constrainedDragPatched = true;
      sphere.__dxfConstrained = true;

      let editHelper = null;
      let editUpdateHandler = null;
      const applyConstrainedPreview = () => {
        const previewP0 = measure.points[0].position.clone();
        const previewP1 = measure.points[1].position.clone();
        const snap = getStoredSnapCandidate(sphere, measure);
        if (snap) {
          if (sphereIdx === 0) previewP0.copy(snap.position);
          if (sphereIdx === 1) previewP1.copy(snap.position);
        }

        const previewEndpoints = computeLineEndpoints(lineEntry.lineType, previewP0, previewP1, sphereIdx);
        if (!previewEndpoints) return;

        applyEndpointPosition(measure, 0, new THREE.Vector3(previewEndpoints.p1.x, previewEndpoints.p1.y, previewEndpoints.p1.z));
        applyEndpointPosition(measure, 1, new THREE.Vector3(previewEndpoints.p2.x, previewEndpoints.p2.y, previewEndpoints.p2.z));

        propagateDrag(sphere, measure.points[sphereIdx].position);
      };

      // On drag: create a temporary triangle helper, hide the edge
      sphere.addEventListener('drag', () => {
        if (!editHelper) {
          editHelper = createTriangleHelper(lineEntry.color);
          // Hide the solid edge during drag
          measure.showEdges = false;
          measure.edges?.forEach(e => { e.visible = false; });

          editUpdateHandler = () => {
            if (measure.points.length >= 2) {
              updateTriangleHelper(editHelper,
                measure.points[0].position,
                measure.points[1].position,
                lineEntry.lineType, lineEntry.color);
              editHelper.visible = true;
            }
          };
          viewer.addEventListener('update', editUpdateHandler);
        }
        applyConstrainedPreview();
        if (editUpdateHandler) editUpdateHandler();
      });

      // On drop: remove helper and commit the constrained result once.
      sphere.addEventListener('drop', (e) => {
        if (editHelper) {
          viewer.removeEventListener('update', editUpdateHandler);
          removeTriangleHelper(editHelper);
          editHelper = null;
          editUpdateHandler = null;
        }

        const snap = getStoredSnapCandidate(sphere, measure) || findNearestEndpoint(
          e.drag.end.x,
          e.drag.end.y,
          measure,
          getSnapThresholdForMeasure(measure)
        );
        sphere.__dxfSnapCandidate = null;
        if (snap && snap.measure !== measure) {
          applyEndpointPosition(measure, sphereIdx, snap.position);
        }

        finalizeConstrainedLine(measure, lineEntry, sphereIdx);
        commitEndpointTopology(measure, 0, sphereIdx === 0 ? snap : null);
        commitEndpointTopology(measure, 1, sphereIdx === 1 ? snap : null);
      });
    }
  }

  function startDrawVertical() { startDrawConstrained('vertical'); }
  function startDrawHorizontal() { startDrawConstrained('horizontal'); }

  // Find nearest endpoint by 3D position (for linking after snap)
  function findNearestEndpointByPosition(pos, excludeMeasure) {
    let best = null, bestDist = Infinity;
    for (const line of getAllLines()) {
      if (line.measure === excludeMeasure) continue;
      for (let pi = 0; pi < line.measure.points.length; pi++) {
        const d = line.measure.points[pi].position.distanceTo(pos);
        if (d < ENDPOINT_LINK_EPSILON && d < bestDist) {
          bestDist = d;
          best = { measure: line.measure, pointIndex: pi, line };
        }
      }
    }
    return best;
  }

  // ── Line operations ───────────────────────────────────────────────────
  function removeLine(lineId) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedDeleteLine', 'Cannot delete lines while drawing is in progress'), 'warn'); return; }
    for (const [, layer] of layers) {
      const idx = layer.lines.findIndex(l => l.id === lineId);
      if (idx >= 0) {
        const line = layer.lines[idx];
        // Unlink all spheres
        line.measure.spheres.forEach(s => unlinkSphere(s));
        viewer.scene.removeMeasurement(line.measure);
        layer.lines.splice(idx, 1);
        if (selectedLineId === lineId) selectedLineId = null;
        // Remove from undo stack
        const ui = undoStack.indexOf(lineId);
        if (ui >= 0) undoStack.splice(ui, 1);
        renderPanel();
        refreshSceneTree?.();
        return;
      }
    }
  }

  function undoLastLine() {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedUndo', 'Cannot undo while drawing is in progress'), 'warn'); return; }
    if (!undoStack.length) return;
    removeLine(undoStack[undoStack.length - 1]);
  }

  function setLineColor(lineId, color) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedLineColor', 'Cannot change line color while drawing is in progress'), 'warn'); return; }
    const line = findLine(lineId);
    if (!line) return;
    line.color = color;
    applyLineVisualState(line, selectedLineId === lineId);
    renderPanel();
  }

  function setLineWidth(lineId, width) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedLineWidth', 'Cannot change line width while drawing is in progress'), 'warn'); return; }
    const line = findLine(lineId);
    if (!line) return;
    line.lineWidth = width;
    applyLineVisualState(line, selectedLineId === lineId);
  }

  function setEndpointsVisible(visible) {
    showEndpoints = visible;
    for (const line of getAllLines()) {
      line.measure.spheres.forEach(s => { s.visible = visible; });
    }
    renderPanel();
  }

  function applyColorToLayer(layerName, color) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedLayerColor', 'Cannot change layer color while drawing is in progress'), 'warn'); return; }
    const layer = layers.get(layerName);
    if (!layer) return;
    layer.color = color;
    const c = new THREE.Color(color);
    for (const line of layer.lines) {
      line.color = color;
      line.measure.color = c;
      line.measure.edges?.forEach(e => { if (e.material) e.material.color.copy(c); });
      line.measure.spheres?.forEach(s => { if (s.material) s.material.color.copy(c); });
    }
    renderPanel();
  }

  // ── Layer management ──────────────────────────────────────────────────
  function addLayer(name, color) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedAddLayer', 'Cannot add a layer while drawing is in progress'), 'warn'); return; }
    if (layers.has(name)) return;
    layers.set(name, { color: color || DEFAULT_COLOR, lineWidth: DEFAULT_WIDTH, visible: true, lines: [] });
    renderPanel();
  }

  function toggleLayerVisibility(name) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedToggleLayer', 'Cannot toggle layer visibility while drawing is in progress'), 'warn'); return; }
    const layer = layers.get(name);
    if (!layer) return;
    layer.visible = !layer.visible;
    layer.lines.forEach(l => { l.measure.visible = layer.visible; });
    renderPanel();
  }

  function removeLayer(name) {
    if (isEditingLocked()) { toast?.(tk('viewer.dxf.draw.errors.lockedRemoveLayer', 'Cannot remove a layer while drawing is in progress'), 'warn'); return; }
    const layer = layers.get(name);
    if (!layer) return;
    if (layer.lines.some(line => line.id === selectedLineId)) selectedLineId = null;
    [...layer.lines].forEach(l => {
      l.measure.spheres.forEach(s => unlinkSphere(s));
      viewer.scene.removeMeasurement(l.measure);
    });
    for (const line of layer.lines) {
      const ui = undoStack.indexOf(line.id);
      if (ui >= 0) undoStack.splice(ui, 1);
    }
    layers.delete(name);
    if (activeLayer === name) activeLayer = layers.keys().next().value || 'Default';
    ensureLayer(activeLayer);
    renderPanel();
    refreshSceneTree?.();
  }

  // ── Export ────────────────────────────────────────────────────────────
  function exportDxf() {
    const total = getAllLines().length;
    if (!total) { toast?.(tk('viewer.dxf.draw.errors.noExportLines', 'There are no line segments to export'), 'warn'); return; }
    const dxfStr = buildDxfString(layers, getAciTable?.() || {}, getExportEndpoints);
    const blob = new Blob([dxfStr], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `drawing_${new Date().toISOString().slice(0, 10)}.dxf`;
    a.click();
    URL.revokeObjectURL(url);
    toast?.(tk('viewer.dxf.draw.toasts.exportedLines', 'Exported {{count}} line segments', { count: total }), 'info');
  }

  // ── Panel rendering ─────────────────────────────────────────────────
  function renderPanel() {
    const container = document.getElementById('dxf-draw-section');
    if (!container) return;

    const layer = ensureLayer(activeLayer);
    const total = getAllLines().length;
    const ciActive = ciState !== 'INACTIVE';
    const structureLocked = drawing || ciActive;
    const selectedLine = findLine(selectedLineId);
    const selectedLabel = selectedLine ? escapeHtml(selectedLine.measure.name) : tk('viewer.dxf.draw.selection.none', 'None');

    let html = `<div class="dxf-draw-shell">
      <div class="dxf-draw-topbar">
        <div class="dxf-draw-toolgroup">
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-draw-line"${drawing ? ' disabled' : ''} title="${escapeHtml(tk('viewer.dxf.draw.tool.freeTitle', 'Free line segment'))}"><span class="dxf-btn-icon">✏️</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.tool.line', 'Line'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-draw-vert"${drawing ? ' disabled' : ''} title="${escapeHtml(tk('viewer.dxf.draw.tool.verticalTitle', 'Vertical line (height axis)'))}"><span class="dxf-btn-icon">↕</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.tool.vertical', 'Vertical'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-draw-horiz"${drawing ? ' disabled' : ''} title="${escapeHtml(tk('viewer.dxf.draw.tool.horizontalTitle', 'Horizontal line (planar)'))}"><span class="dxf-btn-icon">↔</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.tool.horizontal', 'Horizontal'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-draw-corner"${drawing || ciActive ? ' disabled' : ''} title="${escapeHtml(tk('viewer.dxf.draw.tool.cornerTitle', 'Corner intersection draw'))}"><span class="dxf-btn-icon">⊾</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.tool.corner', 'Corner Draw'))}</span></button>
        </div>
        <div class="dxf-draw-toolgroup dxf-draw-toolgroup-secondary">
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-undo"${undoStack.length && !structureLocked ? '' : ' disabled'} title="${escapeHtml(tk('viewer.dxf.draw.actions.undoTitle', 'Undo (Ctrl+Z)'))}"><span class="dxf-btn-icon">↩</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.actions.undo', 'Undo'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-delete-selected"${selectedLineId && !structureLocked ? '' : ' disabled'} title="${escapeHtml(tk('viewer.dxf.draw.actions.deleteSelectedTitle', 'Delete selected line (Delete)'))}"><span class="dxf-btn-icon">🗑</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.actions.deleteSelected', 'Delete Selected'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-export"${total ? '' : ' disabled'} title="${escapeHtml(tk('viewer.dxf.draw.actions.exportTitle', 'Export DXF'))}"><span class="dxf-btn-icon">📥</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.draw.actions.export', 'Export DXF'))}</span></button>
        </div>
      </div>`;

    // ── Drawing / CI status + quick actions
    if (ciActive) {
      let ciLabel = '';
      if (ciState === 'PICKING_WALL_A') ciLabel = `🎯 ${tk('viewer.dxf.draw.status.pickWallA', 'Pick two points to define wall A')}`;
      else if (ciState === 'PICKING_WALL_B') ciLabel = ciCorners.length
        ? `🎯 ${tk('viewer.dxf.draw.status.pickNextWall', 'Pick two points to define the next wall')} · ${tk('viewer.dxf.draw.status.confirmedCorners', '{{count}} corners', { count: ciCorners.length })}`
        : `🎯 ${tk('viewer.dxf.draw.status.pickWallB', 'Pick two points to define wall B')}`;
      html += `<div class="dxf-draw-status">
        <span class="dxf-draw-status-text">${ciLabel}</span>
        <span class="dxf-draw-status-actions">
          <button class="btn btn-sm" id="btn-dxf-ci-close"${ciCorners.length >= 3 ? '' : ' disabled'} title="${escapeHtml(tk('viewer.dxf.draw.actions.closeLoopTitle', 'Close loop (C)'))}">${escapeHtml(tk('viewer.dxf.draw.actions.closeLoop', 'C Close'))}</button>
          <button class="btn btn-sm" id="btn-dxf-ci-finish" title="${escapeHtml(tk('viewer.dxf.draw.actions.finishTitle', 'Finish and exit (Esc)'))}">${escapeHtml(tk('viewer.dxf.draw.actions.finish', 'Esc Finish'))}</button>
        </span>
      </div>`;
    } else if (drawing) {
      const modeLabel = pendingDrawMode === 'vertical'
        ? `🎯 ${tk('viewer.dxf.draw.status.pickVertical', 'Pick two points to define a vertical line')} · ${tk('viewer.dxf.draw.actions.rightClickCancel', 'Right-click to cancel')}`
        : pendingDrawMode === 'horizontal'
          ? `🎯 ${tk('viewer.dxf.draw.status.pickHorizontal', 'Pick two points to define a horizontal line')} · ${tk('viewer.dxf.draw.actions.rightClickCancel', 'Right-click to cancel')}`
          : `🎯 ${tk('viewer.dxf.draw.status.placeEndpoints', 'Click the point cloud to place endpoints')} · ${tk('viewer.dxf.draw.actions.rightClickCancel', 'Right-click to cancel')}`;
      html += `<div class="dxf-draw-status"><span class="dxf-draw-status-text">${modeLabel}</span></div>`;
    } else if (selectedLineId) {
      html += `<div class="dxf-draw-status"><span class="dxf-draw-status-text">${escapeHtml(tk('viewer.dxf.draw.status.selectedLine', 'Line selected'))} · ${escapeHtml(tk('viewer.dxf.draw.status.switchSelection', 'Click another line in the view to switch selection'))} · Delete ${escapeHtml(tk('viewer.dxf.draw.actions.delete', 'Delete'))}</span></div>`;
    }

    const floorplanSegments = floorplanResult?.segments?.length || 0;
    const floorplanStats = floorplanResult?.stats || null;
    const floorplanPanelHtml = `<div class="dxf-draw-card dxf-draw-card-beta">
      <div class="dxf-draw-card-hd">${escapeHtml(tk('viewer.dxf.floorplan.title', 'Auto Extract (Beta)'))}</div>
      <div class="dxf-draw-floorplan-form">
        <div class="dxf-draw-floorplan-row">
          <span class="dxf-draw-label">${escapeHtml(tk('viewer.dxf.floorplan.sourceLabel', 'Data source'))}</span>
          <select id="sel-dxf-floorplan-source" class="dxf-draw-select"${floorplanLoading ? ' disabled' : ''}>
            <option value="active"${floorplanSourceMode === 'active' ? ' selected' : ''}>${escapeHtml(getFloorplanSourceLabel())}</option>
          </select>
        </div>
        <div class="dxf-draw-floorplan-grid">
          <label class="dxf-draw-mini-field"><span>${escapeHtml(tk('viewer.dxf.floorplan.zCenter', 'Slice center Z'))}</span><input type="number" step="0.05" id="inp-dxf-floorplan-z" value="${floorplanConfig.zCenter}"${floorplanLoading ? ' disabled' : ''}></label>
          <label class="dxf-draw-mini-field"><span>${escapeHtml(tk('viewer.dxf.floorplan.thickness', 'Slice thickness'))}</span><input type="number" step="0.02" id="inp-dxf-floorplan-thickness" value="${floorplanConfig.thickness}"${floorplanLoading ? ' disabled' : ''}></label>
          <label class="dxf-draw-mini-field"><span>${escapeHtml(tk('viewer.dxf.floorplan.minWallLength', 'Min wall length'))}</span><input type="number" step="0.1" id="inp-dxf-floorplan-min-length" value="${floorplanConfig.minWallLength}"${floorplanLoading ? ' disabled' : ''}></label>
          <label class="dxf-draw-mini-field"><span>${escapeHtml(tk('viewer.dxf.floorplan.mergeTolerance', 'Merge tolerance'))}</span><input type="number" step="0.02" id="inp-dxf-floorplan-merge" value="${floorplanConfig.mergeTolerance}"${floorplanLoading ? ' disabled' : ''}></label>
        </div>
        <div class="dxf-draw-opts">
          <label><input type="checkbox" id="chk-dxf-floorplan-align"${floorplanConfig.autoAlign ? ' checked' : ''}${floorplanLoading ? ' disabled' : ''}> ${escapeHtml(tk('viewer.dxf.floorplan.autoAlign', 'Auto align axes'))}</label>
          <label><input type="checkbox" id="chk-dxf-floorplan-ortho"${floorplanConfig.orthogonalOnly ? ' checked' : ''}${floorplanLoading ? ' disabled' : ''}> ${escapeHtml(tk('viewer.dxf.floorplan.orthogonalOnly', 'Prefer orthogonal walls'))}</label>
          <label><input type="checkbox" id="chk-dxf-floorplan-preview"${floorplanPreviewVisible ? ' checked' : ''}> ${escapeHtml(tk('viewer.dxf.floorplan.previewToggle', 'Show preview'))}</label>
        </div>
        <div class="dxf-draw-toolgroup dxf-draw-toolgroup-secondary">
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-floorplan-extract"${floorplanLoading ? ' disabled' : ''}><span class="dxf-btn-icon">🧭</span><span class="dxf-btn-label">${escapeHtml(floorplanLoading ? tk('viewer.dxf.floorplan.extracting', 'Extracting…') : tk('viewer.dxf.floorplan.extract', 'Extract Wall Lines'))}</span></button>
          <button class="btn dxf-draw-toolbtn" id="btn-dxf-floorplan-import"${floorplanSegments ? '' : ' disabled'}><span class="dxf-btn-icon">📐</span><span class="dxf-btn-label">${escapeHtml(tk('viewer.dxf.floorplan.import', 'Import to DXF Draw'))}</span></button>
        </div>
        <div class="dxf-draw-meta">
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.floorplan.segmentCount', 'Candidates'))} <strong>${floorplanSegments}</strong></span>
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.floorplan.slicePoints', 'Slice points'))} <strong>${floorplanStats?.slicePointCount ?? '—'}</strong></span>
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.floorplan.usablePoints', 'Usable points'))} <strong>${floorplanStats?.usablePointCount ?? '—'}</strong></span>
        </div>
        ${floorplanResult?.debugImages?.length ? `<div class="dxf-draw-floorplan-debug">${floorplanResult.debugImages.map(image => `<a href="${escapeHtml(image.url)}" target="_blank" rel="noreferrer">${escapeHtml(image.name)}</a>`).join('')}</div>` : ''}
      </div>
    </div>`;

    html += `<div class="dxf-draw-card-grid">
      <div class="dxf-draw-card">
        <div class="dxf-draw-card-hd">${escapeHtml(tk('viewer.dxf.draw.sections.currentLayer', 'Current Layer'))}</div>
        <div class="dxf-draw-layer-bar">
          <label class="dxf-draw-label">${escapeHtml(tk('viewer.dxf.draw.fields.layer', 'Layer'))}</label>
          <select id="sel-dxf-draw-layer" class="dxf-draw-select"${structureLocked ? ' disabled' : ''}>`;
    for (const [name] of layers) {
      html += `<option value="${escapeHtml(name)}"${name === activeLayer ? ' selected' : ''}>${escapeHtml(name)}</option>`;
    }
    html += `</select>
          <button class="btn btn-sm" id="btn-dxf-add-layer" title="${escapeHtml(tk('viewer.dxf.draw.actions.addLayerTitle', 'Create a new layer'))}"${structureLocked ? ' disabled' : ''}>+</button>
        </div>`;

    html += `<div class="dxf-draw-color-bar">`;
    for (const c of DRAW_COLORS) {
      html += `<span class="dxf-color-swatch${c === layer.color ? ' active' : ''}${structureLocked ? ' disabled' : ''}" data-dxf-swatch="${c}" style="background:${c}" title="${c}"></span>`;
    }
    html += `<input type="color" class="dxf-draw-color-custom" id="inp-dxf-custom-color" value="${layer.color}" title="${escapeHtml(tk('viewer.dxf.draw.actions.customColorTitle', 'Custom color'))}"${structureLocked ? ' disabled' : ''}>`;
    if (layer.lines.length) {
      html += `<button class="btn btn-sm" id="btn-dxf-apply-color" title="${escapeHtml(tk('viewer.dxf.draw.actions.applyColorTitle', 'Apply current color to all lines in this layer'))}"${structureLocked ? ' disabled' : ''}>${escapeHtml(tk('viewer.dxf.draw.actions.applyToAll', 'Apply to All'))}</button>`;
    }
    html += `</div>
        <div class="dxf-draw-meta">
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.draw.meta.currentColor', 'Current color'))} <strong>${escapeHtml(layer.color)}</strong></span>
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.draw.meta.layerLines', 'Layer lines'))} <strong>${layer.lines.length}</strong></span>
        </div>
      </div>
      <div class="dxf-draw-card">
        <div class="dxf-draw-card-hd">${escapeHtml(tk('viewer.dxf.draw.sections.options', 'Options'))}</div>
        <div class="dxf-draw-opts">
          <label><input type="checkbox" id="chk-dxf-endpoints"${showEndpoints ? ' checked' : ''}> ${escapeHtml(tk('viewer.dxf.draw.options.showEndpoints', 'Show Endpoints'))}</label>
          <label><input type="checkbox" id="chk-dxf-continuous"${continuousDraw ? ' checked' : ''}${structureLocked ? ' disabled' : ''}> ${escapeHtml(tk('viewer.dxf.draw.options.continuous', 'Continuous Drawing'))}</label>
        </div>
        <div class="dxf-draw-meta">
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.draw.meta.totalLines', 'Total lines'))} <strong>${total}</strong></span>
          <span class="dxf-draw-chip">${escapeHtml(tk('viewer.dxf.draw.meta.selected', 'Selected'))} <strong>${selectedLabel}</strong></span>
        </div>
      </div>
    </div>`;

    // ── Lines per layer
    html += `<div class="dxf-draw-list-wrap">`;
    for (const [layerName, ly] of layers) {
      if (!ly.lines.length) continue;
      html += `<div class="dxf-draw-layer-hd">
        <span class="dxf-layer-swatch" style="background:${ly.color}"></span>
        <span class="dxf-draw-layer-name">${escapeHtml(layerName)}</span>
        <span class="dxf-layer-count">${ly.lines.length}</span>
        <button class="dxf-layer-eye" data-dxf-draw-toggle="${escapeHtml(layerName)}" title="${escapeHtml(tk('viewer.dxf.draw.actions.toggleLayerVisibility', 'Toggle layer visibility'))}"${structureLocked ? ' disabled' : ''}>${ly.visible ? '👁' : '🚫'}</button>
      </div>`;
      for (const line of ly.lines) {
        const pts = line.measure.points;
        let info = '';
        if (pts.length >= 2) {
          const ep = getExportEndpoints(line);
          if (ep) {
            const dx = ep.p2.x - ep.p1.x, dy = ep.p2.y - ep.p1.y, dz = ep.p2.z - ep.p1.z;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            info = formatLinearMeasurement ? formatLinearMeasurement(d, 'm') : `${d.toFixed(3)} m`;
          }
        }
        const typeIcon = line.lineType === 'vertical' ? '↕' : line.lineType === 'horizontal' ? '↔' : line.lineType === 'corner' ? '⊾' : '✏';
        html += `<div class="dxf-draw-line-row${selectedLineId === line.id ? ' selected' : ''}" data-dxf-line-select="${line.id}">
          <span class="dxf-draw-line-dot" style="background:${line.color}">${typeIcon}</span>
          <span class="dxf-draw-line-name">${escapeHtml(line.measure.name)}</span>
          <span class="dxf-draw-line-len">${info}</span>
          <span class="dxf-line-color-wrap">
            <span class="dxf-line-color-btn" style="background:${line.color}" data-line-id="${line.id}" title="${escapeHtml(tk('viewer.dxf.draw.actions.changeColor', 'Change color'))}"></span>
            <span class="dxf-line-color-pop" data-pop-for="${line.id}">${DRAW_COLORS.slice(0, 6).map(c =>
              `<span class="dxf-lc${c === line.color ? ' on' : ''}" data-c="${c}" style="background:${c}"></span>`
            ).join('')}</span>
          </span>
          <button class="icon-btn del" data-dxf-draw-del="${line.id}" title="${escapeHtml(tk('viewer.dxf.draw.actions.delete', 'Delete'))}"${structureLocked ? ' disabled' : ''}>✕</button>
        </div>`;
      }
    }
    if (!total) {
      html += `<div class="dxf-draw-empty">${escapeHtml(tk('viewer.dxf.draw.empty', 'No line segments yet. Choose a drawing tool to start.'))}</div>`;
    }
    html += `</div>`;

    // ── Stats
    if (total) {
      html += `<div class="dxf-draw-stats">${tk('viewer.dxf.draw.meta.totalLinesCount', '{{count}} line segments', { count: total })}</div>`;
    }

    if (SHOW_AUTO_EXTRACT_UI) {
      html += floorplanPanelHtml;
    }

    container.innerHTML = `${html}</div>`;
    wireEvents(container);
  }

  function wireEvents(container) {
    container.querySelector('#btn-dxf-draw-line')?.addEventListener('click', () => startDrawLine());
    container.querySelector('#btn-dxf-draw-vert')?.addEventListener('click', startDrawVertical);
    container.querySelector('#btn-dxf-draw-horiz')?.addEventListener('click', startDrawHorizontal);
    container.querySelector('#btn-dxf-draw-corner')?.addEventListener('click', startDrawCornerIntersection);
    container.querySelector('#btn-dxf-ci-close')?.addEventListener('click', closeCornerLoop);
    container.querySelector('#btn-dxf-ci-finish')?.addEventListener('click', finishCornerIntersection);

    container.querySelector('#btn-dxf-undo')?.addEventListener('click', undoLastLine);
    container.querySelector('#btn-dxf-delete-selected')?.addEventListener('click', () => {
      if (selectedLineId != null) removeLine(selectedLineId);
    });
    container.querySelector('#btn-dxf-export')?.addEventListener('click', exportDxf);
    container.querySelector('#sel-dxf-floorplan-source')?.addEventListener('change', (e) => { floorplanSourceMode = e.target.value; });
    container.querySelector('#inp-dxf-floorplan-z')?.addEventListener('input', (e) => { floorplanConfig.zCenter = Number(e.target.value); });
    container.querySelector('#inp-dxf-floorplan-thickness')?.addEventListener('input', (e) => { floorplanConfig.thickness = Number(e.target.value); });
    container.querySelector('#inp-dxf-floorplan-min-length')?.addEventListener('input', (e) => { floorplanConfig.minWallLength = Number(e.target.value); });
    container.querySelector('#inp-dxf-floorplan-merge')?.addEventListener('input', (e) => { floorplanConfig.mergeTolerance = Number(e.target.value); });
    container.querySelector('#chk-dxf-floorplan-align')?.addEventListener('change', (e) => { floorplanConfig.autoAlign = e.target.checked; });
    container.querySelector('#chk-dxf-floorplan-ortho')?.addEventListener('change', (e) => { floorplanConfig.orthogonalOnly = e.target.checked; });
    container.querySelector('#chk-dxf-floorplan-preview')?.addEventListener('change', (e) => {
      floorplanPreviewVisible = e.target.checked;
      renderFloorplanPreview();
    });
    container.querySelector('#btn-dxf-floorplan-extract')?.addEventListener('click', requestFloorplanExtraction);
    container.querySelector('#btn-dxf-floorplan-import')?.addEventListener('click', importFloorplanSegments);
    container.querySelector('#chk-dxf-endpoints')?.addEventListener('change', (e) => setEndpointsVisible(e.target.checked));
    container.querySelector('#chk-dxf-continuous')?.addEventListener('change', (e) => { continuousDraw = e.target.checked; });
    container.querySelector('#sel-dxf-draw-layer')?.addEventListener('change', (e) => { activeLayer = e.target.value; ensureLayer(activeLayer); renderPanel(); });
    container.querySelector('#btn-dxf-add-layer')?.addEventListener('click', () => {
      const name = prompt(tt('Layer name:'));
      if (name?.trim()) { addLayer(name.trim()); activeLayer = name.trim(); renderPanel(); }
    });
    container.querySelector('#btn-dxf-apply-color')?.addEventListener('click', () => applyColorToLayer(activeLayer, ensureLayer(activeLayer).color));

    // Color swatches
    container.querySelectorAll('[data-dxf-swatch]').forEach(el => {
      el.addEventListener('click', () => {
        if (isEditingLocked()) return;
        ensureLayer(activeLayer).color = el.dataset.dxfSwatch;
        renderPanel();
      });
    });
    container.querySelector('#inp-dxf-custom-color')?.addEventListener('input', (e) => {
      if (isEditingLocked()) return;
      ensureLayer(activeLayer).color = e.target.value;
      renderPanel();
    });

    // Per-line controls
    container.querySelectorAll('[data-dxf-draw-del]').forEach(btn => {
      btn.addEventListener('click', () => removeLine(Number(btn.dataset.dxfDrawDel)));
    });
    container.querySelectorAll('[data-dxf-line-select]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-dxf-draw-del], .dxf-line-color-btn, .dxf-line-color-pop')) return;
        setSelectedLine(Number(row.dataset.dxfLineSelect));
      });
    });
    // Per-line color popover
    container.querySelectorAll('.dxf-line-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pop = container.querySelector(`.dxf-line-color-pop[data-pop-for="${btn.dataset.lineId}"]`);
        if (!pop) return;
        // Toggle this popover, close others
        container.querySelectorAll('.dxf-line-color-pop.open').forEach(p => { if (p !== pop) p.classList.remove('open'); });
        pop.classList.toggle('open');
      });
    });
    container.querySelectorAll('.dxf-line-color-pop').forEach(pop => {
      pop.addEventListener('click', (e) => {
        e.stopPropagation();
        const swatch = e.target.closest('[data-c]');
        if (!swatch) return;
        const lineId = Number(pop.dataset.popFor);
        setLineColor(lineId, swatch.dataset.c);
      });
    });
    container.querySelectorAll('[data-dxf-draw-toggle]').forEach(btn => {
      btn.addEventListener('click', () => toggleLayerVisibility(btn.dataset.dxfDrawToggle));
    });
  }

  // ── Scene tree (left panel) ───────────────────────────────────────────
  function renderSceneTree(treeContainer) {
    if (!treeContainer) return;
    for (const [, layer] of layers) {
      for (const line of layer.lines) {
        const typeIcon = line.lineType === 'vertical' ? '↕' : line.lineType === 'horizontal' ? '↔' : line.lineType === 'corner' ? '⊾' : '✏';
        const item = document.createElement('div');
        item.className = 'tree-item';
        item.innerHTML = `<span class="ti-icon" style="color:${line.color}">${typeIcon}</span><span class="ti-name">${escapeHtml(line.measure.name)}</span><div class="ti-acts"><button class="icon-btn del" title="${escapeHtml(tt('Delete'))}">✕</button></div>`;
        item.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removeLine(line.id); });
        treeContainer.appendChild(item);
      }
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  function onKeyDown(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedLineId != null && !isEditingLocked()) {
      e.preventDefault();
      removeLine(selectedLineId);
      return;
    }
    // Ctrl+Z / Cmd+Z → undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      if (undoStack.length) { e.preventDefault(); undoLastLine(); }
    }
    // C key → close corner intersection loop
    if (e.key === 'c' && !e.ctrlKey && !e.metaKey && ciState === 'PICKING_WALL_B' && ciCorners.length >= 3) {
      e.preventDefault();
      closeCornerLoop();
    }
    // Escape → finish corner intersection (if active)
    if (e.key === 'Escape' && ciState !== 'INACTIVE') {
      e.preventDefault();
      finishCornerIntersection();
    }
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;
    renderPanel();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('click', onDocumentClick);
    viewer.renderer?.domElement?.addEventListener('mousedown', onCanvasMouseDown, true);
    viewer.renderer?.domElement?.addEventListener('mouseup', onCanvasMouseUp, true);
  }

  function onDocumentClick() {
    const container = document.getElementById('dxf-draw-section');
    if (!container) return;
    container.querySelectorAll('.dxf-line-color-pop.open').forEach(p => p.classList.remove('open'));
  }

  function onCanvasMouseDown(e) {
    if (e.button !== 0) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };
  }

  function onCanvasMouseUp(e) {
    if (e.button !== 0) return;
    if (drawing || isCiActive()) return;
    if (!pointerDownPos) return;
    const moved = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    pointerDownPos = null;
    if (moved > 5) return;

    const rect = viewer.renderer?.domElement?.getBoundingClientRect();
    if (!rect) return;
    const line = findLineAtScreenPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (line) setSelectedLine(line.id);
    else clearSelectedLine();
  }

  function destroy() {
    disposeActiveDrawSession({ removeMeasure: true });
    disposeActiveCiPick();
    resetCiState();
    clearFloorplanPreview();
    if (controlsBound) {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('click', onDocumentClick);
      viewer.renderer?.domElement?.removeEventListener('mousedown', onCanvasMouseDown, true);
      viewer.renderer?.domElement?.removeEventListener('mouseup', onCanvasMouseUp, true);
      controlsBound = false;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    startDrawLine, startDrawVertical, startDrawHorizontal,
    startDrawCornerIntersection, closeCornerLoop, finishCornerIntersection,
    removeLine, undoLastLine,
    setLineColor, setLineWidth, setEndpointsVisible,
    addLayer, toggleLayerVisibility, removeLayer,
    applyColorToLayer, exportDxf, getExportEndpoints, importSegments,
    renderPanel, renderSceneTree, bindControls, destroy, getAllLines,
    get drawing() { return drawing; },
    get layers() { return layers; },
  };
}
