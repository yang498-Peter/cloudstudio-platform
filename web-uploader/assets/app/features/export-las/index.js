export function createExportLasFeature({
  fetchImpl = window.fetch.bind(window),
  translate,
  translateText,
  translateError,
  toast,
  getActiveDatasetContext,
  getExportContextQuery,
  getExportSourceOptions,
  setExportSourceOptions,
  buildDefaultExportFilename,
  updateExportUnitModeVisibility,
  updateExportLasNote,
  getCoordConfig,
  createDefaultCoordinateConfig,
  getCurrentResolvedCoordinateSystem,
  serializeDeleteRegions,
  resolveSelectedExportLinearUnit,
  escapeHtml,
  formatNumber,
} = {}) {
  let controlsBound = false;

  function getSelectedFormat() {
    return (document.getElementById('sel-export-format')?.value || 'las').toLowerCase();
  }

  function getSelectedPlyEncoding() {
    return (document.getElementById('sel-export-ply-encoding')?.value || 'binary').toLowerCase();
  }

  function getModalElements() {
    return {
      modal: document.getElementById('modal-export-las'),
      datasetSummary: document.getElementById('export-dataset-summary'),
      sourceSelect: document.getElementById('sel-export-source'),
      filenameInput: document.getElementById('inp-export-filename'),
      submitButton: document.getElementById('export-las-submit'),
      note: document.getElementById('export-las-note'),
    };
  }

  async function openExportLasModal() {
    const { modal, datasetSummary, sourceSelect, filenameInput } = getModalElements();
    modal.classList.add('open');
    sourceSelect.innerHTML = '';
    setExportSourceOptions([]);
    filenameInput.value = buildDefaultExportFilename();
    datasetSummary.className = 'modal-msg show info';
    datasetSummary.textContent = translate('viewer.export.readingSources', {}, 'Reading exportable LAS / LAZ source files...');
    updateExportUnitModeVisibility();

    const query = getExportContextQuery();
    if (!query) {
      datasetSummary.className = 'modal-msg show err';
      datasetSummary.textContent = translate('viewer.export.needDataset', {}, 'Load a point cloud or scanner project first.');
      updateExportLasNote();
      return;
    }

    try {
      const data = await fetchImpl(`/api/export-sources?${query}`).then(async response => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          const summary = translateError(json.errorCode, json.error || `HTTP ${response.status}`);
          throw new Error(summary);
        }
        return json;
      });
      setExportSourceOptions(data.sources || []);
      datasetSummary.className = 'modal-msg show info';
      datasetSummary.innerHTML = `${data.context?.type === 'scanner' ? translateText('Scanner project') : translateText('Point cloud')}: ${escapeHtml(data.context?.name || translateText('Unnamed'))}<br>${translateText('Found')} ${getExportSourceOptions().length} ${translateText('exportable source file(s)')}`;
      if (!getExportSourceOptions().length) {
        sourceSelect.innerHTML = `<option value="">${escapeHtml(translateText('No exportable source files'))}</option>`;
      } else {
        sourceSelect.innerHTML = getExportSourceOptions().map(item =>
          `<option value="${escapeHtml(item.relPath)}">${escapeHtml(item.name)} · ${escapeHtml(item.sizeLabel || translateText('Unknown size'))}</option>`
        ).join('');
      }
    } catch (error) {
      datasetSummary.className = 'modal-msg show err';
      datasetSummary.textContent = translate('viewer.export.sourcesFailed', { message: error.message }, `Failed to read export sources: ${error.message}`);
    }

    updateExportLasNote();
  }

  async function submitExportLas() {
    const { submitButton, note } = getModalElements();
    const activeDatasetContext = getActiveDatasetContext();
    if (!activeDatasetContext) {
      toast(translate('viewer.export.needDataset', {}, 'Load a point cloud or scanner project first.'), 'err');
      return;
    }

    submitButton.disabled = true;
    note.className = 'modal-msg show info';
    note.style.display = 'block';
      const format = getSelectedFormat().toUpperCase();
      note.textContent = translate('viewer.export.exporting', {}, `Exporting ${format}. Large point clouds may take a few minutes...`);

    try {
      const payload = {
        projectId: activeDatasetContext.type === 'scanner' ? activeDatasetContext.projectId : undefined,
        cloudName: activeDatasetContext.type === 'cloud' ? activeDatasetContext.cloudName : undefined,
        sourceRelPath: document.getElementById('sel-export-source').value,
        coordConfig: getCoordConfig() || createDefaultCoordinateConfig(),
        resolvedCoordinateSystem: getCurrentResolvedCoordinateSystem(),
        deleteRegions: serializeDeleteRegions(),
        exportOptions: {
          format: getSelectedFormat(),
          plyEncoding: getSelectedPlyEncoding(),
          transformMode: document.getElementById('sel-export-transform-mode').value,
          outputLinearUnit: resolveSelectedExportLinearUnit(),
          outputFilename: document.getElementById('inp-export-filename').value.trim(),
          includeCrsMetadata: document.getElementById('chk-export-crs').checked,
          includeExportMetadataVlr: document.getElementById('chk-export-vlr').checked,
        },
      };

      const data = await fetchImpl('/api/export-pointcloud', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async response => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.ok === false) {
          const localized = translateError(json.errorCode, json.summary || json.error || '');
          const details = [localized, json.summary, json.error, json.stderr].filter(Boolean).join('\n');
          throw new Error(details || `HTTP ${response.status}`);
        }
        return json;
      });

      note.className = 'modal-msg show ok';
      const deleteSummary = Number.isFinite(data.deletedPoints)
        ? `<br>${translateText('Deleted points')}: ${formatNumber(data.deletedPoints)}${Number.isFinite(data.writtenPoints) ? `, ${translateText('Written points')}: ${formatNumber(data.writtenPoints)}` : ''}`
        : '';
      note.innerHTML = `${translateText('Export completed')}: ${escapeHtml(data.outputFilename)}<br>${translateText('File size')}: ${escapeHtml(data.sizeLabel || translateText('Unknown'))}${data.plyEncoding ? `<br>PLY: ${escapeHtml(data.plyEncoding)}` : ''}${deleteSummary}${data.crsOmitReason ? `<br>${translateText('Note')}: ${escapeHtml(data.crsOmitReason)}` : ''}`;

      const link = document.createElement('a');
      link.href = data.downloadUrl;
      link.download = data.outputFilename;
      document.body.appendChild(link);
      link.click();
      link.remove();

      toast(`${(data.format || getSelectedFormat()).toUpperCase()} ${translateText('Export completed')}: ${data.outputFilename}`, 'ok', 5000);
    } catch (error) {
      const message = String(error.message || error);
      const detail = message.split('\n').filter(Boolean).slice(0, 3).join('\n');
      note.className = 'modal-msg show err';
      note.textContent = translate('viewer.export.failed', { message: detail || translate('viewer.export.unknownError', {}, 'Unknown error') }, `Export failed: ${detail || 'Unknown error'}`);
      toast(translate('viewer.export.failedShort', { message: detail || translate('viewer.export.unknownError', {}, 'Unknown error') }, `Point cloud export failed: ${detail || 'Unknown error'}`), 'err', 5000);
    } finally {
      submitButton.disabled = false;
    }
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('tb-export-las')?.addEventListener('click', openExportLasModal);
    document.getElementById('mi-export-las')?.addEventListener('click', openExportLasModal);
    document.getElementById('export-las-cancel')?.addEventListener('click', () => {
      getModalElements().modal.classList.remove('open');
    });
    document.getElementById('export-las-submit')?.addEventListener('click', submitExportLas);
    document.getElementById('sel-export-transform-mode')?.addEventListener('change', () => {
      document.getElementById('inp-export-filename').value = buildDefaultExportFilename();
      updateExportLasNote();
    });
    document.getElementById('sel-export-format')?.addEventListener('change', () => {
      document.getElementById('inp-export-filename').value = buildDefaultExportFilename();
      updateExportUnitModeVisibility();
      updateExportLasNote();
    });
    document.getElementById('sel-export-ply-encoding')?.addEventListener('change', updateExportLasNote);
    document.getElementById('sel-export-unit-mode')?.addEventListener('change', () => {
      updateExportUnitModeVisibility();
      updateExportLasNote();
    });
    document.getElementById('sel-export-custom-unit')?.addEventListener('change', updateExportLasNote);
    document.getElementById('sel-export-source')?.addEventListener('change', updateExportLasNote);
    document.getElementById('chk-export-crs')?.addEventListener('change', updateExportLasNote);
    document.getElementById('chk-export-vlr')?.addEventListener('change', updateExportLasNote);
  }

  return {
    bindControls,
    openExportLasModal,
    submitExportLas,
  };
}
