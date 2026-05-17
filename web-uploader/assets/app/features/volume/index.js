function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getScenarioModeMeta(mode = 'stockpile_boundary') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'plane_cut_fill') {
    return {
      value: 'plane_cut_fill',
      label: 'Plane Cut/Fill',
      note: 'Compare the analysis surface against a fixed elevation plane for site grading and target-level checks.',
      defaultBaseMode: 'fixed',
    };
  }
  if (normalized === 'ground_fit_volume') {
    return {
      value: 'ground_fit_volume',
      label: 'Ground-Fitted Volume',
      note: 'Fit a terrain-like base from class-2 ground support when possible, with fallback diagnostics if the cloud does not contain enough ground samples.',
      defaultBaseMode: 'ground',
    };
  }
  return {
    value: 'stockpile_boundary',
    label: 'Stockpile',
    note: 'Use the selected boundary as the primary context for pile / mound / depression style volume jobs.',
    defaultBaseMode: 'boundary',
  };
}

function getBaseSurfaceModeMeta(mode = 'boundary') {
  const normalized = String(mode || '').trim().toLowerCase();
  if (normalized === 'fixed') {
    return {
      value: 'fixed',
      label: 'Fixed Elevation',
      note: 'Use the reference elevation field as the base plane.',
    };
  }
  if (normalized === 'ground') {
    return {
      value: 'ground',
      label: 'Ground Fit',
      note: 'Build the base surface from ground-classified terrain support when available.',
    };
  }
  return {
    value: 'boundary',
    label: 'Boundary Fit',
    note: 'Use the polygon boundary heights to interpolate a base surface across the selected region.',
  };
}

function getVolumeResultInterpretation(region, scenarioMeta, baseModeMeta) {
  const scenarioLabel = scenarioMeta?.label || 'Volume Job';
  const baseLabel = baseModeMeta?.label || 'Base Surface';
  if (scenarioMeta?.value === 'plane_cut_fill') {
    return `${scenarioLabel}: compares the analysis surface against ${baseLabel}. Positive cut means material sits above the fixed elevation; positive net means more fill than cut.`;
  }
  if (scenarioMeta?.value === 'ground_fit_volume') {
    if (region?.baseSourceUsed === 'local_csf_fit') {
      return `${scenarioLabel}: no reliable class-2 ground support was available, so the base surface was built from a local CSF ground classification inside the selected region. This is usually stronger than the low-percentile fallback, but still review warnings when the selected area contains little visible ground.`;
    }
    if (region?.baseSourceUsed === 'ground_quantile_fallback') {
      return `${scenarioLabel}: no class-2 ground support was available, so the base surface was approximated from the low-percentile terrain envelope of the unclassified point cloud. Treat the result as an estimate and review the warnings.`;
    }
    if (region?.baseSourceUsed === 'boundary_fallback') {
      return `${scenarioLabel}: ground support was too weak for a real terrain fit, so the job fell back to boundary interpolation. Inspect the warnings before trusting this result.`;
    }
    if (Number.isFinite(region?.groundSupportRatio) && region.groundSupportRatio < 0.05) {
      return `${scenarioLabel}: compares against a fitted terrain-like base, but the ground support ratio is low. Verify classification quality before relying on the fitted base.`;
    }
    return `${scenarioLabel}: compares the analysis surface against a fitted terrain-like base. Use this when a pile sits on uneven land and you do not want to assume a flat floor.`;
  }
  return `${scenarioLabel}: compares the analysis surface against ${baseLabel}, which is typically interpolated from the selected boundary heights for stockpile-style work.`;
}

function getVolumePrimaryMetric(region, scenarioMeta) {
  const scenario = scenarioMeta?.value || 'stockpile_boundary';
  if (scenario === 'stockpile_boundary' || scenario === 'ground_fit_volume') {
    const cut = Number(region?.cutVolume) || 0;
    const fill = Number(region?.fillVolume) || 0;
    const fillDominates = fill > cut;
    return {
      label: fillDominates ? 'Measured Fill' : 'Measured Cut',
      value: Math.max(cut, fill),
      note: fillDominates
        ? 'Dominant material below the base surface. Cut and Fill remain shown separately.'
        : 'Dominant material above the base surface. Cut and Fill remain shown separately.',
    };
  }
  return {
    label: 'Net Volume',
    value: Number(region?.netVolume) || 0,
    note: 'Fill - Cut. Positive means fill dominates; negative means cut dominates.',
  };
}

function getResolutionRecommendationForArea(polygonArea, scenarioMode = 'stockpile_boundary') {
  const area = Math.max(Number(polygonArea) || 0, 1e-9);
  const mode = String(scenarioMode || 'stockpile_boundary').toLowerCase();
  let targetCells = 1200;
  let minCells = 700;
  let maxCells = 2200;
  if (mode === 'plane_cut_fill') {
    targetCells = 900;
    minCells = 500;
    maxCells = 1600;
  } else if (mode === 'ground_fit_volume') {
    targetCells = 1400;
    minCells = 800;
    maxCells = 2600;
  }
  return {
    recommendedResolution: Number(Math.sqrt(area / targetCells).toFixed(3)),
    recommendedMinResolution: Number(Math.sqrt(area / maxCells).toFixed(3)),
    recommendedMaxResolution: Number(Math.sqrt(area / minCells).toFixed(3)),
    targetCellCount: targetCells,
  };
}

function applyRecommendedResolutionToRegion(region, scenarioMode = region?.scenarioMode) {
  if (!region) return;
  const recommendation = getResolutionRecommendationForArea(region.polygonArea, scenarioMode);
  region.recommendedResolution = recommendation.recommendedResolution;
  region.recommendedMinResolution = recommendation.recommendedMinResolution;
  region.recommendedMaxResolution = recommendation.recommendedMaxResolution;
  region.recommendedTargetCellCount = recommendation.targetCellCount;
  region.cellSize = Math.max(Number(recommendation.recommendedResolution) || 0, 0.25);
}

function shouldConfirmScenarioSwitch(region, nextScenarioMode) {
  if (!region) return false;
  const currentScenario = getScenarioModeMeta(region.scenarioMode);
  const nextScenario = getScenarioModeMeta(nextScenarioMode);
  if (currentScenario.value === nextScenario.value) return false;

  const hasResult = Boolean(region.volumeJobId || region.computeState === 'ready');
  const customBaseMode = Boolean(region.baseSurfaceMode && region.baseSurfaceMode !== currentScenario.defaultBaseMode);
  const customPointFilter = Boolean(region.pointFilterMode && !['all', 'exclude_vegetation', 'none'].includes(region.pointFilterMode));
  const customSurface = Boolean(region.surfaceType && region.surfaceType !== 'stockpile');
  return hasResult || customBaseMode || customPointFilter || customSurface || Boolean(region.uiAdvancedOpen);
}

export function applyScenarioDefaultsToRegion(region, scenarioMode = 'stockpile_boundary') {
  if (!region || typeof region !== 'object') return region;
  const scenario = getScenarioModeMeta(scenarioMode);
  region.scenarioMode = scenario.value;
  region.baseSurfaceMode = scenario.defaultBaseMode;
  if (scenario.value === 'ground_fit_volume') {
    region.pointFilterMode = 'exclude_vegetation';
    region.surfaceType = 'stockpile';
  } else if (scenario.value === 'plane_cut_fill' && (!region.pointFilterMode || region.pointFilterMode === 'none')) {
    region.pointFilterMode = 'all';
  }
  return region;
}

