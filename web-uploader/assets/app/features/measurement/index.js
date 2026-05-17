const MEASUREMENT_TYPES = new Set(['point', 'distance', 'height', 'area', 'angle']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function dist3(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export function createMeasurementFeature({
  viewer,
  translateText,
  toast,
  setStatus,
  refreshSceneTree,
  formatLinearMeasurement,
  formatAreaMeasurement,
  formatLinearAxis,
  pointToLocalCoordinates,
  convertLocalPointToCurrentSystem,
  getCurrentCoordinateProjectContext,
  getToolMode,
  setToolMode,
  stopCapture,
  cancelVolumeSelection,
  cancelDeletePolygonSelection,
  hideAllVolumeRegionOverlays,
  getVolumeRegions = () => [],
  clearAllVolumeRegions,
  removeVolumeRegion,
  getVolumeRegionResultHtml = () => '',
  openVolumePanel,
  removeMeasurement,
  activateMeasureTab,
} = {}) {
  let controlsBound = false;

  function getMeasurements() {
    return Array.from(viewer?.scene?.measurements || []).filter(measurement => !measurement?.userData?.isDxfDraw);
  }

  function syncToolButtons(toolMode = getToolMode?.() || null) {
    document.querySelectorAll('[data-ms]').forEach(button => {
      const active = button.dataset.ms === toolMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function getMeasIcon(measurement) {
    if (measurement.showCoordinates && measurement.maxMarkers === 1) return '📍';
    if (measurement.showHeight) return '↕';
    if (measurement.showArea) return '⬡';
    if (measurement.showAngles) return '📐';
    if (measurement.showCircle) return '⭕';
    return '📏';
  }

  function getMeasurementDisplayName(measurement, index = 0) {
    const raw = String(measurement?.name || '').trim();
    if (raw) return translateText(raw);
    return `${translateText('Measurement')} ${index + 1}`;
  }

  function formatCoordinateHtml(coord) {
    if (!coord) return '—';
    if (coord.error) return `<span style="color:var(--error);">⚠ ${escapeHtml(coord.error)}</span>`;
    if (coord.kind === 'local') {
      return `X: ${formatLinearAxis(coord.x, 'm')}<br>Y: ${formatLinearAxis(coord.y, 'm')}<br>Z: ${formatLinearAxis(coord.z, 'm')}`;
    }
    if (coord.kind === 'geographic') {
      return `Lon: ${coord.lon.toFixed(8)}°<br>Lat: ${coord.lat.toFixed(8)}°<br>H: ${formatLinearAxis(coord.alt, 'm')}`;
    }
    const xyUnit = coord.xyUnitSpec || 'm';
    return `E: ${formatLinearAxis(coord.x, xyUnit)}<br>N: ${formatLinearAxis(coord.y, xyUnit)}<br>H: ${formatLinearAxis(coord.z, 'm')}`;
  }

  function getMeasDetails(measurement) {
    const points = measurement.points || [];
    let html = '';
    if (!points.length) return translateText('No data');

    if (measurement.showCoordinates && points.length >= 1) {
      const position = points[0].position;
      const projectId = measurement?.userData?.scannerProjectId
        || getCurrentCoordinateProjectContext?.()?.projectId
        || null;
      const localCoord = (measurement.maxMarkers === 1)
        ? { x: Number(position.x), y: Number(position.y), z: Number(position.z) }
        : pointToLocalCoordinates(position, projectId);
      const converted = convertLocalPointToCurrentSystem(localCoord, projectId);
      html += `X: ${formatLinearAxis(localCoord.x, 'm')}<br>Y: ${formatLinearAxis(localCoord.y, 'm')}<br>Z: ${formatLinearAxis(localCoord.z, 'm')}`;
      if (converted && !converted.error && converted.kind !== 'local') {
        html += `<hr style="border-color:var(--border);margin:6px 0;">${escapeHtml(converted.label)}<br>${formatCoordinateHtml(converted)}`;
      }
    }
    if (measurement.showDistances && points.length >= 2) {
      let total = 0;
      for (let index = 0; index < points.length - 1; index += 1) {
        total += dist3(points[index].position, points[index + 1].position);
      }
      if (measurement.closed && points.length > 2) {
        total += dist3(points[points.length - 1].position, points[0].position);
      }
      html += `<br>${translateText('Total length')}: ${formatLinearMeasurement(total, 'm')}`;
      if (points.length > 2) {
        html += ` (${measurement.closed ? points.length : points.length - 1} ${translateText('segments')})`;
      }
    }
    if (measurement.showHeight && points.length >= 2) {
      const pointA = points[0].position;
      const pointB = points[1].position;
      const dz = Math.abs(pointA.z - pointB.z);
      const dxy = Math.sqrt((pointA.x - pointB.x) ** 2 + (pointA.y - pointB.y) ** 2);
      const slope = dxy > 0 ? Math.atan(dz / dxy) * 180 / Math.PI : 90;
      html += `${translateText('Height difference')}: ${formatLinearMeasurement(dz, 'm')}<br>${translateText('Horizontal distance')}: ${formatLinearMeasurement(dxy, 'm')}<br>${translateText('Slope')}: ${formatNumber(slope)}°`;
    }
    if (measurement.showArea && points.length >= 3) {
      let area = 0;
      for (let index = 0; index < points.length; index += 1) {
        const pointA = points[index].position;
        const pointB = points[(index + 1) % points.length].position;
        area += pointA.x * pointB.y - pointB.x * pointA.y;
      }
      html += `${translateText('Area')}: ${formatAreaMeasurement(Math.abs(area) / 2, 'm')}<br>${translateText('Vertex count')}: ${points.length}`;
    }
    if (measurement.showAngles && points.length >= 3) {
      html += `${translateText('Vertex count')}: ${points.length}<br>(${translateText('Angles are shown visually')})`;
    }
    return html || `${translateText('Vertices')}: ${points.length}`;
  }

  function renderMeasurementListItem(measurement, index, tree, detail) {
    const icon = getMeasIcon(measurement);
    const name = getMeasurementDisplayName(measurement, index);

    const treeItem = document.createElement('div');
    treeItem.className = 'tree-item';
    treeItem.innerHTML = `<span class="ti-icon">${icon}</span><span class="ti-name">${name}</span><div class="ti-acts"><button class="icon-btn del" title="${escapeHtml(translateText('Delete'))}">✕</button></div>`;
    treeItem.querySelector('.icon-btn').addEventListener('click', event => {
      event.stopPropagation();
      removeMeasurement(measurement);
      refreshSceneTree();
    });
    tree.appendChild(treeItem);

    const card = document.createElement('div');
    card.className = 'meas-card';
    card.innerHTML = `
      <div class="meas-card-hd">
        <span>${icon}</span>
        <span style="flex:1;font-size:11px;font-weight:500;">${name}</span>
        <button class="meas-del" title="${escapeHtml(translateText('Delete'))}">✕</button>
      </div>
      <div class="meas-vals">${getMeasDetails(measurement)}</div>`;
    card.querySelector('.meas-del').addEventListener('click', event => {
      event.stopPropagation();
      removeMeasurement(measurement);
      refreshSceneTree();
    });
    detail.appendChild(card);
  }

  function renderVolumeListItem(region, index, tree, detail) {
    if (!removeVolumeRegion) return;

    const treeItem = document.createElement('div');
    treeItem.className = 'tree-item';
    const regionName = region.name || `${translateText('Volume')} ${index + 1}`;
    treeItem.innerHTML = `<span class="ti-icon">⛏</span><span class="ti-name">${escapeHtml(regionName)}</span><div class="ti-acts"><button class="icon-btn" title="${escapeHtml(translateText('View details'))}">↗</button><button class="icon-btn del" title="${escapeHtml(translateText('Delete'))}">✕</button></div>`;
    const [openButton, deleteButton] = treeItem.querySelectorAll('.icon-btn');
    openButton.addEventListener('click', event => {
      event.stopPropagation();
      openVolumePanel?.();
    });
    deleteButton.addEventListener('click', event => {
      event.stopPropagation();
      removeVolumeRegion(region.id);
    });
    tree.appendChild(treeItem);

    // 2026-05-07 redesign: the Measure tab used to render a duplicate
    // "meas-card" detail card with Reference Plane / Sample Points / etc.
    // The new Volume workspace (Volume tab) already shows all of that —
    // and better. Skip the redundant card on the Measure tab; keep only
    // the scene-tree entry above so the user can still locate/delete the
    // volume region from the scene tree. The `detail` argument is kept
    // for signature compatibility with `renderMeasurementListItem`.
    void detail;
  }

  function refreshMeasurements() {
    const measurements = getMeasurements();
    const volumeRegions = getVolumeRegions();
    const totalCount = measurements.length + volumeRegions.length;
    const countElement = document.getElementById('cnt-meas');
    const statusElement = document.getElementById('st-meas');
    const tree = document.getElementById('meas-tree');
    const empty = document.getElementById('meas-empty');
    const detail = document.getElementById('meas-detail-list');

    if (!countElement || !statusElement || !tree || !empty || !detail) return;

    countElement.textContent = totalCount;
    statusElement.textContent = totalCount;
    tree.innerHTML = '';
    detail.innerHTML = '';
    empty.style.display = totalCount ? 'none' : '';

    if (!totalCount) {
      const emptyText = escapeHtml(translateText('No measurement results'));
      detail.innerHTML = `<div style="color:var(--text3);font-size:11px;text-align:center;padding:16px;">${emptyText}</div>`;
      return;
    }

    measurements.forEach((measurement, index) => {
      renderMeasurementListItem(measurement, index, tree, detail);
    });
    volumeRegions.forEach((region, index) => {
      renderVolumeListItem(region, index, tree, detail);
    });
  }

  function finishMeasurement() {
    setToolMode(null);
    setStatus(translateText('Ready'));
    refreshSceneTree();
    toast(translateText('✓ Measurement complete'), 'ok');
  }

  function startMeasurement(type) {
    if (!MEASUREMENT_TYPES.has(type)) return null;
    if (!viewer.scene.pointclouds.length) {
      toast(translateText('Please load a point cloud first'), 'err');
      return null;
    }

    stopCapture();
    cancelVolumeSelection({ notify: false });
    cancelDeletePolygonSelection({ notify: false });
    hideAllVolumeRegionOverlays();

    const configs = {
      point: { showDistances: false, showAngles: false, showCoordinates: true, showArea: false, closed: true, maxMarkers: 1, name: translateText('Coordinate Point') },
      distance: { showDistances: true, showArea: false, closed: false, name: translateText('Distance') },
      height: { showDistances: false, showHeight: true, showArea: false, closed: false, maxMarkers: 2, name: translateText('Height') },
      area: { showDistances: true, showArea: true, closed: true, name: translateText('Area') },
      angle: { showDistances: false, showAngles: true, closed: false, maxMarkers: 3, name: translateText('Angle') },
    };

    const config = configs[type];
    if (!config) return null;

    setToolMode(type);
    setStatus(translateText('Measuring... double-click to finish / ESC to cancel'));
    activateMeasureTab();

    const measurement = viewer.measuringTool.startInsertion(config);
    if (!measurement) return null;
    if (!measurement.userData) measurement.userData = {};
    measurement.userData.scannerProjectId = getCurrentCoordinateProjectContext?.()?.projectId || null;

    measurement.addEventListener('marker_added', () => {
      refreshMeasurements();
      if (measurement.maxMarkers !== undefined && measurement.points && measurement.points.length >= measurement.maxMarkers) {
        setTimeout(() => {
          finishMeasurement();
        }, 200);
      }
    });
    measurement.addEventListener('finish', () => {
      finishMeasurement();
    });

    return measurement;
  }

  function clearAllMeasurements({ toastMessage = translateText('All measurements cleared') } = {}) {
    getMeasurements().forEach(measurement => removeMeasurement(measurement));
    clearAllVolumeRegions?.({ notify: false });
    refreshSceneTree();
    toast(toastMessage, 'info');
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.querySelectorAll('[data-ms]').forEach(button => {
      button.addEventListener('click', () => startMeasurement(button.dataset.ms));
    });

    const toolbarBindings = {
      'tb-point': 'point',
      'tb-dist': 'distance',
      'tb-height': 'height',
      'tb-area': 'area',
      'tb-angle': 'angle',
    };
    Object.entries(toolbarBindings).forEach(([id, type]) => {
      const element = document.getElementById(id);
      if (element) element.addEventListener('click', () => startMeasurement(type));
    });

    const menuBindings = {
      'mi-t-point': 'point',
      'mi-t-dist': 'distance',
      'mi-t-height': 'height',
      'mi-t-area': 'area',
      'mi-t-angle': 'angle',
    };
    Object.entries(menuBindings).forEach(([id, type]) => {
      const element = document.getElementById(id);
      if (element) element.addEventListener('click', () => startMeasurement(type));
    });

    const clearButton = document.getElementById('btn-clear-meas');
    if (clearButton) {
      clearButton.addEventListener('click', () => clearAllMeasurements({ toastMessage: translateText('All measurements cleared') }));
    }

    const clearMenuItem = document.getElementById('mi-clear-meas');
    if (clearMenuItem) {
      clearMenuItem.addEventListener('click', () => clearAllMeasurements({ toastMessage: translateText('Measurement cleared') }));
    }

    syncToolButtons();
  }

  return {
    bindControls,
    clearAllMeasurements,
    refreshMeasurements,
    startMeasurement,
    syncToolButtons,
  };
}
