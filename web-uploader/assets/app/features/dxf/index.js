export function createDxfFeature({
  getFiles,
  escapeHtml,
  translate,
  translateText,
  loadFile,
  removeFile,
  toggleLayer,
  clearAll,
} = {}) {
  let controlsBound = false;

  function tt(text) {
    return typeof translateText === 'function' ? translateText(text) : text;
  }

  function tk(key, fallback, vars = {}) {
    return typeof translate === 'function' ? translate(key, vars, fallback) : tt(fallback);
  }

  function renderPanel() {
    const files = getFiles();
    const dropZone = document.getElementById('dxf-drop-zone');
    const fileList = document.getElementById('dxf-file-list');
    const globalControls = document.getElementById('dxf-global-ctrl');
    if (!dropZone || !fileList) return;

    if (!files.length) {
      dropZone.style.display = '';
      fileList.style.display = 'none';
      globalControls.style.display = 'none';
      return;
    }

    dropZone.style.display = 'none';
    fileList.style.display = 'flex';
    globalControls.style.display = '';
    fileList.innerHTML = '';

    for (const file of files) {
      const item = document.createElement('div');
      item.className = 'dxf-file-item';

      const header = document.createElement('div');
      header.className = 'dxf-file-header';
      header.innerHTML = `
        <span class="dxf-file-icon">📐</span>
        <span class="dxf-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
        <span class="dxf-stats-bar">${tk('viewer.dxf.file.entityCount', '{{count}} entities', { count: file.totalEntities })}</span>
        <button class="dxf-file-remove" title="${escapeHtml(tk('viewer.dxf.file.removeTitle', 'Remove this file'))}" data-dxf-remove="${file.id}">✕</button>`;
      item.appendChild(header);

      const layerList = document.createElement('div');
      layerList.className = 'dxf-layer-list';
      for (const [layerName, layer] of file.layers) {
        const row = document.createElement('div');
        row.className = `dxf-layer-row${layer.visible ? '' : ' hidden'}`;
        row.title = `${tk('viewer.dxf.file.layerTitle', 'Layer')}: ${layerName}`;
        const eyeIcon = layer.visible ? '👁' : '🚫';
        row.innerHTML = `
          <div class="dxf-layer-swatch" style="background:${layer.color}"></div>
          <span class="dxf-layer-name">${escapeHtml(layerName)}</span>
          <span class="dxf-layer-count">${layer.count}</span>
          <button class="dxf-layer-eye" title="${escapeHtml(tk('viewer.dxf.file.toggleVisibility', 'Toggle visibility'))}" data-dxf-toggle="${file.id}" data-dxf-layer="${escapeHtml(layerName)}">${eyeIcon}</button>`;
        layerList.appendChild(row);
      }

      item.appendChild(layerList);
      item.addEventListener('click', event => {
        const removeTarget = event.target.closest('[data-dxf-remove]');
        if (removeTarget) {
          removeFile(Number(removeTarget.getAttribute('data-dxf-remove')));
          return;
        }
        const toggleTarget = event.target.closest('[data-dxf-toggle]');
        if (toggleTarget) {
          toggleLayer(
            Number(toggleTarget.getAttribute('data-dxf-toggle')),
            toggleTarget.getAttribute('data-dxf-layer')
          );
        }
      });
      fileList.appendChild(item);
    }
  }

  function bindInputs() {
    if (controlsBound) return;
    controlsBound = true;

    const input = document.getElementById('dxf-file-input');
    const dropZone = document.getElementById('dxf-drop-zone');
    const addMoreButton = document.getElementById('btn-dxf-add-more');
    const clearAllButton = document.getElementById('btn-dxf-clear-all');
    if (input) {
      input.addEventListener('change', event => {
        Array.from(event.target.files || []).forEach(loadFile);
        input.value = '';
      });
    }

    if (dropZone && input) {
      dropZone.addEventListener('click', () => input.click());
      dropZone.addEventListener('dragover', event => {
        event.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop', event => {
        event.preventDefault();
        event.stopPropagation();
        dropZone.classList.remove('drag-over');
        Array.from(event.dataTransfer.files || [])
          .filter(file => file.name.toLowerCase().endsWith('.dxf'))
          .forEach(loadFile);
      });
    }

    if (addMoreButton && input) {
      addMoreButton.addEventListener('click', () => input.click());
    }
    if (clearAllButton) {
      clearAllButton.addEventListener('click', clearAll);
    }

    document.addEventListener('dragover', event => {
      if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
        event.preventDefault();
      }
    });
    document.addEventListener('drop', event => {
      if (event.defaultPrevented) return;
      const dxfFiles = Array.from(event.dataTransfer?.files || []).filter(file => file.name.toLowerCase().endsWith('.dxf'));
      if (!dxfFiles.length) return;
      event.preventDefault();
      dxfFiles.forEach(loadFile);
    });

  }

  return {
    renderPanel,
    bindInputs,
  };
}