export function createVolumeFeature({
  viewer,
  getVolumeMeasureState,
  getClipBoxState,
  getClipVolumes,
  getClipBoxDisplayName,
  selectClipVolume,
  setClipBoxRotationEnabled,
  removeClipBoxVolume,
  clearAllClip,
  getDeleteSelectionState,
  getDeleteRegionDisplayName,
  translate,
  translateText,
  formatVolumeRegionSummary,
  formatVolumeMeasurement,
  getPointCloudNativeUnitKey,
  fmtNum,
  parseNumberSafe,
  computeVolumeRegion,
  buildLocalSurfaceForVolumeRegion,
  loadSurfaceJobToViewer,
  removeVolumeRegion,
  clearAllVolumeRegions,
  cancelVolumeSelection,
  refreshSceneTree,
  setVolumeOverlayVisible,
  removeSurfaceFrom3D,
  toggleSurfaceEdgesVisibility,
  generateContoursFromGrid,
  removeContoursFrom3D,
  exportVolumeSurfaceMesh,
  exportContoursAsDXF,
  toggleContourLabels,
  resizeContourLabels,
  refreshVolumeRegionDisplaySamples,
  updateVolumeRegionOverlay,
  clampVolumeDisplayDensity,
  getVolumeSelectionPick,
  toast,
  clearDeleteSelection,
  stopCapture,
  cancelDeletePolygonSelection,
  resetVolumeSelectionState,
  ensureVolumeSelectionSvg,
  registerVolumeSelectionHandlers,
  setToolMode,
  getToolMode,
  setStatus,
  getStatus,
  activateMeasureTab,
} = {}) {
  let controlsBound = false;
  let startVolumeMeasurementHandler = null;

  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  // R-5 (2026-05-07): debounce server-side recomputes that get triggered by
  // every onChange in the form. Without this, the user dragging through a
  // numeric input (or accidentally fat-fingering a select) can queue 5-10
  // 4-minute volume jobs in seconds, and on the default 1-concurrency server
  // these stack up and block everyone else. Each region keeps its own pending
  // timer so unrelated regions don't share fate.
  const REQUEUE_DELAY_MS = 600;
  const pendingComputeTimers = new Map();
  function clearPendingCompute(regionId) {
    if (!regionId) return;
    const existing = pendingComputeTimers.get(regionId);
    if (!existing) return;
    clearTimeout(existing);
    pendingComputeTimers.delete(regionId);
  }
  function requestComputeVolumeRegion(region, { immediate = false } = {}) {
    if (!region?.id) return;
    clearPendingCompute(region.id);
    if (immediate) {
      computeVolumeRegion(region);
      return;
    }
    const timer = setTimeout(() => {
      pendingComputeTimers.delete(region.id);
      computeVolumeRegion(region);
    }, REQUEUE_DELAY_MS);
    pendingComputeTimers.set(region.id, timer);
  }

  async function captureCurrentViewDataUrl() {
    return await new Promise(resolve => {
      requestAnimationFrame(() => {
        try {
          const canvas = viewer?.renderer?.domElement;
          resolve(canvas?.toDataURL?.('image/png') || null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  function refresh() {
    if (!viewer?.scene) return;
    const clipVolumes = typeof getClipVolumes === 'function' ? getClipVolumes() : viewer.scene.volumes;
    const deleteState = getDeleteSelectionState();
    const clipState = typeof getClipBoxState === 'function' ? getClipBoxState() : {};
    const stagedRegions = deleteState.stagedRegions || [];
    const deleteCount = deleteState.regions.length + stagedRegions.length;
    const count = document.getElementById('cnt-vols');
    const tree = document.getElementById('vol-tree');
    const empty = document.getElementById('vols-empty');
    const clipList = document.getElementById('clip-vol-list');
    if (!count || !tree || !empty || !clipList) return;

    count.textContent = clipVolumes.length + deleteCount;
    tree.innerHTML = '';
    clipList.innerHTML = '';
    empty.style.display = (clipVolumes.length || deleteCount) ? 'none' : '';

    if (!clipVolumes.length && !deleteCount) {
      clipList.innerHTML = `<div data-i18n-auto-root style="color:var(--text3);font-size:11px;text-align:center;padding:12px;">${escapeHtml(t('viewer.clip.emptyObjects', 'No clipping objects'))}</div>`;
      return;
    }

    clipVolumes.forEach((volume, index) => {
      const isPending = volume?.userData?.clipWorkflowState === 'staged';
      const name = typeof getClipBoxDisplayName === 'function'
        ? getClipBoxDisplayName(volume)
        : (volume.name || `Clip Box ${index + 1}`);

      const treeItem = document.createElement('div');
      treeItem.className = 'tree-item';
      treeItem.innerHTML = `<span class="ti-icon">⬒</span><span class="ti-name">${escapeHtml(name)}</span><div class="ti-acts"><button class="icon-btn" title="${volume.visible ? 'Hide' : 'Show'}">${volume.visible ? '👁' : '🚫'}</button><button class="icon-btn del" title="Delete">✕</button></div>`;
      const [toggleButton, deleteButton] = treeItem.querySelectorAll('.icon-btn');
      toggleButton.addEventListener('click', event => {
        event.stopPropagation();
        volume.visible = !volume.visible;
        toggleButton.textContent = volume.visible ? '👁' : '🚫';
      });
      deleteButton.addEventListener('click', event => {
        event.stopPropagation();
        viewer.scene.removeVolume(volume);
        refresh();
      });
      tree.appendChild(treeItem);

      const card = document.createElement('div');
      card.className = `clip-object-card${isPending ? ' pending' : ''}${clipState?.selectedVolume === volume ? ' active' : ''}`;
      const modeLabel = clipState?.mode === 'outside' ? 'Clip Outside' : 'Clip Inside';
      const pendingLabel = isPending ? 'Pending' : 'Saved';
      card.innerHTML = `
        <span>⬒</span>
        <span style="flex:1;min-width:0;">
          <span style="display:block;font-size:11px;color:var(--text2);">${escapeHtml(name)}</span>
          <span class="clip-object-badge">${escapeHtml(`${pendingLabel} · ${modeLabel}`)}</span>
        </span>
        ${isPending ? `<button class="icon-btn" data-action="edit" title="Resume editing this clip box">✎</button>` : ''}
        <button class="icon-btn del" title="Remove clipping object">✕</button>`;
      card.addEventListener('click', event => {
        if (event.target.closest('button')) return;
        selectClipVolume?.(volume);
      });
      card.querySelector('[data-action="edit"]')?.addEventListener('click', event => {
        event.stopPropagation();
        selectClipVolume?.(volume);
      });
      card.querySelector('.icon-btn.del')?.addEventListener('click', () => {
        removeClipBoxVolume?.(volume);
        refresh();
      });
      clipList.appendChild(card);
    });

    stagedRegions.forEach(region => {
      const displayName = typeof getDeleteRegionDisplayName === 'function' ? getDeleteRegionDisplayName(region) : region.name;
      const pending = document.createElement('div');
      pending.className = 'clip-object-card pending';
      pending.innerHTML = `<span>🟥</span><span style="flex:1;font-size:11px;color:var(--text2);">${escapeHtml(`Pending Delete · ${displayName}`)}</span><button class="icon-btn del" title="Remove pending region">✕</button>`;
      pending.querySelector('button')?.addEventListener('click', () => clearDeleteSelection?.({ mode: 'remove', regionId: region.id }));
      clipList.appendChild(pending);
    });

    deleteState.regions.forEach(region => {
      const displayName = typeof getDeleteRegionDisplayName === 'function' ? getDeleteRegionDisplayName(region) : region.name;
      const card = document.createElement('div');
      card.className = 'clip-object-card applied-delete';
      card.innerHTML = `<span>🧹</span><span style="flex:1;font-size:11px;color:var(--text2);">${escapeHtml(displayName)}</span><button class="icon-btn del" title="Remove delete region">✕</button>`;
      card.querySelector('button')?.addEventListener('click', () => clearDeleteSelection?.({ mode: 'remove', regionId: region.id }));
      clipList.appendChild(card);
    });

    const footer = document.createElement('div');
    footer.className = 'clip-object-footer';
    footer.innerHTML = `<button class="btn danger wide" id="btn-clear-clip-inline">${escapeHtml(t('viewer.clip.clearAll', 'Clear all clipping'))}</button>`;
    footer.querySelector('button')?.addEventListener('click', () => clearAllClip?.());
    clipList.appendChild(footer);
  }

  function pickFirstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function readRegionField(region, keys = []) {
    for (const key of keys) {
      if (!key) continue;
      const value = region?.[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function getSurfaceFieldConfig(role = 'analysis') {
    if (role === 'base') {
      return {
        role,
        label: 'Base Surface',
        emptyText: 'No base surface result yet',
        emptyHint: 'Attach a fitted/base/reference surface result when the volume job returns it.',
        jobIdKeys: ['baseSurfaceJobId', 'baseJobId'],
        meshKeys: ['baseSurfaceMeshData', 'baseMeshData'],
        gridKeys: ['baseSurfaceGridData', 'baseGridData'],
        metaKeys: ['baseSurfaceMeta', 'baseMeta'],
        layerKeys: ['baseSurfaceLayerName'],
        showEdgesKey: 'showBaseSurfaceEdges',
      };
    }
    return {
      role: 'analysis',
      label: 'Analysis Surface',
      emptyText: 'No analysis surface result yet',
      emptyHint: 'Build or compute the volume job to produce the analysis surface used for volume calculation.',
      jobIdKeys: ['analysisSurfaceJobId', 'surfaceJobId', 'jobId'],
      meshKeys: ['analysisSurfaceMeshData', 'surfaceMeshData'],
      gridKeys: ['analysisSurfaceGridData', 'surfaceGridData', 'surfaceGrid'],
      metaKeys: ['analysisSurfaceMeta', 'surfaceMeta'],
      layerKeys: ['analysisSurfaceLayerName', 'surfaceLayerName'],
      showEdgesKey: 'showEdges',
    };
  }

  function setRegionSurfaceState(region, role = 'analysis', patch = {}) {
    if (!region || !patch || typeof patch !== 'object') return;
    const config = getSurfaceFieldConfig(role);

    if (Object.prototype.hasOwnProperty.call(patch, 'jobId')) {
      const targetKey = config.jobIdKeys[0];
      region[targetKey] = patch.jobId;
      if (role === 'analysis') region.surfaceJobId = patch.jobId;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'meshData')) {
      region[config.meshKeys[0]] = patch.meshData;
      if (role === 'analysis') region.surfaceMeshData = patch.meshData;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'gridData')) {
      region[config.gridKeys[0]] = patch.gridData;
      if (role === 'analysis') {
        region.surfaceGridData = patch.gridData;
        region.surfaceGrid = patch.gridData;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'meta')) {
      region[config.metaKeys[0]] = patch.meta;
      if (role === 'analysis') region.surfaceMeta = patch.meta;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'layerName')) {
      region[config.layerKeys[0]] = patch.layerName;
      if (role === 'analysis') region.surfaceLayerName = patch.layerName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'showEdges')) {
      region[config.showEdgesKey] = patch.showEdges;
    }
  }

  function countGridCells(gridData) {
    if (!Array.isArray(gridData?.grid)) return null;
    return gridData.grid.reduce((sum, row) => sum + row.filter(value => value !== null && value !== undefined).length, 0);
  }

  function getVolumeSurfaceState(region, role = 'analysis') {
    const config = getSurfaceFieldConfig(role);
    const meshData = readRegionField(region, config.meshKeys);
    const gridData = readRegionField(region, config.gridKeys);
    const meta = pickFirstDefined(
      readRegionField(region, config.metaKeys),
      meshData?.meta,
      gridData?.meta,
    );
    const jobId = pickFirstDefined(
      readRegionField(region, config.jobIdKeys),
      meta?.sourceJobId,
    );
    const layerName = readRegionField(region, config.layerKeys);
    const vertexCount = pickFirstDefined(meta?.vertexCount, Array.isArray(meshData?.vertices) ? meshData.vertices.length : null);
    const faceCount = pickFirstDefined(meta?.faceCount, Array.isArray(meshData?.faces) ? meshData.faces.length : null);
    const filledCellCount = pickFirstDefined(meta?.filledCellCount, countGridCells(gridData));
    const hasMeshData = Array.isArray(meshData?.vertices) && meshData.vertices.length > 0 && Array.isArray(meshData?.faces) && meshData.faces.length > 0;
    const hasGridData = Array.isArray(gridData?.grid) && gridData.grid.length > 0;
    const hasResult = Boolean(jobId || hasMeshData || hasGridData);
    const displayName = pickFirstDefined(meta?.displayName, meta?.label, config.label);
    const sourceLabel = jobId ? `Job ${jobId}` : (hasMeshData ? 'Inline meshData' : 'Pending');

    let statusLabel = 'Pending';
    let statusTone = 'var(--text3)';
    if (Boolean(layerName)) {
      statusLabel = 'Loaded in 3D';
      statusTone = 'var(--success)';
    } else if (hasResult) {
      statusLabel = 'Ready';
      statusTone = 'var(--text2)';
    }

    return {
      role,
      label: config.label,
      displayName,
      emptyText: config.emptyText,
      emptyHint: config.emptyHint,
      jobId,
      meshData,
      gridData,
      meta,
      layerName,
      showEdges: region?.[config.showEdgesKey] !== false,
      hasResult,
      hasMeshData,
      hasGridData,
      vertexCount,
      faceCount,
      filledCellCount,
      sourceLabel,
      statusLabel,
      statusTone,
    };
  }

  function getActiveContourSurfaceRole(region) {
    const preferred = region?.contourSourceRole === 'base' ? 'base' : 'analysis';
    const preferredSurface = getVolumeSurfaceState(region, preferred);
    if (preferredSurface.hasGridData) return preferred;
    const fallback = preferred === 'analysis' ? 'base' : 'analysis';
    return getVolumeSurfaceState(region, fallback).hasGridData ? fallback : preferred;
  }

  function formatSurfaceStats(surface) {
    const parts = [];
    if (surface.vertexCount !== null) parts.push(`${fmtNum(surface.vertexCount)} verts`);
    if (surface.faceCount !== null) parts.push(`${fmtNum(surface.faceCount)} tris`);
    if (surface.filledCellCount !== null) parts.push(`${fmtNum(surface.filledCellCount)} cells`);
    return parts.length ? parts.join(' · ') : 'Mesh/grid data unavailable';
  }

  function formatResolutionRecommendation(region) {
    const recommended = Number(region?.recommendedResolution);
    const min = Number(region?.recommendedMinResolution);
    const max = Number(region?.recommendedMaxResolution);
    const targetCells = Number(region?.recommendedTargetCellCount);
    if (!Number.isFinite(recommended) || !Number.isFinite(min) || !Number.isFinite(max)) return null;
    const current = Math.max(Number(region?.cellSize) || 0, 0.25);
    const isUsingRecommended = Math.abs(current - Math.max(recommended, 0.25)) <= 0.001;
    if (isUsingRecommended) return `Using recommended ${current.toFixed(3)} m`;
    const hints = [
      `Recommended ${recommended.toFixed(3)} m`,
      `range ${min.toFixed(3)}–${max.toFixed(3)} m`,
    ];
    if (Number.isFinite(targetCells) && targetCells > 0) hints.push(`target ~${fmtNum(targetCells)} cells`);
    return hints.join(' · ');
  }

  function getRegionJobStatus(region) {
    const status = String(region?.computeState || 'idle').trim().toLowerCase();
    if (status === 'working') return { key: 'running', label: 'Running' };
    if (status === 'ready') return { key: 'ready', label: 'Ready' };
    if (status === 'error') return { key: 'error', label: 'Error' };
    return { key: 'idle', label: 'Idle' };
  }

  function ensureRegionUiState(region) {
    if (!region || typeof region !== 'object') return;
    if (typeof region.uiAdvancedOpen !== 'boolean') region.uiAdvancedOpen = false;
    // New collapsible drawers (2026-05-07 redesign): the workspace is now a
    // primary value + method + actions stack with everything else folded into
    // accordion drawers. Each drawer remembers its own open/closed state per
    // region so users keep the layout they prefer when bouncing between jobs.
    if (typeof region.uiSurfacesOpen !== 'boolean') region.uiSurfacesOpen = false;
    if (typeof region.uiContoursOpen !== 'boolean') region.uiContoursOpen = false;
    if (typeof region.uiWarningsExpanded !== 'boolean') region.uiWarningsExpanded = false;
    // Legacy alias — old code referenced uiViewOptionsOpen for overlay/edges.
    // Keep it tied to the new uiSurfacesOpen so any external readers still work.
    if (typeof region.uiViewOptionsOpen !== 'boolean') region.uiViewOptionsOpen = false;
  }

  function getActiveRegion(state) {
    if (!state?.regions?.length) return null;
    const preferred = state.regions.find(region => region.id === state.activeRegionId);
    if (preferred) return preferred;
    const fallback = state.regions[state.regions.length - 1];
    state.activeRegionId = fallback?.id || null;
    return fallback || null;
  }

  function setActiveRegion(regionId) {
    const state = getVolumeMeasureState();
    state.activeRegionId = regionId || null;
  }

  function getBaseSourceLabel(baseSourceUsed, baseModeMeta) {
    const key = String(baseSourceUsed || '').trim().toLowerCase();
    if (key === 'ground_class2_fit') return 'Ground fit (class 2)';
    if (key === 'local_csf_fit') return 'Local CSF ground fit';
    if (key === 'ground_quantile_fallback') return 'Ground fallback';
    if (key === 'boundary_fallback') return 'Boundary fallback';
    if (key === 'fixed_elevation') return 'Fixed elevation';
    if (key === 'boundary_fit') return 'Boundary fit';
    return baseModeMeta?.label || 'Pending';
  }

  function getSurfaceDisplayMode(analysisSurface, baseSurface) {
    const hasAnalysis = Boolean(analysisSurface?.layerName);
    const hasBase = Boolean(baseSurface?.layerName);
    if (hasAnalysis && hasBase) return 'both';
    if (hasAnalysis) return 'analysis';
    if (hasBase) return 'base';
    return 'none';
  }

  function renderEmptyWorkspace() {
    // Compact empty state: one primary CTA + one line of guidance. The toolbar
    // already has a "Volume" entry-point so we don't need to re-explain the
    // entire workflow here.
    return `
      <div class="volume-empty-state-v2">
        <div class="volume-empty-title-v2">No volume regions yet</div>
        <div class="volume-empty-copy-v2">Click <strong>New</strong> in the toolbar above, outline a boundary in the viewport, then double-click to confirm.</div>
      </div>
    `;
  }

  function renderDrawingWorkspace(state) {
    // Live drawing indicator — minimal, just shows vertex count + how to confirm.
    return `
      <div class="volume-drawing-card-v2">
        <span class="volume-status-badge status-running">Drawing</span>
        <span class="volume-drawing-meta-v2"><strong>${fmtNum(state.pendingPoints?.length || 0)}</strong> vertices placed · double-click to confirm</span>
      </div>
    `;
  }

  function renderHistoryRow(region) {
    const scenarioMeta = getScenarioModeMeta(region.scenarioMode);
    const status = getRegionJobStatus(region);
    const net = formatVolumeMeasurement(region.netVolume, getPointCloudNativeUnitKey());
    const coverage = Number.isFinite(region.coverageRatio) ? `${(region.coverageRatio * 100).toFixed(1)}%` : '--';
    return `
      <div class="volume-history-row" data-region-id="${escapeHtml(region.id)}">
        <button class="volume-history-main" data-action="reopen-region" data-region-id="${escapeHtml(region.id)}">
          <span class="volume-history-title">${escapeHtml(region.name)}</span>
          <span class="volume-history-sub">${escapeHtml(scenarioMeta.label)} · ${escapeHtml(status.label)} · ${escapeHtml(net)} · ${escapeHtml(coverage)}</span>
        </button>
        <div class="volume-history-actions">
          <button class="volume-chip small" data-action="reopen-region" data-region-id="${escapeHtml(region.id)}">Open</button>
          <button class="icon-btn del" data-action="delete-history-region" data-region-id="${escapeHtml(region.id)}" title="Delete volume region">✕</button>
        </div>
      </div>
    `;
  }

  function renderPanelList() {
    const target = document.getElementById('volume-panel-list');
    const state = getVolumeMeasureState();
    if (!target) return;
    target.innerHTML = '';
    if (!state.regions.length && !state.active) {
      target.innerHTML = renderEmptyWorkspace();
      return;
    }

    const activeRegion = getActiveRegion(state);
    const historyRegions = state.regions.filter(region => region !== activeRegion);
    let markup = '';
    if (state.active) markup += renderDrawingWorkspace(state);

    if (activeRegion) {
      ensureRegionUiState(activeRegion);
      const analysisSurface = getVolumeSurfaceState(activeRegion, 'analysis');
      const baseSurface = getVolumeSurfaceState(activeRegion, 'base');
      const contourSourceRole = getActiveContourSurfaceRole(activeRegion);
      const contourSurface = contourSourceRole === 'base' ? baseSurface : analysisSurface;
      const scenarioMeta = getScenarioModeMeta(activeRegion.scenarioMode);
      const baseModeMeta = getBaseSurfaceModeMeta(activeRegion.baseSurfaceMode || scenarioMeta.defaultBaseMode);
      const warningList = Array.isArray(activeRegion.diagnosticWarnings) ? activeRegion.diagnosticWarnings.filter(Boolean) : [];
      const confidence = String(activeRegion.diagnosticConfidence || (warningList.length ? 'medium' : 'high')).toLowerCase();
      const resolutionRecommendationText = formatResolutionRecommendation(activeRegion);
      const coverageText = Number.isFinite(activeRegion.coverageRatio) ? `${(activeRegion.coverageRatio * 100).toFixed(1)}%` : '--';
      const jobStatus = getRegionJobStatus(activeRegion);
      const jobRef = pickFirstDefined(activeRegion.volumeJobId, activeRegion.jobId, analysisSurface.jobId, activeRegion.id);
      const baseSourceLabel = getBaseSourceLabel(activeRegion.baseSourceUsed, baseModeMeta);
      const primaryMetric = getVolumePrimaryMetric(activeRegion, scenarioMeta);
      const resultInterpretation = getVolumeResultInterpretation(activeRegion, scenarioMeta, baseModeMeta);
      const showReferenceHeight = baseModeMeta.value === 'fixed';
      const hasContourData = analysisSurface.hasGridData || baseSurface.hasGridData;
      const surfaceDisplayMode = getSurfaceDisplayMode(analysisSurface, baseSurface);

      // -----------------------------------------------------------------
      // 2026-05-07 redesign: progressive-disclosure layout
      //   1. Header             — name · scenario · status · close
      //   2. Primary metric     — large value + confidence + compact stats
      //   3. Method             — scenario picker + cell size + ref height
      //   4. Warnings strip     — only when warnings present
      //   5. Actions row        — Export Report / Re-run / Redraw
      //   6. Drawer: Surfaces & display    (collapsed)
      //   7. Drawer: Advanced settings     (collapsed)
      //   8. Drawer: Contours              (collapsed; only when grid ready)
      // Every existing data-action / data-field hook is preserved so the
      // event-binding code below keeps working.
      // -----------------------------------------------------------------

      const primaryValueText = formatVolumeMeasurement(primaryMetric.value, getPointCloudNativeUnitKey());
      const cutText = formatVolumeMeasurement(activeRegion.cutVolume, getPointCloudNativeUnitKey());
      const fillText = formatVolumeMeasurement(activeRegion.fillVolume, getPointCloudNativeUnitKey());
      const cellsText = `${fmtNum(activeRegion.cellCount)} cells · ${coverageText}`;
      const showSurfacesDrawer = analysisSurface.hasResult || baseSurface.hasResult;
      const showContoursDrawer = hasContourData;
      const showApplyRecommended = Number.isFinite(Number(activeRegion.recommendedResolution)) &&
        Math.abs(Math.max(Number(activeRegion.cellSize) || 0, 0.25) - Math.max(Number(activeRegion.recommendedResolution), 0.25)) > 0.001;

      const cellSizeMarkup = `
        <label class="volume-field-label">Cell size (m)</label>
        <input class="volume-field-input" data-field="cellSize" type="number" min="0.25" step="0.05" value="${Math.max(Number(activeRegion.cellSize ?? 0.25), 0.25).toFixed(3)}">
        ${resolutionRecommendationText ? `
          <div class="volume-inline-hint volume-inline-hint-row">
            <span>${escapeHtml(resolutionRecommendationText)}</span>
            ${showApplyRecommended ? '<button class="volume-chip volume-chip-link" data-action="apply-recommended-resolution">Apply</button>' : ''}
          </div>
        ` : ''}
      `;

      const referenceHeightMarkup = showReferenceHeight ? `
        <div class="volume-method-field">
          <label class="volume-field-label">Reference height (m)</label>
          <div class="volume-field-row">
            <input class="volume-field-input" data-field="referenceHeight" type="number" step="0.01" value="${Number(activeRegion.referenceHeight ?? 0).toFixed(3)}" placeholder="Elevation">
            <button class="volume-pick-btn" data-action="pick-height" title="Click a point in the cloud to pick its elevation">Pick</button>
          </div>
          <div class="volume-chip-row volume-chip-row-tight">
            <button class="volume-chip small" data-preset="min">Min</button>
            <button class="volume-chip small" data-preset="avg">Avg</button>
            <button class="volume-chip small" data-preset="max">Max</button>
          </div>
        </div>
      ` : '';

      const warningsMarkup = warningList.length ? `
        <div class="volume-warnings-strip${activeRegion.uiWarningsExpanded ? ' is-expanded' : ''}">
          <button class="volume-warnings-toggle" data-action="toggle-warnings" type="button">
            <span class="volume-warnings-icon" aria-hidden="true">⚠</span>
            <span class="volume-warnings-summary">${fmtNum(warningList.length)} ${warningList.length === 1 ? 'warning' : 'warnings'} · ${escapeHtml(confidence || 'unknown')} confidence</span>
            <span class="volume-warnings-caret">${activeRegion.uiWarningsExpanded ? '▴' : '▾'}</span>
          </button>
          ${activeRegion.uiWarningsExpanded ? `
            <div class="volume-warnings-list-v2">
              ${warningList.map(message => `<div class="volume-warning-item">${escapeHtml(message)}</div>`).join('')}
              <div class="volume-warnings-footer">${escapeHtml(resultInterpretation)}</div>
            </div>
          ` : ''}
        </div>
      ` : `
        <div class="volume-confidence-strip confidence-${escapeHtml(confidence)}" title="${escapeHtml(resultInterpretation)}">
          <span class="volume-confidence-dot" aria-hidden="true"></span>
          <span>Confidence: <strong>${escapeHtml(confidence || 'unknown')}</strong> · ${escapeHtml(baseSourceLabel)}</span>
        </div>
      `;

      const surfacesDrawerBody = showSurfacesDrawer ? `
        <div class="volume-drawer-body">
          <div class="volume-drawer-row volume-drawer-label">3D display</div>
          <div class="volume-visual-toggle-grid">
            <button class="volume-chip${surfaceDisplayMode === 'analysis' ? ' active' : ''}" data-action="show-primary-surface" ${analysisSurface.hasResult ? '' : 'disabled'}>Analysis</button>
            <button class="volume-chip${surfaceDisplayMode === 'base' ? ' active' : ''}" data-action="show-base-surface" ${baseSurface.hasResult ? '' : 'disabled'}>Base</button>
            <button class="volume-chip${surfaceDisplayMode === 'both' ? ' active' : ''}" data-action="show-both-surfaces" ${(analysisSurface.hasResult || baseSurface.hasResult) ? '' : 'disabled'}>Both</button>
            <button class="volume-chip${surfaceDisplayMode === 'none' ? ' active' : ''}" data-action="hide-all-surfaces" ${(analysisSurface.layerName || baseSurface.layerName) ? '' : 'disabled'}>None</button>
          </div>

          <div class="volume-drawer-row volume-drawer-label">Edges &amp; overlay</div>
          <div class="volume-visual-action-grid">
            <button class="volume-chip${activeRegion.showComputedOverlay ? ' active' : ''}" data-action="toggle-overlay">${activeRegion.showComputedOverlay ? 'Overlay on' : 'Overlay off'}</button>
            <button class="volume-chip${analysisSurface.layerName && analysisSurface.showEdges ? ' active' : ''}" data-action="toggle-edges" data-role="analysis" ${analysisSurface.layerName ? '' : 'disabled'}>${analysisSurface.showEdges ? 'Analysis edges on' : 'Analysis edges off'}</button>
            <button class="volume-chip${baseSurface.layerName && baseSurface.showEdges ? ' active' : ''}" data-action="toggle-edges" data-role="base" ${baseSurface.layerName ? '' : 'disabled'}>${baseSurface.showEdges ? 'Base edges on' : 'Base edges off'}</button>
            <button class="volume-chip" data-action="build-surface">Refresh surfaces</button>
          </div>

          <div class="volume-drawer-row volume-drawer-label">Mesh export</div>
          <div class="volume-visual-action-grid">
            <button class="volume-chip" data-action="export-obj" data-role="analysis" ${analysisSurface.jobId ? '' : 'disabled'}>Analysis OBJ</button>
            <button class="volume-chip" data-action="export-obj" data-role="base" ${baseSurface.jobId ? '' : 'disabled'}>Base OBJ</button>
          </div>
        </div>
      ` : '';

      const contoursDrawerBody = showContoursDrawer ? `
        <div class="volume-drawer-body">
          <div class="volume-controls compact">
            <div>
              <label class="volume-field-label">Interval (m)</label>
              <input class="volume-field-input" data-field="contourInterval" type="number" min="0.01" step="0.01" value="${Number(activeRegion.contourInterval ?? 0.5).toFixed(2)}">
            </div>
            <div>
              <label class="volume-field-label">Label size</label>
              <input class="volume-field-input" data-field="contourLabelScale" type="number" min="0.1" max="5" step="0.1" value="${Number(activeRegion.contourLabelScale ?? 1.0).toFixed(1)}">
            </div>
          </div>
          <div class="volume-drawer-row volume-drawer-label">Source</div>
          <div class="volume-contour-source-grid">
            <button class="volume-chip${contourSourceRole === 'analysis' ? ' active' : ''}" data-action="set-contour-source" data-role="analysis" ${analysisSurface.hasGridData ? '' : 'disabled'}>Analysis</button>
            <button class="volume-chip${contourSourceRole === 'base' ? ' active' : ''}" data-action="set-contour-source" data-role="base" ${baseSurface.hasGridData ? '' : 'disabled'}>Base</button>
          </div>
          <div class="volume-contour-action-grid">
            <button class="volume-chip primary" data-action="gen-contours" ${contourSurface.hasGridData ? '' : 'disabled'}>Generate</button>
            <button class="volume-chip${activeRegion.contoursVisible && activeRegion.contourLabelsVisible !== false ? ' active' : ''}" data-action="toggle-labels" ${activeRegion.contoursVisible ? '' : 'disabled'}>${activeRegion.contoursVisible && activeRegion.contourLabelsVisible !== false ? 'Labels on' : 'Labels off'}</button>
            <button class="volume-chip" data-action="export-dxf" ${activeRegion.contoursVisible ? '' : 'disabled'}>Export DXF</button>
            <button class="volume-chip" data-action="remove-contours" ${activeRegion.contoursVisible ? '' : 'disabled'}>Clear</button>
          </div>
        </div>
      ` : '';

      const advancedDrawerBody = `
        <div class="volume-drawer-body">
          <div class="volume-advanced-grid">
            <div>
              <label class="volume-field-label">Base surface override</label>
              <select class="volume-field-input" data-field="baseSurfaceMode" style="appearance:auto;">
                <option value="boundary" ${baseModeMeta.value === 'boundary' ? 'selected' : ''}>Boundary fit</option>
                <option value="fixed" ${baseModeMeta.value === 'fixed' ? 'selected' : ''}>Fixed elevation</option>
                <option value="ground" ${baseModeMeta.value === 'ground' ? 'selected' : ''}>Ground fit</option>
              </select>
            </div>
            <div>
              <label class="volume-field-label">Point filter</label>
              <select class="volume-field-input" data-field="pointFilterMode" style="appearance:auto;">
                <option value="all" ${(!activeRegion.pointFilterMode || activeRegion.pointFilterMode === 'all' || activeRegion.pointFilterMode === 'none') ? 'selected' : ''}>All points</option>
                <option value="exclude_vegetation" ${activeRegion.pointFilterMode === 'exclude_vegetation' ? 'selected' : ''}>Exclude grass / trees</option>
                <option value="exclude_vegetation_buildings" ${activeRegion.pointFilterMode === 'exclude_vegetation_buildings' ? 'selected' : ''}>Exclude vegetation / buildings</option>
                <option value="ground_only" ${activeRegion.pointFilterMode === 'ground_only' ? 'selected' : ''}>Ground only (class 2)</option>
              </select>
            </div>
            <div>
              <label class="volume-field-label">Surface mode</label>
              <select class="volume-field-input" data-field="surfaceType" style="appearance:auto;">
                <option value="stockpile" ${activeRegion.surfaceType === 'stockpile' ? 'selected' : ''}>Stockpile</option>
                <option value="dsm" ${activeRegion.surfaceType === 'dsm' ? 'selected' : ''}>Full surface (DSM)</option>
                <option value="dtm" ${activeRegion.surfaceType === 'dtm' ? 'selected' : ''}>Ground level (DTM)</option>
              </select>
            </div>
            ${activeRegion.surfaceType === 'stockpile' ? `
              <div>
                <label class="volume-field-label">Aggregation</label>
                <select class="volume-field-input" data-field="surfaceAggregateMode" style="appearance:auto;">
                  <option value="p80" ${activeRegion.surfaceAggregateMode === 'p80' ? 'selected' : ''}>P80</option>
                  <option value="p85" ${activeRegion.surfaceAggregateMode === 'p85' ? 'selected' : ''}>P85</option>
                  <option value="median" ${activeRegion.surfaceAggregateMode === 'median' ? 'selected' : ''}>Median</option>
                  <option value="max" ${activeRegion.surfaceAggregateMode === 'max' ? 'selected' : ''}>Max</option>
                  <option value="min" ${activeRegion.surfaceAggregateMode === 'min' ? 'selected' : ''}>Min</option>
                </select>
              </div>
            ` : ''}
            <div>
              <label class="volume-field-label">Gap fill</label>
              <select class="volume-field-input" data-field="holeFillMode" style="appearance:auto;">
                <option value="leave" ${activeRegion.holeFillMode === 'leave' ? 'selected' : ''}>Leave holes</option>
                <option value="reference" ${activeRegion.holeFillMode === 'reference' ? 'selected' : ''}>Fill with ref. elevation</option>
                <option value="interpolate" ${activeRegion.holeFillMode === 'interpolate' ? 'selected' : ''}>Interpolate</option>
              </select>
            </div>
            <div>
              <label class="volume-field-label">Display density</label>
              <input class="volume-field-input" data-field="displayDensity" type="number" min="0.2" max="4" step="0.1" value="${Number(activeRegion.displayDensity ?? 1).toFixed(1)}">
            </div>
          </div>
        </div>
      `;

      markup += `
        <div class="volume-workspace-card-v2" data-region-id="${escapeHtml(activeRegion.id)}">
          <header class="volume-ws-header">
            <div class="volume-ws-title-block">
              <div class="volume-ws-title">${escapeHtml(activeRegion.name)}</div>
              <div class="volume-ws-meta">${escapeHtml(scenarioMeta.label)} · ${escapeHtml(activeRegion.pointcloudName || 'Point Cloud')} · ${fmtNum(activeRegion.vertexCount)} verts · ${fmtNum(activeRegion.polygonArea)} m²</div>
            </div>
            <div class="volume-ws-header-actions">
              <span class="volume-status-badge status-${escapeHtml(jobStatus.key)}">${escapeHtml(jobStatus.label)}</span>
              <button class="icon-btn del" data-action="delete-region" data-region-id="${escapeHtml(activeRegion.id)}" title="Delete volume region">✕</button>
            </div>
          </header>

          <section class="volume-primary-block">
            <div class="volume-primary-value">${primaryValueText}</div>
            <div class="volume-primary-label">${escapeHtml(primaryMetric.label)}</div>
            <div class="volume-secondary-stats">
              <span><span class="volume-stat-key">Cut</span><strong>${cutText}</strong></span>
              <span class="volume-stat-sep" aria-hidden="true">·</span>
              <span><span class="volume-stat-key">Fill</span><strong>${fillText}</strong></span>
              <span class="volume-stat-sep" aria-hidden="true">·</span>
              <span><span class="volume-stat-key">Coverage</span><strong>${cellsText}</strong></span>
            </div>
          </section>

          <section class="volume-method-block">
            <div class="volume-scenario-picker">
              <button class="volume-mode-chip${scenarioMeta.value === 'stockpile_boundary' ? ' active' : ''}" data-action="set-scenario" data-value="stockpile_boundary">Stockpile</button>
              <button class="volume-mode-chip${scenarioMeta.value === 'plane_cut_fill' ? ' active' : ''}" data-action="set-scenario" data-value="plane_cut_fill">Plane Cut/Fill</button>
              <button class="volume-mode-chip${scenarioMeta.value === 'ground_fit_volume' ? ' active' : ''}" data-action="set-scenario" data-value="ground_fit_volume">Ground-Fitted</button>
            </div>
            <div class="volume-method-field">${cellSizeMarkup}</div>
            ${referenceHeightMarkup}
          </section>

          ${warningsMarkup}

          <section class="volume-actions-row">
            <button class="volume-action-btn primary" data-action="export-report" ${activeRegion.volumeJobId ? '' : 'disabled'}>Export report</button>
            <button class="volume-action-btn" data-action="recompute" data-region-id="${escapeHtml(activeRegion.id)}">Re-run</button>
            <button class="volume-action-btn" data-action="redraw-region" data-region-id="${escapeHtml(activeRegion.id)}">Redraw</button>
          </section>

          ${showSurfacesDrawer ? `
            <details class="volume-drawer" data-drawer="surfaces"${activeRegion.uiSurfacesOpen ? ' open' : ''}>
              <summary class="volume-drawer-header" data-action="toggle-surfaces">
                <span class="volume-drawer-icon" aria-hidden="true">▾</span>
                <span class="volume-drawer-title">3D surfaces &amp; display</span>
                <span class="volume-drawer-meta">${surfaceDisplayMode === 'none' ? 'Hidden' : surfaceDisplayMode.charAt(0).toUpperCase() + surfaceDisplayMode.slice(1)}</span>
              </summary>
              ${surfacesDrawerBody}
            </details>
          ` : ''}

          <details class="volume-drawer" data-drawer="advanced"${activeRegion.uiAdvancedOpen ? ' open' : ''}>
            <summary class="volume-drawer-header" data-action="toggle-advanced">
              <span class="volume-drawer-icon" aria-hidden="true">▾</span>
              <span class="volume-drawer-title">Advanced settings</span>
              <span class="volume-drawer-meta">${escapeHtml(baseSourceLabel)}</span>
            </summary>
            ${advancedDrawerBody}
          </details>

          ${showContoursDrawer ? `
            <details class="volume-drawer" data-drawer="contours"${activeRegion.uiContoursOpen ? ' open' : ''}>
              <summary class="volume-drawer-header" data-action="toggle-contours">
                <span class="volume-drawer-icon" aria-hidden="true">▾</span>
                <span class="volume-drawer-title">Contours</span>
                <span class="volume-drawer-meta">${activeRegion.contoursVisible ? `Active · ${Number(activeRegion.contourInterval ?? 0.5).toFixed(2)} m` : 'Idle'}</span>
              </summary>
              ${contoursDrawerBody}
            </details>
          ` : ''}
        </div>
      `;
    }

    if (historyRegions.length) {
      markup += `
        <div class="volume-history-card">
          <div class="volume-inspector-head">
            <div>
              <div class="volume-inspector-title">Recent Jobs</div>
              <div class="volume-inspector-sub">Older regions stay compact until you reopen them.</div>
            </div>
          </div>
          <div class="volume-history-list">
            ${historyRegions.slice().reverse().map(region => renderHistoryRow(region)).join('')}
          </div>
        </div>
      `;
    }

    target.innerHTML = markup;

    target.querySelectorAll('[data-action="reopen-region"]').forEach(button => {
      button.addEventListener('click', () => {
        setActiveRegion(button.dataset.regionId || null);
        updatePanel();
      });
    });
    target.querySelectorAll('[data-action="delete-history-region"]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const regionId = button.dataset.regionId || '';
        clearPendingCompute(regionId);
        removeVolumeRegion(regionId);
      });
    });

    if (!activeRegion) return;
    const region = activeRegion;
    // 2026-05-07 fix: the redesign renamed this class to .volume-workspace-card-v2
    // but the lookup wasn't updated, which left every form input and button on
    // the active region card without an event listener (Apply / Re-run / Cell
    // size onChange all silently no-op'd). Match the new class. Keep the old
    // name as a fallback so any in-flight A/B revert still binds correctly.
    const card = target.querySelector('.volume-workspace-card-v2, .volume-workspace-card');
    if (!card) return;

    card.querySelector('[data-action="delete-region"]')?.addEventListener('click', () => {
      clearPendingCompute(region.id);
      removeVolumeRegion(region.id);
    });
    card.querySelector('[data-action="redraw-region"]')?.addEventListener('click', () => {
      clearPendingCompute(region.id);
      removeVolumeRegion(region.id, { notify: false });
      startVolumeMeasurementHandler?.();
      toast('Draw a new boundary for this volume job.', 'info', 2200);
    });
    card.querySelector('[data-action="recompute"]')?.addEventListener('click', async () => {
      try {
        await computeVolumeRegion(region);
      } catch (error) {
        region.computeState = 'error';
        region.computeMessage = error?.message || String(error);
        updatePanel();
        refreshSceneTree?.();
        console.error('[Volume] recompute failed:', error);
        toast(`Volume compute failed: ${region.computeMessage}`, 'err', 4200);
      }
    });
    card.querySelector('[data-action="build-surface"]')?.addEventListener('click', async () => {
      try {
        await buildLocalSurfaceForVolumeRegion?.(region);
        updatePanel();
      } catch (error) {
        toast(`Local mesh build failed: ${error.message}`, 'err', 3200);
      }
    });
    // 2026-05-07 redesign: drawers are native <details>/<summary>. The browser
    // auto-toggles the `open` attribute on summary click; we just listen to the
    // native `toggle` event to sync the per-region state so it survives the
    // next re-render. We deliberately DON'T call updatePanel() here — that
    // would re-render the DOM, drop the user's just-opened drawer, and feel
    // janky. Inner content is always rendered regardless of open state, so
    // expanding doesn't need a re-render to populate the body.
    card.querySelectorAll('details.volume-drawer').forEach(drawer => {
      drawer.addEventListener('toggle', () => {
        const which = drawer.dataset.drawer;
        if (which === 'surfaces') {
          region.uiSurfacesOpen = drawer.open;
          // Keep legacy alias in sync for any external readers still looking
          // at uiViewOptionsOpen — no behavioural difference, just safety.
          region.uiViewOptionsOpen = drawer.open;
        } else if (which === 'contours') {
          region.uiContoursOpen = drawer.open;
        } else if (which === 'advanced') {
          region.uiAdvancedOpen = drawer.open;
        }
      });
    });

    // Warnings strip is a regular button, not a <details> — it adds/removes
    // markup in the warning list, so we DO need to re-render here.
    card.querySelector('[data-action="toggle-warnings"]')?.addEventListener('click', () => {
      region.uiWarningsExpanded = !region.uiWarningsExpanded;
      updatePanel();
    });
    card.querySelector('[data-action="export-report"]')?.addEventListener('click', async () => {
      if (!region.volumeJobId) return;
      try {
        const imageDataUrl = await captureCurrentViewDataUrl();
        if (imageDataUrl) {
          const response = await fetch('/api/volume-report-view-snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: region.volumeJobId,
              imageDataUrl,
            }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || data?.ok === false) {
            throw new Error(data?.error || 'Failed to refresh the PDF report.');
          }
        }
      } catch (error) {
        console.warn('[Volume] Failed to refresh report with current view:', error);
        toast(`Could not embed the current view screenshot. Downloading the latest available report instead.`, 'info', 3200);
      }
      const anchor = document.createElement('a');
      anchor.href = `/api/download-volume-job?jobId=${encodeURIComponent(region.volumeJobId)}&artifact=report-pdf`;
      anchor.download = `${region.volumeJobId}_volume_report.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    });

    const loadSurfaceIntoViewer = async role => {
      const surface = getVolumeSurfaceState(region, role);
      if (!surface.hasResult) return;
      try {
        const source = surface.hasMeshData
          ? {
            jobId: surface.jobId,
            meshData: surface.meshData,
            gridData: surface.gridData,
            meta: surface.meta,
          }
          : surface.jobId;
        const result = await loadSurfaceJobToViewer?.(source, {
          region,
          kind: 'volume',
          ownerRegionId: region.id,
          surfaceRole: role,
          attachPointcloudUuid: region.pointcloudUuid || undefined,
          displayName: surface.displayName,
        });
        setRegionSurfaceState(region, role, {
          jobId: surface.jobId || result?.meta?.sourceJobId || null,
          meshData: surface.meshData,
          gridData: result?.grid || surface.gridData || null,
          meta: result?.meta || surface.meta || null,
          layerName: result?.layer?.name || surface.layerName || null,
          showEdges: true,
        });
        updatePanel();
      } catch (error) {
        toast(`Failed to load ${surface.label.toLowerCase()}: ${error.message}`, 'err', 2600);
      }
    };
    const hideSurfaceFromViewer = role => {
      const surface = getVolumeSurfaceState(region, role);
      removeSurfaceFrom3D?.({ silent: false, kind: 'volume', ownerRegionId: region.id, surfaceRole: role });
      setRegionSurfaceState(region, role, { layerName: null, showEdges: surface.showEdges });
      updatePanel();
    };

    card.querySelector('[data-action="show-primary-surface"]')?.addEventListener('click', async () => {
      const displayMode = getSurfaceDisplayMode(getVolumeSurfaceState(region, 'analysis'), getVolumeSurfaceState(region, 'base'));
      if (displayMode === 'analysis') {
        return;
      }
      await loadSurfaceIntoViewer('analysis');
      hideSurfaceFromViewer('base');
    });
    card.querySelector('[data-action="show-base-surface"]')?.addEventListener('click', async () => {
      const displayMode = getSurfaceDisplayMode(getVolumeSurfaceState(region, 'analysis'), getVolumeSurfaceState(region, 'base'));
      if (displayMode === 'base') {
        return;
      }
      await loadSurfaceIntoViewer('base');
      hideSurfaceFromViewer('analysis');
    });
    card.querySelector('[data-action="show-both-surfaces"]')?.addEventListener('click', async () => {
      const displayMode = getSurfaceDisplayMode(getVolumeSurfaceState(region, 'analysis'), getVolumeSurfaceState(region, 'base'));
      if (displayMode === 'both') {
        return;
      }
      await loadSurfaceIntoViewer('analysis');
      await loadSurfaceIntoViewer('base');
    });
    card.querySelector('[data-action="hide-all-surfaces"]')?.addEventListener('click', () => {
      hideSurfaceFromViewer('analysis');
      hideSurfaceFromViewer('base');
    });
    card.querySelector('[data-action="toggle-overlay"]')?.addEventListener('click', () => {
      region.showComputedOverlay = !region.showComputedOverlay;
      refreshVolumeRegionDisplaySamples(region);
      updateVolumeRegionOverlay(region);
      updatePanel();
    });
    card.querySelectorAll('[data-action="toggle-edges"]').forEach(button => {
      button.addEventListener('click', () => {
        const role = button.dataset.role || 'analysis';
        const surface = getVolumeSurfaceState(region, role);
        const showEdges = surface.showEdges === false ? true : false;
        setRegionSurfaceState(region, role, { showEdges });
        toggleSurfaceEdgesVisibility?.('volume', region.id, showEdges, role);
        updatePanel();
      });
    });

    card.querySelectorAll('[data-preset]').forEach(button => {
      button.addEventListener('click', async () => {
        const preset = button.dataset.preset;
        region.referenceHeight = preset === 'min'
          ? region.vertexHeightStats.min
          : (preset === 'max' ? region.vertexHeightStats.max : region.vertexHeightStats.avg);
        updatePanel();
        await computeVolumeRegion(region);
      });
    });
    // R-5 (2026-05-07): every form-driven onChange below routes through the
    // debouncer so a user dragging a numeric input or rapidly clicking a
    // dropdown does not stack up multiple 4-min server jobs.
    card.querySelector('[data-field="referenceHeight"]')?.addEventListener('change', event => {
      const value = parseNumberSafe(event.target.value);
      if (value === null) {
        event.target.value = Number(region.referenceHeight).toFixed(3);
        toast('Invalid reference elevation input', 'err', 1800);
        return;
      }
      region.referenceHeight = value;
      requestComputeVolumeRegion(region);
    });
    card.querySelector('[data-field="cellSize"]')?.addEventListener('change', event => {
      const value = parseNumberSafe(event.target.value);
      if (value === null || value < 0.25) {
        event.target.value = Number(region.cellSize).toFixed(3);
        toast('Cell size must be at least 0.25 m', 'err', 1800);
        return;
      }
      region.cellSize = value;
      requestComputeVolumeRegion(region);
    });
    card.querySelector('[data-action="apply-recommended-resolution"]')?.addEventListener('click', () => {
      if (!Number.isFinite(region.recommendedResolution) || region.recommendedResolution <= 0) return;
      region.cellSize = Math.max(Number(region.recommendedResolution), 0.25);
      const input = card.querySelector('[data-field="cellSize"]');
      if (input) input.value = Number(region.cellSize).toFixed(3);
      // Explicit user intent ("apply") — fire immediately.
      requestComputeVolumeRegion(region, { immediate: true });
    });
    card.querySelector('[data-field="displayDensity"]')?.addEventListener('change', event => {
      const value = parseNumberSafe(event.target.value);
      if (value === null || value <= 0) {
        event.target.value = Number(region.displayDensity).toFixed(1);
        toast('Invalid display density input', 'err', 1800);
        return;
      }
      region.displayDensity = clampVolumeDisplayDensity(value);
      event.target.value = region.displayDensity.toFixed(1);
      // R-5 (2026-05-07): displayDensity is purely a viz-side knob — re-sample
      // the existing cells locally instead of asking the server. If no cells
      // exist yet, the value is just stored and picked up by the next real job.
      if (region.computeState === 'ready' && Array.isArray(region.computedCells) && region.computedCells.length) {
        refreshVolumeRegionDisplaySamples(region);
        updateVolumeRegionOverlay(region);
        updatePanel();
      }
    });
    card.querySelector('[data-field="holeFillMode"]')?.addEventListener('change', event => {
      region.holeFillMode = event.target.value || 'interpolate';
      requestComputeVolumeRegion(region);
    });
    card.querySelector('[data-field="surfaceType"]')?.addEventListener('change', event => {
      region.surfaceType = event.target.value || 'stockpile';
      if (region.surfaceType === 'stockpile' && (!region.surfaceAggregateMode || region.surfaceAggregateMode === 'max')) {
        region.surfaceAggregateMode = 'p80';
      }
      updatePanel();
      requestComputeVolumeRegion(region);
    });
    card.querySelector('[data-field="surfaceAggregateMode"]')?.addEventListener('change', event => {
      region.surfaceAggregateMode = event.target.value || 'p80';
      requestComputeVolumeRegion(region);
    });
    card.querySelectorAll('[data-action="set-scenario"]').forEach(button => {
      button.addEventListener('click', () => {
        const nextScenario = button.dataset.value || 'stockpile_boundary';
        if (shouldConfirmScenarioSwitch(region, nextScenario)) {
          const ok = window.confirm(
            'Switching volume method will reset base surface, point filter, and surface mode defaults for this region. Continue?'
          );
          if (!ok) return;
        }
        applyScenarioDefaultsToRegion(region, nextScenario);
        applyRecommendedResolutionToRegion(region, nextScenario);
        updatePanel();
        // Switching scenario rewrites several fields in one go — fire a
        // single debounced compute rather than chaining one per field.
        requestComputeVolumeRegion(region);
      });
    });
    card.querySelector('[data-field="baseSurfaceMode"]')?.addEventListener('change', event => {
      region.baseSurfaceMode = event.target.value || 'boundary';
      updatePanel();
      requestComputeVolumeRegion(region);
    });
    card.querySelector('[data-field="pointFilterMode"]')?.addEventListener('change', event => {
      region.pointFilterMode = event.target.value || 'all';
      if (region.pointFilterMode === 'ground_only' && region.surfaceType === 'stockpile') {
        region.surfaceType = 'dtm';
      }
      updatePanel();
      requestComputeVolumeRegion(region);
    });

    let pickHeightActive = false;
    let pickHeightListener = null;
    let pickHeightEscListener = null;
    let pickHeightPreviousStatus = null;
    let pickHeightPreviousToolMode = null;
    const pickButton = card.querySelector('[data-action="pick-height"]');
    const endPickHeightMode = () => {
      if (!pickHeightActive) return;
      pickHeightActive = false;
      pickButton?.classList.remove('picking');
      if (pickHeightListener) viewer.renderer.domElement.removeEventListener('mousedown', pickHeightListener, true);
      if (pickHeightEscListener) document.removeEventListener('keydown', pickHeightEscListener);
      pickHeightListener = null;
      pickHeightEscListener = null;
      viewer.renderer.domElement.style.cursor = '';
      setToolMode?.(pickHeightPreviousToolMode || null);
      setStatus?.(pickHeightPreviousStatus || 'Ready');
      pickHeightPreviousStatus = null;
      pickHeightPreviousToolMode = null;
    };

    pickButton?.addEventListener('click', () => {
      if (pickHeightActive) {
        endPickHeightMode();
        return;
      }
      pickHeightPreviousToolMode = typeof getToolMode === 'function' ? getToolMode() : null;
      pickHeightPreviousStatus = typeof getStatus === 'function' ? getStatus() : null;
      stopCapture?.();
      clearDeleteSelection?.();
      cancelDeletePolygonSelection?.({ notify: false });
      resetVolumeSelectionState?.({ keepPending: true });
      pickHeightActive = true;
      pickButton.classList.add('picking');
      toast('Click a point in the cloud to pick elevation. Press ESC to cancel.', 'info', 0);
      viewer.renderer.domElement.style.cursor = 'crosshair';
      setToolMode?.('volume-pick-height');
      setStatus?.('Picking volume reference elevation...');

      pickHeightListener = event => {
        if (event.button !== 0 && event.button !== 2) return;
        event.preventDefault();
        event.stopPropagation();
        const pick = getVolumeSelectionPick(event);
        if (!pick) return;
        const value = pick.local.z;
        region.referenceHeight = value;
        card.querySelector('[data-field="referenceHeight"]').value = value.toFixed(3);
        toast(`Reference elevation picked: ${value.toFixed(3)}`, 'ok', 2000);
        endPickHeightMode();
        computeVolumeRegion(region);
      };
      pickHeightEscListener = event => {
        if (event.key !== 'Escape') return;
        toast('Elevation picking cancelled', 'info', 1500);
        endPickHeightMode();
      };
      viewer.renderer.domElement.addEventListener('mousedown', pickHeightListener, { once: true, capture: true });
      document.addEventListener('keydown', pickHeightEscListener);
    });

    card.querySelectorAll('[data-action="export-obj"]').forEach(button => {
      button.addEventListener('click', () => {
        const surface = getVolumeSurfaceState(region, button.dataset.role || 'analysis');
        if (!surface.jobId) return;
        exportVolumeSurfaceMesh?.(surface.jobId, 'obj', button.dataset.role || 'analysis');
      });
    });
    card.querySelector('[data-field="contourInterval"]')?.addEventListener('change', event => {
      const value = parseNumberSafe(event.target.value);
      if (value !== null && value > 0) region.contourInterval = value;
      else event.target.value = Number(region.contourInterval ?? 0.5).toFixed(2);
    });
    card.querySelectorAll('[data-action="set-contour-source"]').forEach(button => {
      button.addEventListener('click', () => {
        region.contourSourceRole = button.dataset.role === 'base' ? 'base' : 'analysis';
        updatePanel();
      });
    });
    card.querySelector('[data-action="gen-contours"]')?.addEventListener('click', () => {
      const role = getActiveContourSurfaceRole(region);
      region.contourSourceRole = role;
      const sourceSurface = getVolumeSurfaceState(region, role);
      const gridData = sourceSurface.gridData || null;
      if (!gridData) {
        toast(`Load ${sourceSurface.label.toLowerCase()} first, then generate contours.`, 'info', 2800);
        return;
      }
      const interval = Number(region.contourInterval ?? 0.5);
      const labelScale = Number(region.contourLabelScale ?? 1.0);
      generateContoursFromGrid?.(gridData, interval, {
        kind: 'volume',
        ownerRegionId: region.id,
        labelScale,
        attachPointcloudUuid: region.pointcloudUuid || null,
      });
      region.contoursVisible = true;
      updatePanel();
    });
    card.querySelector('[data-action="remove-contours"]')?.addEventListener('click', () => {
      removeContoursFrom3D?.('volume', region.id);
      region.contoursVisible = false;
      region.contourLabelsVisible = true;
      updatePanel();
    });
    card.querySelector('[data-action="toggle-labels"]')?.addEventListener('click', () => {
      const newVis = region.contourLabelsVisible === false;
      region.contourLabelsVisible = newVis;
      toggleContourLabels?.('volume', region.id, newVis);
      updatePanel();
    });
    card.querySelector('[data-field="contourLabelScale"]')?.addEventListener('change', event => {
      const value = parseNumberSafe(event.target.value);
      if (value !== null && value > 0) {
        region.contourLabelScale = value;
        resizeContourLabels?.('volume', region.id, value);
      } else {
        event.target.value = Number(region.contourLabelScale ?? 1.0).toFixed(1);
      }
    });
    card.querySelector('[data-action="export-dxf"]')?.addEventListener('click', () => {
      exportContoursAsDXF?.('volume', region.id);
    });
  }

  function updatePanel() {
    const meta = document.getElementById('volume-panel-meta');
    const note = document.getElementById('volume-panel-note');
    const cancelButton = document.getElementById('btn-volume-cancel');
    const clearButton = document.getElementById('btn-volume-clear-all');
    const state = getVolumeMeasureState();
    const hasRegions = state.regions.length > 0;
    const hasPendingSelection = Boolean(state.active || state.pendingRegion || (state.pendingPoints && state.pendingPoints.length));
    if (!meta || !note || !cancelButton || !clearButton) return;

    cancelButton.disabled = !hasPendingSelection;
    clearButton.disabled = !(hasRegions || hasPendingSelection);
    meta.textContent = state.active
      ? `Drawing boundary · ${fmtNum(state.pendingPoints.length)} vertices`
      : (hasRegions ? `Volume jobs · ${fmtNum(state.regions.length)}` : 'No volume jobs yet');
    note.textContent = state.active
      ? 'Double-click to confirm the boundary. The active workspace will keep method and result steps together.'
      : (hasRegions ? '' : 'Click "New" to start a guided volume measurement.');

    setVolumeOverlayVisible(state.active || hasRegions);
    renderPanelList();
    refresh();
  }

  function startSelection() {
    activateMeasureTab?.('volume');
    setStatus?.('Volume measurement ready');
  }

  function cancelSelection({ notify = false } = {}) {
    if (typeof cancelVolumeSelection === 'function') {
      cancelVolumeSelection({ notify });
      return;
    }
    resetVolumeSelectionState?.({ keepPending: false });
    setVolumeOverlayVisible(false);
    updatePanel();
    if (notify) toast('Current volume region drawing cancelled', 'info');
  }

  function clearAllVolumeState({ notify = true } = {}) {
    const state = getVolumeMeasureState();
    for (const region of state.regions || []) {
      clearPendingCompute(region.id);
      removeContoursFrom3D?.('volume', region.id);
    }
    clearAllVolumeRegions?.({ notify });
    setVolumeOverlayVisible(false);
    updatePanel();
  }

  function bindControls({ startVolumeMeasurement }) {
    if (controlsBound) return;
    controlsBound = true;
    startVolumeMeasurementHandler = startVolumeMeasurement || startSelection;
    const startHandler = event => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      startVolumeMeasurementHandler?.();
    };
    document.getElementById('btn-volume-start')?.addEventListener('click', startHandler);
    document.getElementById('btn-volume-cancel')?.addEventListener('click', () => cancelSelection({ notify: true }));
    document.getElementById('btn-volume-clear-all')?.addEventListener('click', () => {
      clearAllVolumeState({ notify: true });
    });
    document.getElementById('tb-volume')?.addEventListener('click', startHandler);
    document.getElementById('mi-t-volume')?.addEventListener('click', startHandler);

    const volumeToolbarButton = document.getElementById('tb-volume');
    if (volumeToolbarButton) {
      volumeToolbarButton.removeAttribute('disabled');
      volumeToolbarButton.removeAttribute('aria-disabled');
      volumeToolbarButton.setAttribute('title', 'Start a unified server-side volume measurement');
      volumeToolbarButton.classList.remove('is-disabled');
      volumeToolbarButton.style.opacity = '';
      volumeToolbarButton.style.pointerEvents = '';
    }

    const volumeMenuItem = document.getElementById('mi-t-volume');
    if (volumeMenuItem) {
      volumeMenuItem.setAttribute('title', 'Start a unified server-side volume measurement');
      volumeMenuItem.removeAttribute('aria-disabled');
      volumeMenuItem.style.opacity = '';
      volumeMenuItem.style.pointerEvents = 'auto';
    }

    const volumeStartButton = document.getElementById('btn-volume-start');
    if (volumeStartButton) {
      volumeStartButton.textContent = 'New';
      volumeStartButton.setAttribute('title', 'Start a unified server-side volume measurement');
    }
  }

  return {
    bindControls,
    refresh,
    startSelection,
    cancelSelection,
    updatePanel,
  };
}
