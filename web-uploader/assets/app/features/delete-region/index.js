function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createDeleteRegionFeature({
  getDeleteSelectionState,
  getDeleteRegionDisplayName,
  getViewer,
  translate,
  translateText,
  applyTranslations,
  formatDeleteRegionSummary,
  cancelDeletePolygonSelection,
  removeDeleteRegion,
  clearAllDeleteRegions,
  applyPendingDeleteRegion,
  refreshVolumes,
  toast,
  viewer,
  stopCapture,
  cancelVolumeSelection,
  hideAllVolumeRegionOverlays,
  resetDeleteSelectionState,
  ensureDeleteSelectionSvg,
  registerDeleteSelectionHandlers,
  setToolMode,
  setStatus,
  activateClipTab,
  exportFilteredPointCloudAndOpen,
} = {}) {
  let controlsBound = false;
  let exportState = {
    busy: false,
    progress: 0,
    message: '',
  };

  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') {
      return translate(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  function getRuntimeViewer() {
    return typeof getViewer === 'function' ? getViewer() : viewer;
  }

  function getRegionName(region) {
    if (typeof getDeleteRegionDisplayName === 'function') {
      return getDeleteRegionDisplayName(region);
    }
    return region?.name || t('viewer.deleteRegion.regionLabel', 'Delete Region');
  }

  function getWorkspace() {
    return document.getElementById('delete-region-workspace');
  }

  function ensureWorkspaceShell() {
    const root = getWorkspace();
    if (!root) return null;
    if (root.dataset.deleteRegionShell === 'ready') return root;

    root.classList.add('clip-delete-shell', 'polygon-delete-shell');
    root.dataset.deleteRegionShell = 'ready';
    root.innerHTML = `
      <div class="clip-delete-head" data-i18n-auto-root>
        <div>
          <div class="pg-label clip-delete-title"></div>
          <div class="clip-delete-subtitle" id="delete-region-subtitle"></div>
        </div>
        <button class="btn pri clip-delete-start" id="btn-delete-region-start"></button>
      </div>
      <div class="clip-delete-meta-row">
        <div id="delete-crop-meta" class="clip-delete-meta"></div>
        <div id="delete-crop-state" class="clip-delete-state"></div>
      </div>
      <div id="delete-crop-note" class="clip-delete-note"></div>
      <div class="clip-delete-actions">
        <button class="btn pri" id="btn-delete-crop-apply"></button>
        <button class="btn" id="btn-delete-crop-cancel"></button>
        <button class="btn" id="btn-delete-crop-clear-all"></button>
      </div>
      <div class="clip-export-block" id="delete-region-export-block">
        <button class="btn pri clip-export-open" id="btn-delete-crop-export-open">
          <span class="clip-export-icon" aria-hidden="true"></span>
          <span class="clip-action-label"></span>
        </button>
        <div class="clip-export-progress" id="delete-region-export-progress" hidden>
          <div class="clip-export-progress-bar"><span></span></div>
          <div class="clip-export-progress-text"></div>
        </div>
        <div class="clip-export-hint" id="delete-region-export-hint"></div>
      </div>
      <div id="delete-region-list" class="delete-panel-list"></div>
    `;
    return root;
  }

  function renderLists() {
    ensureWorkspaceShell();
    const state = getDeleteSelectionState();
    const target = document.getElementById('delete-region-list');
    if (!target) return;

    const entries = [];
    state.stagedRegions?.forEach(region => entries.push({ region, pending: true }));
    state.regions.forEach(region => entries.push({ region, pending: false }));

    target.innerHTML = '';
    if (!entries.length) {
      target.innerHTML = `<div class="left-empty">${escapeHtml(t('viewer.deleteRegion.empty', 'No delete regions'))}</div>`;
      return;
    }

    entries.forEach(({ region, pending }) => {
      const displayName = getRegionName(region);
      const card = document.createElement('div');
      card.className = `delete-region-card${pending ? ' pending' : ''}`;
      card.innerHTML = `
        <span>${pending ? '🔴' : '🧹'}</span>
        <div class="delete-region-text">
          <div class="delete-region-name">${escapeHtml(
            pending
              ? t('viewer.deleteRegion.pendingRegionLabel', `Pending Delete · ${displayName}`, { name: displayName })
              : displayName
          )}</div>
          <div class="delete-region-sub">${escapeHtml(
            pending
              ? `${formatDeleteRegionSummary(region)} | ${t('viewer.deleteRegion.previewBadge', 'Highlight preview')}`
              : formatDeleteRegionSummary(region)
          )}</div>
        </div>
        <button class="icon-btn del" title="${escapeHtml(
          pending
            ? t('viewer.deleteRegion.removePending', 'Remove pending region')
            : t('viewer.deleteRegion.removeApplied', 'Remove delete region')
        )}">✕</button>`;
      card.querySelector('button')?.addEventListener('click', () => removeDeleteRegion(region.id));
      target.appendChild(card);
    });
  }

  function updatePanel() {
    const root = ensureWorkspaceShell();
    if (!root) return;

    const title = root.querySelector('.clip-delete-title');
    const subtitle = document.getElementById('delete-region-subtitle');
    const meta = document.getElementById('delete-crop-meta');
    const stateBadge = document.getElementById('delete-crop-state');
    const applyButton = document.getElementById('btn-delete-crop-apply');
    const cancelButton = document.getElementById('btn-delete-crop-cancel');
    const clearButton = document.getElementById('btn-delete-crop-clear-all');
    const exportButton = document.getElementById('btn-delete-crop-export-open');
    const exportProgress = document.getElementById('delete-region-export-progress');
    const exportProgressFill = exportProgress?.querySelector('.clip-export-progress-bar span');
    const exportProgressText = exportProgress?.querySelector('.clip-export-progress-text');
    const exportHint = document.getElementById('delete-region-export-hint');
    const startButton = document.getElementById('btn-delete-region-start');
    const note = document.getElementById('delete-crop-note');
    const state = getDeleteSelectionState();
    if (!title || !subtitle || !meta || !stateBadge || !applyButton || !cancelButton || !clearButton || !exportButton || !startButton || !note) return;

    const stagedCount = state.stagedRegions?.length || 0;
    const appliedCount = state.regions?.length || 0;
    const hasPending = stagedCount > 0;
    const hasApplied = appliedCount > 0;

    title.textContent = t('viewer.deleteRegion.workspaceTitle', 'Polygon Delete');
    subtitle.textContent = t(
      'viewer.deleteRegion.workspaceSubtitle',
      'Build multiple pending regions, preview them on the currently visible cloud, then delete once.'
    );

    startButton.textContent = state.active
      ? t('viewer.deleteRegion.selecting', 'Selecting...')
      : (hasPending || hasApplied
        ? t('viewer.deleteRegion.addAnother', 'Add another region')
        : t('viewer.deleteRegion.start', 'Start selection'));
    startButton.disabled = Boolean(state.active || exportState.busy);

    applyButton.textContent = t('viewer.deleteRegion.apply', 'Delete selected regions');
    cancelButton.textContent = t('viewer.deleteRegion.cancel', 'Cancel current selection');
    clearButton.textContent = t('viewer.deleteRegion.clearAll', 'Clear all delete regions');
    exportButton.querySelector('.clip-action-label').textContent = t('viewer.deleteRegion.exportOpen', 'Export remaining LAS and open');

    applyButton.disabled = !hasPending || exportState.busy;
    cancelButton.disabled = !state.active || exportState.busy;
    clearButton.disabled = (!hasPending && !hasApplied) || exportState.busy;
    exportButton.disabled = !hasApplied || exportState.busy;

    meta.textContent = hasPending
      ? t('viewer.deleteRegion.metaPending', 'Pending {{pending}} | Applied {{applied}}', {
        pending: stagedCount,
        applied: appliedCount,
      })
      : (hasApplied
        ? t('viewer.deleteRegion.metaApplied', 'Applied delete regions {{count}}', { count: appliedCount })
        : t('viewer.deleteRegion.metaIdle', 'No pending selection'));

    stateBadge.textContent = state.active
      ? t('viewer.deleteRegion.stateSelecting', 'Drawing')
      : (hasPending
        ? t('viewer.deleteRegion.statePending', 'Previewing')
        : (hasApplied
          ? t('viewer.deleteRegion.stateApplied', 'Applied')
          : t('viewer.deleteRegion.stateIdle', 'Idle')));
    stateBadge.className = `clip-delete-state ${state.active ? 'active' : (hasPending ? 'pending' : '')}`;

    note.textContent = state.active
      ? t('viewer.deleteRegion.noteActive', 'Click to add vertices. Double-click to confirm. The preview stays on the currently visible cloud so you can keep selecting.')
      : (hasPending
        ? t('viewer.deleteRegion.notePending', 'Highlighted preview regions are pending deletion. Keep adding more, then apply them all at once.')
        : (hasApplied
          ? t('viewer.deleteRegion.noteApplied', 'Applied regions are hidden immediately and will also be excluded from later LAS exports.')
          : t('viewer.deleteRegion.noteIdle', 'Start a polygon selection to preview and batch-delete point cloud regions.')));

    if (exportHint) {
      exportHint.textContent = hasApplied
        ? t('viewer.deleteRegion.exportHintReady', 'Exports the current point cloud with applied delete regions removed, then opens it as a new point cloud.')
        : t('viewer.deleteRegion.exportHintNeedApplied', 'Apply at least one delete region before exporting the remaining LAS.');
    }
    if (exportProgress) {
      exportProgress.hidden = !exportState.busy;
    }
    if (exportProgressFill) {
      exportProgressFill.style.width = `${Math.max(0, Math.min(100, exportState.progress))}%`;
    }
    if (exportProgressText) {
      exportProgressText.textContent = exportState.message;
    }

    renderLists();
    refreshVolumes?.();
    applyTranslations?.(root);
  }

  function setExportProgress(progress, message) {
    exportState = {
      busy: true,
      progress: Math.max(0, Math.min(100, Math.round(Number(progress) || 0))),
      message: message || t('viewer.deleteRegion.exporting', 'Exporting delete-region result for download...'),
    };
    updatePanel();
  }

  async function exportAndOpen() {
    if (exportState.busy) return;
    const state = getDeleteSelectionState();
    if (!state.regions?.length) {
      toast?.(t('viewer.deleteRegion.exportNeedApplied', 'Apply at least one delete region before exporting.'), 'err');
      return;
    }
    if (typeof exportFilteredPointCloudAndOpen !== 'function') {
      toast?.(t('viewer.deleteRegion.exportUnavailable', 'Delete-region export is not available. Refresh the viewer and try again.'), 'err');
      return;
    }
    try {
      setExportProgress(8, t('viewer.deleteRegion.exporting', 'Exporting delete-region result for download...'));
      await exportFilteredPointCloudAndOpen?.({
        reason: 'delete',
        onProgress: event => setExportProgress(event?.progress, event?.message),
      });
      setExportProgress(100, t('viewer.deleteRegion.exportComplete', 'Delete-region LAS exported. Download started.'));
      toast?.(t('viewer.deleteRegion.exportComplete', 'Delete-region LAS exported. Download started.'), 'ok', 4000);
    } catch (error) {
      toast?.(t('viewer.deleteRegion.exportFailed', 'Delete-region export failed: {{message}}', { message: error?.message || error }), 'err', 6000);
    } finally {
      exportState = { busy: false, progress: 0, message: '' };
      updatePanel();
    }
  }

  function startSelection() {
    const runtimeViewer = getRuntimeViewer();
    if (!runtimeViewer?.scene?.pointclouds?.length) {
      toast?.(t('viewer.deleteRegion.needPointCloud', 'Please load a point cloud first'), 'err');
      return;
    }
    stopCapture?.();
    cancelVolumeSelection?.({ notify: false });
    hideAllVolumeRegionOverlays?.();
    resetDeleteSelectionState?.({ keepPending: true });

    const state = getDeleteSelectionState();
    state.panelDismissed = false;
    state.active = true;
    state.pendingPoints = [];

    ensureDeleteSelectionSvg?.();
    setToolMode?.('polygon-delete');
    setStatus?.(t('viewer.deleteRegion.statusDrawing', 'Drawing delete region... click to add vertices, double-click to confirm'));
    activateClipTab?.();
    registerDeleteSelectionHandlers?.();
    updatePanel();
    toast?.(t('viewer.deleteRegion.toastStart', 'Started polygon delete selection. You can keep adding multiple regions.'), 'info', 2800);
  }

  function bindControls({ startDeletePolygonSelection }) {
    ensureWorkspaceShell();
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('btn-delete-region-start')?.addEventListener('click', startDeletePolygonSelection || startSelection);
    document.getElementById('btn-delete-crop-apply')?.addEventListener('click', applyPendingDeleteRegion);
    document.getElementById('btn-delete-crop-cancel')?.addEventListener('click', () => cancelDeletePolygonSelection({ notify: true }));
    document.getElementById('btn-delete-crop-clear-all')?.addEventListener('click', () => clearAllDeleteRegions({ notify: true }));
    document.getElementById('btn-delete-crop-export-open')?.addEventListener('click', exportAndOpen);
    document.getElementById('tb-delete-poly')?.addEventListener('click', startDeletePolygonSelection || startSelection);
    document.getElementById('mi-t-delete-poly')?.addEventListener('click', startDeletePolygonSelection || startSelection);
    document.getElementById('btn-delete-select')?.addEventListener('click', startDeletePolygonSelection || startSelection);
  }

  return {
    bindControls,
    renderLists,
    startSelection,
    updatePanel,
  };
}
