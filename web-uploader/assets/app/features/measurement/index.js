import { computePolygonArea2D } from '../../core/stable-polygon.js';

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
  translate,
  translateText,
  toast,
  setStatus,
  refreshSceneTree,
  formatLinearMeasurement,
  formatAreaMeasurement,
  formatLinearAxis,
  pointToLocalCoordinates,
  convertLocalPointToCurrentSystem,
  getScenePointDisplayCoordinate = null,
  getCurrentCoordinateProjectContext,
  getActiveDatasetContext = null,
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
  let activeInsertion = null;

  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    if (typeof window !== 'undefined' && typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  function getMeasurements() {
    return Array.from(viewer?.scene?.measurements || []).filter(measurement => !measurement?.userData?.isDxfDraw);
  }

  function getActiveMeasurementProjectId() {
    const active = typeof getActiveDatasetContext === 'function' ? getActiveDatasetContext() : null;
    if (active?.type === 'scanner' && active.projectId) return String(active.projectId);
    return getCurrentCoordinateProjectContext?.()?.projectId || null;
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
    return t('viewer.measurement.defaultName', 'Measurement {{index}}', { index: index + 1 });
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
    if (!points.length) return t('viewer.measurement.noData', 'No data');

    if (measurement.showCoordinates && points.length >= 1) {
      const position = points[0].position;
      const projectId = points[0]?.scannerProjectId || measurement?.userData?.scannerProjectId || getActiveMeasurementProjectId();
      const displayed = getScenePointDisplayCoordinate?.(position, projectId);
      if (displayed) {
        html += `${escapeHtml(displayed.label || t('viewer.measurement.details.coordinates', 'Coordinates'))}<br>${formatCoordinateHtml(displayed)}`;
      } else {
        const localCoord = pointToLocalCoordinates(position, projectId);
        const converted = convertLocalPointToCurrentSystem(localCoord, projectId);
        html += `X: ${formatLinearAxis(localCoord.x, 'm')}<br>Y: ${formatLinearAxis(localCoord.y, 'm')}<br>Z: ${formatLinearAxis(localCoord.z, 'm')}`;
        if (converted && !converted.error && converted.kind !== 'local') {
          html += `<hr style="border-color:var(--border);margin:6px 0;">${escapeHtml(converted.label)}<br>${formatCoordinateHtml(converted)}`;
        }
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
      html += `<br>${t('viewer.measurement.details.totalLength', 'Total length')}: ${formatLinearMeasurement(total, 'm')}`;
      if (points.length > 2) {
        html += ` (${measurement.closed ? points.length : points.length - 1} ${t('viewer.measurement.details.segments', 'segments')})`;
      }
    }
    if (measurement.showHeight && points.length >= 2) {
      const pointA = points[0].position;
      const pointB = points[1].position;
      const dz = Math.abs(pointA.z - pointB.z);
      const dxy = Math.sqrt((pointA.x - pointB.x) ** 2 + (pointA.y - pointB.y) ** 2);
      const slope = dxy > 0 ? Math.atan(dz / dxy) * 180 / Math.PI : 90;
      html += `${t('viewer.measurement.details.heightDifference', 'Height difference')}: ${formatLinearMeasurement(dz, 'm')}<br>${t('viewer.measurement.details.horizontalDistance', 'Horizontal distance')}: ${formatLinearMeasurement(dxy, 'm')}<br>${t('viewer.measurement.details.slope', 'Slope')}: ${formatNumber(slope)}°`;
    }
    if (measurement.showArea && points.length >= 3) {
      const area = computePolygonArea2D(points.map(point => point.position));
      html += `${t('viewer.measurement.details.area', 'Area')}: ${formatAreaMeasurement(area, 'm')}<br>${t('viewer.measurement.details.vertices', 'Vertices')}: ${points.length}`;
    }
    if (measurement.showAngles && points.length >= 3) {
      html += `${t('viewer.measurement.details.vertices', 'Vertices')}: ${points.length}<br>(${t('viewer.measurement.details.anglesVisualized', 'Angles are shown in the viewer')})`;
    }
    return html || `${t('viewer.measurement.details.vertices', 'Vertices')}: ${points.length}`;
  }

  function renderMeasurementListItem(measurement, index, tree, detail) {
    const icon = getMeasIcon(measurement);
    const name = getMeasurementDisplayName(measurement, index);

    const treeItem = document.createElement('div');
    treeItem.className = 'tree-item';
    treeItem.innerHTML = `<span class="ti-icon">${icon}</span><span class="ti-name">${name}</span><div class="ti-acts"><button class="icon-btn del" title="${escapeHtml(t('common.actions.delete', 'Delete'))}">✕</button></div>`;
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
        <button class="meas-del" title="${escapeHtml(t('common.actions.delete', 'Delete'))}">✕</button>
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
    treeItem.innerHTML = `<span class="ti-icon">⛏</span><span class="ti-name">${escapeHtml(region.name || t('viewer.measurement.volumeName', 'Volume {{index}}', { index: index + 1 }))}</span><div class="ti-acts"><button class="icon-btn" title="${escapeHtml(t('viewer.measurement.viewDetails', 'View details'))}">↗</button><button class="icon-btn del" title="${escapeHtml(t('common.actions.delete', 'Delete'))}">✕</button></div>`;
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

    const card = document.createElement('div');
    card.className = 'meas-card';
    card.innerHTML = `
      <div class="meas-card-hd">
        <span>⛏</span>
        <span style="flex:1;font-size:11px;font-weight:500;">${escapeHtml(region.name)}</span>
        <button class="meas-del" title="${escapeHtml(t('common.actions.delete', 'Delete'))}">✕</button>
      </div>
      <div class="meas-vals">${getVolumeRegionResultHtml(region)}</div>`;
    card.querySelector('.meas-del').addEventListener('click', event => {
      event.stopPropagation();
      removeVolumeRegion(region.id);
    });
    detail.appendChild(card);
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
      detail.innerHTML = `<div style="color:var(--text3);font-size:11px;text-align:center;padding:16px;">${escapeHtml(t('viewer.measurement.emptyResults', 'No measurement results'))}</div>`;
      return;
    }

    measurements.forEach((measurement, index) => {
      renderMeasurementListItem(measurement, index, tree, detail);
    });
    volumeRegions.forEach((region, index) => {
      renderVolumeListItem(region, index, tree, detail);
    });
  }

  function syncReadyState() {
    setToolMode(null);
    syncToolButtons(null);
    setStatus(t('common.status.ready', 'Ready'));
    refreshSceneTree();
  }

  function cleanupActiveInsertion(active = activeInsertion) {
    if (!active) return;
    document.removeEventListener('keydown', active.onKeyDown, true);
    window.removeEventListener('keydown', active.onKeyDown, true);
    active.canvas?.removeEventListener('keydown', active.onKeyDown, true);
    active.canvas?.removeEventListener('mousedown', active.onMouseDown, true);
    active.canvas?.removeEventListener('mouseup', active.onMouseUp, true);
    active.canvas?.removeEventListener('dblclick', active.onDoubleClick, true);
    if (activeInsertion === active) activeInsertion = null;
  }

  function dispatchPotreeCancelInsertion() {
    try {
      viewer?.dispatchEvent?.({ type: 'cancel_insertions' });
    } catch (_error) {
      // Best effort: older Potree builds do not expose the same event surface.
    }
  }

  function cancelActiveMeasurement({ notify = true } = {}) {
    const active = activeInsertion;
    if (!active) return false;
    active.cancelled = true;
    if (active.measurement?.userData) active.measurement.userData.__cloudstudioCancelled = true;
    dispatchPotreeCancelInsertion();
    cleanupActiveInsertion(active);
    if (active.measurement) removeMeasurement(active.measurement);
    syncReadyState();
    if (notify) toast(t('viewer.measurement.toast.cancelled', 'Measurement cancelled'), 'info');
    return true;
  }

  function finishMeasurement(measurement = null) {
    const active = activeInsertion && (!measurement || activeInsertion.measurement === measurement)
      ? activeInsertion
      : null;
    const target = measurement || active?.measurement || null;
    if (!active && target?.userData?.__cloudstudioInsertionActive === false) return;
    if (target?.userData?.__cloudstudioCancelled) {
      cleanupActiveInsertion(active);
      syncReadyState();
      return;
    }

    const pointCount = Array.isArray(target?.points) ? target.points.length : 0;
    const minMarkers = active?.minMarkers ?? 1;
    cleanupActiveInsertion(active);
    if (target && pointCount < minMarkers) {
      if (target.userData) target.userData.__cloudstudioCancelled = true;
      removeMeasurement(target);
      syncReadyState();
      toast(t('viewer.measurement.toast.cancelled', 'Measurement cancelled'), 'info');
      return;
    }

    if (target?.userData) target.userData.__cloudstudioInsertionActive = false;
    syncReadyState();
    toast(t('viewer.measurement.toast.completed', 'Measurement completed'), 'ok');
  }

  function getMinimumMarkers(type) {
    if (type === 'point') return 1;
    if (type === 'area' || type === 'angle') return 3;
    return 2;
  }

  function getMeasurementStatusText(type) {
    const statusByType = {
      point: t('viewer.measurement.status.point', 'Point measurement: click one point. ESC cancels.'),
      distance: t('viewer.measurement.status.distance', 'Distance: click points, right-click to finish. ESC cancels.'),
      height: t('viewer.measurement.status.height', 'Height: click two points. ESC cancels.'),
      area: t('viewer.measurement.status.area', 'Area: click boundary points, double-click to finish. ESC cancels.'),
      angle: t('viewer.measurement.status.angle', 'Angle: click three points. ESC cancels.'),
    };
    return statusByType[type] || t('viewer.measurement.status.measuring', 'Measuring... ESC to cancel');
  }

  function startMeasurement(type) {
    if (!MEASUREMENT_TYPES.has(type)) return null;
    if (!viewer.scene.pointclouds.length) {
      toast(t('viewer.measurement.toast.needPointCloud', 'Please load a point cloud first'), 'err');
      return null;
    }

    stopCapture();
    cancelVolumeSelection({ notify: false });
    cancelDeletePolygonSelection({ notify: false });
    hideAllVolumeRegionOverlays();

    const configs = {
      point: { showDistances: false, showAngles: false, showCoordinates: true, showArea: false, closed: true, maxMarkers: 1, name: t('viewer.measurement.type.point', 'Point') },
      distance: { showDistances: true, showArea: false, closed: false, name: t('viewer.measurement.type.distance', 'Distance') },
      height: { showDistances: false, showHeight: true, showArea: false, closed: false, maxMarkers: 2, name: t('viewer.measurement.type.height', 'Height') },
      area: { showDistances: true, showArea: true, closed: true, name: t('viewer.measurement.type.area', 'Area') },
      angle: { showDistances: false, showAngles: true, closed: false, maxMarkers: 3, name: t('viewer.measurement.type.angle', 'Angle') },
    };

    const config = configs[type];
    if (!config) return null;

    setToolMode(type);
    setStatus(getMeasurementStatusText(type));
    activateMeasureTab();

    const measurement = viewer.measuringTool.startInsertion(config);
    if (!measurement) {
      syncReadyState();
      return null;
    }
    if (!measurement.userData) measurement.userData = {};
    measurement.userData.scannerProjectId = getActiveMeasurementProjectId();
    measurement.userData.measurementType = type;
    measurement.userData.__cloudstudioInsertionActive = true;

    const canvas = viewer?.renderer?.domElement || null;

    const active = {
      measurement,
      type,
      minMarkers: getMinimumMarkers(type),
      cancelled: false,
      canvas,
      rightMouseDown: null,
      onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancelActiveMeasurement({ notify: true });
      },
      onMouseDown(event) {
        if (event.button !== 2) return;
        active.rightMouseDown = { x: event.clientX || 0, y: event.clientY || 0 };
      },
      onMouseUp(event) {
        if (type === 'point' && event.button === 0) {
          try {
            viewer?.inputHandler?.onMouseUp?.(event);
          } catch (_error) {
            // Older Potree input handlers may not expose a direct mouseup hook.
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          setTimeout(() => finishMeasurement(measurement), 0);
          return;
        }
        if (event.button !== 2) return;
        const down = active.rightMouseDown;
        active.rightMouseDown = null;
        const dragDistance = down
          ? Math.hypot((event.clientX || 0) - down.x, (event.clientY || 0) - down.y)
          : 0;
        if (dragDistance > 6) {
          try {
            viewer?.inputHandler?.onMouseUp?.(event);
          } catch (_error) {
            // Keep camera rotation release best-effort while shielding Potree insertion.
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          return;
        }
        if (type === 'distance') {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          dispatchPotreeCancelInsertion();
          setTimeout(() => finishMeasurement(measurement), 0);
          return;
        }
        if (type === 'area' || type === 'angle') {
          try {
            viewer?.inputHandler?.onMouseUp?.(event);
          } catch (_error) {
            // Keep Potree's measurement insertion alive even if an older input handler differs.
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
        }
      },
      onDoubleClick(event) {
        if (type !== 'area') return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        dispatchPotreeCancelInsertion();
        setTimeout(() => finishMeasurement(measurement), 0);
      },
    };
    cleanupActiveInsertion();
    activeInsertion = active;
    document.addEventListener('keydown', active.onKeyDown, true);
    window.addEventListener('keydown', active.onKeyDown, true);
    canvas?.addEventListener('keydown', active.onKeyDown, true);
    canvas?.addEventListener('mousedown', active.onMouseDown, true);
    canvas?.addEventListener('mouseup', active.onMouseUp, true);
    canvas?.addEventListener('dblclick', active.onDoubleClick, true);

    measurement.addEventListener('marker_added', () => {
      refreshMeasurements();
      if (measurement.maxMarkers !== undefined && measurement.points && measurement.points.length >= measurement.maxMarkers) {
        setTimeout(() => {
          finishMeasurement(measurement);
        }, 200);
      }
    });
    measurement.addEventListener('finish', () => {
      finishMeasurement(measurement);
    });

    return measurement;
  }

  function clearAllMeasurements({ toastMessage = t('viewer.measurement.toast.allCleared', 'All measurements cleared') } = {}) {
    getMeasurements().forEach(measurement => removeMeasurement(measurement));
    // Volume measurements are a separate "Volume" workspace tool now; do NOT clear
    // them from the Measure tab's Clear All (prevents accidental deletion).
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
      clearButton.addEventListener('click', () => clearAllMeasurements({ toastMessage: t('viewer.measurement.toast.allCleared', 'All measurements cleared') }));
    }

    const clearMenuItem = document.getElementById('mi-clear-meas');
    if (clearMenuItem) {
      clearMenuItem.addEventListener('click', () => clearAllMeasurements({ toastMessage: t('viewer.measurement.toast.cleared', 'Measurements cleared') }));
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
