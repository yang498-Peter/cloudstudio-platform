export function createScannerRuntimeFeature({
  getScannerState,
  getLoadedScannerProjects,
  getCurrentScannerProjectId,
  getScannerProjectState,
  getVisiblePhotoCameras,
  escapeHtml,
  getFlyTrajectoryButtonLabel,
  formatTrajectoryFlySpeedLabel,
  stopScannerTimeline,
  setSelectedScannerProject,
  updateCoordinateFormVisibility,
  refreshCoordinateSystem,
  applyDisplaySettingsFromUI,
  readManualCoordinateConfigFromInputs,
  updateManualBuilderVisibility,
  previewAuthorityCodeFromUI,
  applyCoordinateConfigFromUI,
  resetCoordinateConfig,
  copyCoordinateOrigin,
  setCurrentCoordConfig,
  normalizeCoordinateConfig,
  createDefaultCoordinateConfig,
  importGridFile,
  saveCoordinateConfig,
  updateGridFileSummary,
  getAvailableServerGrids,
  attachServerGridRecord,
  removeServerGridRecord,
  refreshServerGridCatalog,
  tr,
  toast,
  buildTrajectory,
  buildCameraMarkers,
  viewer,
} = {}) {
  let controlsBound = false;

  function getState() {
    return getScannerState?.() || null;
  }

  function timelinePlayLabel(isPlaying = false) {
    return `${isPlaying ? '⏸' : '▶'} ${tr(isPlaying ? 'viewer.scanner.timeline.pause' : 'viewer.scanner.timeline.play', {}, isPlaying ? 'Pause' : 'Play')}`;
  }

  function applyProjectUiState(projectId = getCurrentScannerProjectId?.()) {
    const state = projectId ? getScannerProjectState?.(projectId) : null;
    const selectorPanel = document.getElementById('scanner-project-selector-panel');
    const selector = document.getElementById('sel-scanner-project');
    const loadedProjects = getLoadedScannerProjects?.() || [];
    if (selectorPanel) selectorPanel.style.display = loadedProjects.length > 1 ? '' : 'none';
    if (selector) {
      const current = selector.value;
      selector.innerHTML = loadedProjects.map(project => {
        const label = escapeHtml(project.projectName || project.projectId);
        return `<option value="${escapeHtml(project.projectId)}">${label}</option>`;
      }).join('');
      if (projectId && loadedProjects.some(project => project.projectId === projectId)) {
        selector.value = projectId;
      } else if (current && loadedProjects.some(project => project.projectId === current)) {
        selector.value = current;
      }
    }
    if (!state) return;

    document.getElementById('chk-traj').checked = Boolean(state.trajSettings?.visible);
    document.getElementById('r-traj-width').value = String(state.trajSettings?.width ?? 2.5);
    document.getElementById('l-traj-width').textContent = String(state.trajSettings?.width ?? 2.5);
    document.getElementById('r-traj-opacity').value = String(state.trajSettings?.opacity ?? 0.85);
    document.getElementById('l-traj-opacity').textContent = String(state.trajSettings?.opacity ?? 0.85);
    document.getElementById('sel-traj-color').value = state.trajSettings?.colorMode || 'time';
    document.getElementById('inp-traj-color').value = state.trajSettings?.solidColor || '#4078ff';
    document.getElementById('row-traj-solid').style.display = (state.trajSettings?.colorMode || 'time') === 'solid' ? '' : 'none';
    document.getElementById('chk-traj-arrows').checked = Boolean(state.trajSettings?.showArrows);

    document.getElementById('chk-cameras').checked = Boolean(state.cameraSettings?.visible);
    document.getElementById('r-cam-size').value = String(state.cameraSettings?.size ?? 0.15);
    document.getElementById('l-cam-size').textContent = String(state.cameraSettings?.size ?? 0.15);
    document.getElementById('chk-frustum').checked = Boolean(state.cameraSettings?.showFrustum);

    const timelinePlayButton = document.getElementById('btn-timeline-play');
    if (timelinePlayButton) {
      timelinePlayButton.textContent = timelinePlayLabel(Boolean(state.timelineAnim));
    }
    const flySpeed = Number(state.trajectoryFlySettings?.speed ?? 2);
    document.getElementById('r-traj-fly-speed').value = String(flySpeed);
    document.getElementById('l-traj-fly-speed').textContent = formatTrajectoryFlySpeedLabel?.(flySpeed) || `${flySpeed.toFixed(1)} m/s`;
    const flyTrajectoryButton = document.getElementById('btn-fly-traj');
    if (flyTrajectoryButton) {
      flyTrajectoryButton.disabled = !state.odomData || state.odomData.length < 2;
      flyTrajectoryButton.textContent = getFlyTrajectoryButtonLabel(Boolean(state.flyActive));
    }
  }

  function updateTimeline() {
    const state = getState();
    if (!state?.odomData?.length) return;
    const startSlider = document.getElementById('r-time-start');
    const endSlider = document.getElementById('r-time-end');
    if (!startSlider || !endSlider) return;
    const startValue = parseFloat(startSlider.value);
    const endValue = parseFloat(endSlider.value);
    const startLabel = document.getElementById('l-time-start');
    const endLabel = document.getElementById('l-time-end');
    if (startLabel) startLabel.textContent = `${(startValue * 100).toFixed(0)}%`;
    if (endLabel) endLabel.textContent = `${(endValue * 100).toFixed(0)}%`;

    const odom = state.odomData;
    const tMin = odom[0].t;
    const tMax = odom[odom.length - 1].t;
    const absStart = tMin + (tMax - tMin) * startValue;
    const absEnd = tMin + (tMax - tMin) * endValue;

    if (state.trajGroup) buildTrajectory?.();
    if (state.camGroup) {
      const leftCameras = getVisiblePhotoCameras?.(getCurrentScannerProjectId?.()) || state.cameras.filter(camera => camera.side === 'left');
      state.camGroup.children.forEach((sprite, index) => {
        if (index >= leftCameras.length) return;
        const cameraTime = leftCameras[index].timestamp;
        sprite.visible = cameraTime >= absStart && cameraTime <= absEnd;
      });
    }
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('sel-crs-mode')?.addEventListener('change', () => {
      const projectId = getCurrentScannerProjectId?.();
      setCurrentCoordConfig({
        ...normalizeCoordinateConfig(getState()?.coordConfig || createDefaultCoordinateConfig()),
        mode: document.getElementById('sel-crs-mode').value,
      }, projectId);
      updateCoordinateFormVisibility(projectId);
      refreshCoordinateSystem({ notify: false }, projectId);
    });
    document.getElementById('sel-global-unit')?.addEventListener('change', () => applyDisplaySettingsFromUI({ notify: true }));
    document.getElementById('sel-manual-projection')?.addEventListener('change', () => updateManualBuilderVisibility(readManualCoordinateConfigFromInputs()));
    document.getElementById('sel-manual-ellps')?.addEventListener('change', () => updateManualBuilderVisibility(readManualCoordinateConfigFromInputs()));
    document.getElementById('btn-resolve-crs-code')?.addEventListener('click', () => previewAuthorityCodeFromUI(getCurrentScannerProjectId?.()));
    document.getElementById('inp-crs-code')?.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      previewAuthorityCodeFromUI(getCurrentScannerProjectId?.());
    });
    document.getElementById('btn-apply-crs')?.addEventListener('click', () => applyCoordinateConfigFromUI({ notify: true }, getCurrentScannerProjectId?.()));
    document.getElementById('btn-reset-crs')?.addEventListener('click', () => resetCoordinateConfig(getCurrentScannerProjectId?.()));
    document.getElementById('btn-copy-crs-origin')?.addEventListener('click', copyCoordinateOrigin);
    document.getElementById('btn-add-grid-catalog')?.addEventListener('click', () => {
      const attachButton = document.getElementById('btn-add-grid-catalog');
      if (attachButton?.dataset.unifiedFallbackBound === '1' || attachButton?.dataset.unifiedStorageFallbackBound === '1') return;
      const gridId = document.getElementById('sel-grid-catalog').value;
      if (!gridId) {
        toast(tr('viewer.crs.chooseBuiltinGridFirst', {}, 'Choose a built-in grid first.'), 'info', 3000);
        return;
      }
      const record = getAvailableServerGrids().find(item => String(item?.id || item?.catalogId || '').trim() === gridId);
      if (!record) {
        toast(tr('viewer.crs.gridNotReady', {}, 'This built-in grid is not ready yet. Refresh the grid catalog first.'), 'info', 4000);
        return;
      }
      const projectId = getCurrentScannerProjectId?.();
      attachServerGridRecord(record, { notify: true, projectId });
      refreshCoordinateSystem({ notify: true }, projectId);
    });
    document.getElementById('btn-refresh-grid-catalog')?.addEventListener('click', () => refreshServerGridCatalog({ silent: false, projectId: getCurrentScannerProjectId?.() }));
    document.getElementById('sel-grid-catalog')?.addEventListener('change', event => {
      if (event.currentTarget?.dataset.unifiedFallbackBound === '1' || event.currentTarget?.dataset.unifiedStorageFallbackBound === '1') return;
      const gridId = event.target.value;
      if (!gridId) return;
      const record = getAvailableServerGrids().find(item => String(item?.id || item?.catalogId || '').trim() === gridId);
      if (!record) {
        toast(tr('viewer.crs.gridNotReady', {}, 'This built-in grid is not ready yet. Refresh the grid catalog first.'), 'info', 4000);
        return;
      }
      const state = getState();
      state.importedGridFile = {
        name: record.name || record.id,
        status: tr('viewer.crs.pendingAttach', {}, 'Pending attach'),
        note: tr('viewer.crs.selectedBuiltinGridNote', { usage: record.usageHint || record.primaryCapability || record.ext || 'grid' }, 'Built-in grid selected. Click "Attach" to add it to the current coordinate setup. Usage: {{usage}}.'),
      };
      updateGridFileSummary(getCurrentScannerProjectId?.());
    });
    document.getElementById('coord-grid-attached')?.addEventListener('click', event => {
      const button = event.target.closest('[data-grid-remove]');
      if (!button) return;
      removeServerGridRecord(button.getAttribute('data-grid-remove'), { notify: true, projectId: getCurrentScannerProjectId?.() });
    });
    document.getElementById('sel-scanner-project')?.addEventListener('change', event => {
      if (!event.target.value) return;
      setSelectedScannerProject(event.target.value, { syncContext: true });
    });
    document.getElementById('btn-grid-file-picker')?.addEventListener('click', async () => {
      const pickerButton = document.getElementById('btn-grid-file-picker');
      if (pickerButton?.dataset.unifiedFallbackBound === '1' || pickerButton?.dataset.unifiedStorageFallbackBound === '1') return;
      const input = document.getElementById('inp-grid-file');
      const state = getState();

      try {
        const response = await fetch('/api/grids/import-dialog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        if (data?.cancelled) return;
        if (data?.grid) {
          const projectId = getCurrentScannerProjectId?.();
          attachServerGridRecord(data.grid, { notify: true, projectId });
          await refreshServerGridCatalog({ silent: true, projectId });
          refreshCoordinateSystem({ notify: true }, projectId);
          return;
        }
      } catch (error) {
        console.warn('[CRS] Desktop grid picker unavailable, falling back to browser picker:', error);
        if (state) {
          state.importedGridFile = {
            name: tr('viewer.crs.gridFileButton', {}, 'Choose File'),
            status: tr('viewer.crs.pendingAttach', {}, 'Pending attach'),
            note: tr('viewer.crs.browserPickerFallback', {}, 'Desktop file picker is unavailable. Falling back to the browser file chooser.'),
          };
          updateGridFileSummary(getCurrentScannerProjectId?.());
        }
      }

      if (!input) return;
      try {
        if (typeof input.showPicker === 'function') {
          await input.showPicker();
        } else {
          input.click();
        }
      } catch {
        input.click();
      }
    });
    document.getElementById('inp-grid-file')?.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await importGridFile(file, getCurrentScannerProjectId?.());
      } catch (error) {
        const state = getState();
        state.importedGridFile = {
          name: file.name,
          status: tr('common.status.failed', {}, 'Failed'),
          note: error.message || String(error),
        };
        saveCoordinateConfig(getCurrentScannerProjectId?.());
        refreshCoordinateSystem({ notify: false }, getCurrentScannerProjectId?.());
        toast(`${tr('viewer.crs.gridImportFailed', {}, 'Grid / parameter import failed')}: ${error.message}`, 'err', 5000);
      } finally {
        event.target.value = '';
      }
    });

    document.getElementById('chk-traj')?.addEventListener('change', event => {
      const state = getState();
      state.trajSettings.visible = event.target.checked;
      if (state.trajGroup) state.trajGroup.visible = event.target.checked;
    });
    document.getElementById('sel-traj-color')?.addEventListener('change', event => {
      const state = getState();
      state.trajSettings.colorMode = event.target.value;
      document.getElementById('row-traj-solid').style.display = event.target.value === 'solid' ? '' : 'none';
      buildTrajectory?.();
    });
    document.getElementById('inp-traj-color')?.addEventListener('input', event => {
      getState().trajSettings.solidColor = event.target.value;
      buildTrajectory?.();
    });
    document.getElementById('r-traj-width')?.addEventListener('input', event => {
      document.getElementById('l-traj-width').textContent = event.target.value;
      getState().trajSettings.width = parseFloat(event.target.value);
      buildTrajectory?.();
    });
    document.getElementById('r-traj-opacity')?.addEventListener('input', event => {
      const state = getState();
      document.getElementById('l-traj-opacity').textContent = event.target.value;
      state.trajSettings.opacity = parseFloat(event.target.value);
      if (state.trajGroup) {
        state.trajGroup.traverse(child => { if (child.material) child.material.opacity = parseFloat(event.target.value); });
      }
    });
    document.getElementById('chk-traj-arrows')?.addEventListener('change', event => {
      const state = getState();
      state.trajSettings.showArrows = event.target.checked;
      buildTrajectory?.();
    });
    document.getElementById('r-traj-fly-speed')?.addEventListener('input', event => {
      const state = getState();
      const speed = Math.max(0.1, Number(event.target.value) || 2);
      if (state) {
        state.trajectoryFlySettings = {
          ...(state.trajectoryFlySettings || {}),
          speed,
        };
      }
      document.getElementById('l-traj-fly-speed').textContent = formatTrajectoryFlySpeedLabel?.(speed) || `${speed.toFixed(1)} m/s`;
    });

    document.getElementById('chk-cameras')?.addEventListener('change', event => {
      const state = getState();
      state.cameraSettings.visible = event.target.checked;
      if (state.camGroup) state.camGroup.visible = event.target.checked;
      if (state.frustumGroup) state.frustumGroup.visible = event.target.checked && document.getElementById('chk-frustum').checked;
    });
    document.getElementById('r-cam-size')?.addEventListener('input', event => {
      const state = getState();
      document.getElementById('l-cam-size').textContent = event.target.value;
      state.cameraSettings.size = parseFloat(event.target.value);
      buildCameraMarkers?.();
    });
    document.getElementById('chk-frustum')?.addEventListener('change', event => {
      getState().cameraSettings.showFrustum = event.target.checked;
      buildCameraMarkers?.();
    });

    document.getElementById('chk-timeline')?.addEventListener('change', event => {
      document.getElementById('timeline-controls').style.display = event.target.checked ? '' : 'none';
      if (!event.target.checked) {
        const state = getState();
        if (state.trajGroup) state.trajGroup.visible = document.getElementById('chk-traj').checked;
        if (state.camGroup) state.camGroup.visible = document.getElementById('chk-cameras').checked;
        viewer.scene.pointclouds.forEach(pointcloud => {
          if (pointcloud.material.activeAttributeName === 'gps-time') {
            pointcloud.material.activeAttributeName = 'rgba';
          }
        });
      }
    });
    document.getElementById('r-time-start')?.addEventListener('input', updateTimeline);
    document.getElementById('r-time-end')?.addEventListener('input', updateTimeline);
    document.getElementById('btn-timeline-play')?.addEventListener('click', function () {
      const state = getState();
      if (state.timelineAnim) {
        clearInterval(state.timelineAnim);
        state.timelineAnim = null;
        this.textContent = timelinePlayLabel(false);
        return;
      }
      this.textContent = timelinePlayLabel(true);
      const slider = document.getElementById('r-time-end');
      slider.value = 0;
      document.getElementById('r-time-start').value = 0;
      state.timelineAnim = setInterval(() => {
        let value = parseFloat(slider.value) + 0.005;
        if (value > 1) {
          value = 1;
          stopScannerTimeline(getCurrentScannerProjectId?.());
          document.getElementById('btn-timeline-play').textContent = timelinePlayLabel(false);
        }
        slider.value = value;
        updateTimeline();
      }, 50);
    });
    document.getElementById('btn-timeline-reset')?.addEventListener('click', () => {
      const state = getState();
      if (state.timelineAnim) {
        stopScannerTimeline(getCurrentScannerProjectId?.());
        document.getElementById('btn-timeline-play').textContent = timelinePlayLabel(false);
      }
      document.getElementById('r-time-start').value = 0;
      document.getElementById('r-time-end').value = 1;
      updateTimeline();
    });
  }

  return {
    applyProjectUiState,
    bindControls,
    updateTimeline,
  };
}
