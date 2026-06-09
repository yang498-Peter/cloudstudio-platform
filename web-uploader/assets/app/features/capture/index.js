export function createCaptureFeature({
  getCaptureState,
  setCaptureState,
  translate,
  escapeHtml,
  convertLocalPointToCurrentSystem,
  getScenePointDisplayCoordinate,
  formatLinearAxis,
  removeMarker,
  addMarker,
} = {}) {
  let controlsBound = false;

  function getPointDisplayCoordinate(point) {
    if (typeof getScenePointDisplayCoordinate === 'function') {
      const displayed = getScenePointDisplayCoordinate(
        { x: point.x, y: point.y, z: point.z },
        point.scannerProjectId || point.projectId || null
      );
      if (displayed && !displayed.error) return displayed;
    }
    return convertLocalPointToCurrentSystem({ x: point.x, y: point.y, z: point.z }, point.scannerProjectId || point.projectId || null);
  }

  function updatePanelUI() {
    const state = getCaptureState();
    const badge = document.getElementById('cap-status-badge');
    const statusText = document.getElementById('cap-status-text');
    const toggleButton = document.getElementById('btn-cap-toggle');
    const exportButton = document.getElementById('btn-cap-export');
    const clearButton = document.getElementById('btn-cap-clear');
    const countElement = document.getElementById('cap-count');

    if (state.active) {
      badge.classList.add('active');
      statusText.textContent = translate('viewer.capture.statusActive', {}, 'Capturing…');
      toggleButton.innerHTML = `<span class="btn-icon" data-cs-icon="close"></span><span>${translate('viewer.capture.stop', {}, 'Stop Capture')}</span>`;
      toggleButton.classList.add('active');
    } else {
      badge.classList.remove('active');
      statusText.textContent = translate('viewer.capture.statusIdle', {}, 'Idle');
      toggleButton.innerHTML = `<span class="btn-icon" data-cs-icon="capture"></span><span>${translate('viewer.capture.start', {}, 'Start Capture')}</span>`;
      toggleButton.classList.remove('active');
    }
    window.renderAppIcons?.(toggleButton);

    const hasPoints = state.points.length > 0;
    exportButton.disabled = !hasPoints;
    clearButton.disabled = !hasPoints;
    countElement.textContent = state.points.length;
  }

  function renderList() {
    const state = getCaptureState();
    const list = document.getElementById('cap-list');
    const empty = document.getElementById('cap-empty');
    if (!state.points.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    list.innerHTML = '';

    state.points.forEach((point, index) => {
      const row = document.createElement('div');
      row.className = 'cap-row';
      row.dataset.id = point.id;

      const featureHtml = escapeHtml(point.feature || '—');
      const attributeHtml = escapeHtml(point.attribute || '');

      let coordsHtml = `<div class="cap-small-coords" style="font-size:12px; font-weight: 500;">XYZ (m): ${point.x.toFixed(3)}  ${point.y.toFixed(3)}  ${point.z.toFixed(3)}</div>`;
      const converted = getPointDisplayCoordinate(point);
      if (converted && !converted.error && converted.kind !== 'local') {
        if (converted.kind === 'projected') {
          const xyUnit = converted.xyUnitSpec || 'm';
          coordsHtml = `
            <div class="cap-small-coords" style="font-size:12px; color:var(--text); font-weight:500;">ENH: E ${formatLinearAxis(converted.x, xyUnit)} / N ${formatLinearAxis(converted.y, xyUnit)} / H ${formatLinearAxis(converted.z, 'm')}</div>
          `;
        } else if (converted.kind === 'geographic') {
          coordsHtml = `
            <div class="cap-small-coords" style="font-size:12px; color:var(--text); font-weight:500;">LLH: ${converted.lon.toFixed(8)}  ${converted.lat.toFixed(8)}  H ${formatLinearAxis(converted.alt, 'm')}</div>
          `;
        }
      }

      const featureLabel = translate('viewer.capture.feature', {}, 'Feature');
      const attributeLabel = translate('viewer.capture.attribute', {}, 'Attribute');
      const cancelLabel = translate('common.actions.cancel', {}, 'Cancel');
      const saveLabel = translate('common.actions.save', {}, 'Save');
      const deleteTitle = translate('common.actions.delete', {}, 'Delete');

      row.innerHTML = `
        <div class="cap-row-head">
          <span class="cap-row-id">#${point.id}</span>
          <span class="cap-row-feat" title="${featureHtml}">${featureHtml}</span>
          <button class="cap-row-del" title="${deleteTitle}" data-cap-delete="${point.id}"><span data-cs-icon="trash"></span></button>
        </div>
        ${attributeHtml ? `<div class="cap-row-attr" title="${attributeHtml}">${attributeHtml}</div>` : ''}
        <div class="cap-row-coords">${coordsHtml}</div>
        <div class="cap-row-edit-form" id="cap-edit-${point.id}">
          <div class="cap-row-edit-row">
            <span class="cap-row-edit-label">${featureLabel}</span>
            <input class="cap-input" type="text" id="cap-ef-${point.id}" value="${featureHtml}">
          </div>
          <div class="cap-row-edit-row">
            <span class="cap-row-edit-label">${attributeLabel}</span>
            <input class="cap-input" type="text" id="cap-ea-${point.id}" value="${attributeHtml}">
          </div>
          <div class="cap-edit-actions">
            <button class="btn" data-cap-cancel="${point.id}">${cancelLabel}</button>
            <button class="btn pri" data-cap-save="${point.id}">${saveLabel}</button>
          </div>
        </div>`;

      row.addEventListener('click', event => {
        const actionTarget = event.target.closest('[data-cap-delete],[data-cap-cancel],[data-cap-save]');
        if (actionTarget?.hasAttribute('data-cap-delete')) {
          deletePoint(Number(actionTarget.getAttribute('data-cap-delete')));
          return;
        }
        if (actionTarget?.hasAttribute('data-cap-cancel')) {
          cancelEdit(Number(actionTarget.getAttribute('data-cap-cancel')));
          return;
        }
        if (actionTarget?.hasAttribute('data-cap-save')) {
          saveEdit(Number(actionTarget.getAttribute('data-cap-save')));
          return;
        }
        if (event.target.closest('.cap-row-edit-form')) return;

        const form = document.getElementById(`cap-edit-${point.id}`);
        if (!form) return;
        const wasOpen = form.classList.contains('show');
        document.querySelectorAll('.cap-row-edit-form.show').forEach(element => element.classList.remove('show'));
        if (!wasOpen) form.classList.add('show');
      });

      list.appendChild(row);
      window.renderAppIcons?.(row);
    });
  }

  function findPointIndexById(pointId) {
    const state = getCaptureState();
    return state.points.findIndex(point => Number(point?.id) === Number(pointId));
  }

  function deletePoint(pointId) {
    const state = getCaptureState();
    const index = findPointIndexById(pointId);
    if (index < 0) return;
    const point = state.points[index];
    if (point?.marker) removeMarker(point.marker);
    state.points.splice(index, 1);
    renderList();
    updatePanelUI();
  }

  function cancelEdit(pointId) {
    const form = document.getElementById(`cap-edit-${pointId}`);
    if (form) form.classList.remove('show');
  }

  function saveEdit(pointId) {
    const state = getCaptureState();
    const index = findPointIndexById(pointId);
    if (!state.points[index]) return;
    const feature = document.getElementById(`cap-ef-${pointId}`)?.value.trim() || '';
    const attribute = document.getElementById(`cap-ea-${pointId}`)?.value.trim() || '';
    state.points[index].feature = feature;
    state.points[index].attribute = attribute;
    if (state.points[index].marker) {
      removeMarker(state.points[index].marker);
      const point = state.points[index];
      state.points[index].marker = addMarker({ x: point.x, y: point.y, z: point.z }, point.id, feature);
    }
    renderList();
  }

  function bindControls({ startCapture, stopCapture, exportCaptureCsv, clearCapture }) {
    if (controlsBound) return;
    controlsBound = true;

    const toggleButton = document.getElementById('btn-cap-toggle');
    const exportButton = document.getElementById('btn-cap-export');
    const clearButton = document.getElementById('btn-cap-clear');
    const toolbarButton = document.getElementById('tb-capture');
    if (toggleButton) {
      toggleButton.addEventListener('click', () => {
        const state = getCaptureState();
        if (state.active) stopCapture(); else startCapture();
      });
    }
    if (exportButton) exportButton.addEventListener('click', exportCaptureCsv);
    if (clearButton) clearButton.addEventListener('click', clearCapture);
    if (toolbarButton) toolbarButton.addEventListener('click', startCapture);
  }

  return {
    renderList,
    updatePanelUI,
    deletePoint,
    cancelEdit,
    saveEdit,
    bindControls,
  };
}
