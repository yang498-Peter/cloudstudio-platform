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
  syncActiveDatasetContext,
  buildDefaultExportFilename,
  updateExportUnitModeVisibility,
  updateExportLasNote,
  getCoordConfig,
  createDefaultCoordinateConfig,
  getCurrentResolvedCoordinateSystem,
  serializeDeleteRegions,
  serializeClipBoxes,
  getClipMode,
  resolveSelectedExportLinearUnit,
  escapeHtml,
  formatNumber,
} = {}) {
  let controlsBound = false;
  let exportBusy = false;
  let progressTimer = null;
  let progressValue = 0;

  function t(key, fallback, vars = {}) {
    return typeof translate === 'function' ? translate(key, vars, fallback) : fallback;
  }

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
      transformModeSelect: document.getElementById('sel-export-transform-mode'),
      filenameInput: document.getElementById('inp-export-filename'),
      submitButton: document.getElementById('export-las-submit'),
      cancelButton: document.getElementById('export-las-cancel'),
      progress: document.getElementById('export-las-progress'),
      progressFill: document.getElementById('export-las-progress-fill'),
      progressText: document.getElementById('export-las-progress-text'),
      note: document.getElementById('export-las-note'),
    };
  }

  function clearDynamicDatasetSummaryI18n(element) {
    if (!element) return;
    element.removeAttribute?.('data-i18n');
    element.removeAttribute?.('data-i18n-html');
    element.removeAttribute?.('data-i18n-fallback');
    element.removeAttribute?.('data-i18n-html-fallback');
    if (element.dataset) {
      delete element.dataset.i18nOriginalText;
      delete element.dataset.i18nOriginalHtml;
    }
  }

  function setDatasetSummaryText(element, className, text) {
    clearDynamicDatasetSummaryI18n(element);
    element.className = className;
    element.textContent = text;
  }

  function setDatasetSummaryHtml(element, className, html) {
    clearDynamicDatasetSummaryI18n(element);
    element.className = className;
    element.innerHTML = html;
  }

  function setProgress(percent, message = '') {
    const { progress, progressFill, progressText } = getModalElements();
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    progressValue = safePercent;
    if (progress) progress.hidden = false;
    if (progressFill) progressFill.style.width = `${safePercent}%`;
    if (progressText) progressText.textContent = message || t('viewer.export.processing', 'Processing point cloud export...');
  }

  function startProgress(message) {
    stopProgress(false);
    progressValue = 8;
    setProgress(progressValue, message);
    progressTimer = window.setInterval(() => {
      const next = progressValue < 58
        ? progressValue + 3
        : (progressValue < 88 ? progressValue + 1 : progressValue);
      setProgress(Math.min(next, 92), message);
    }, 900);
  }

  function stopProgress(complete = false, message = '') {
    if (progressTimer) {
      window.clearInterval(progressTimer);
      progressTimer = null;
    }
    if (complete) {
      setProgress(100, message || t('viewer.export.completed', 'Export completed'));
      return;
    }
    const { progress } = getModalElements();
    if (progress) progress.hidden = true;
  }

  function setModalBusy(isBusy, message = '', { refreshNote = true } = {}) {
    exportBusy = Boolean(isBusy);
    const { modal } = getModalElements();
    if (!modal) return;
    modal.classList.toggle('export-busy', exportBusy);
    modal.querySelectorAll('select, input, button').forEach(control => {
      control.disabled = exportBusy;
    });
    if (exportBusy) {
      startProgress(message || t('viewer.export.exporting', 'Exporting {{format}}. Large point clouds may take a few minutes...', { format: getSelectedFormat().toUpperCase() }));
    } else {
      stopProgress(false);
      if (refreshNote) updateExportLasNote();
    }
  }

  function datasetCanUseCurrentTransform(context) {
    if (!context) return false;
    const basis = String(context.coordinateBasis || context.coordinateContext?.coordinateBasis || '').trim().toLowerCase();
    return Boolean(
      context.globalCoordinateAvailable
      || context.geoInfoAvailable
      || context.geoInfoPath
      || context.coordinateContext?.globalCoordinateAvailable
      || context.coordinateContext?.geoInfoAvailable
      || basis === 'local-with-geo-info'
      || basis === 'ecef-absolute'
      || basis === 'projected'
    );
  }

  function applySafeDefaultTransformMode(context) {
    const { transformModeSelect } = getModalElements();
    if (!transformModeSelect) return;
    transformModeSelect.value = datasetCanUseCurrentTransform(context) ? 'current' : 'local';
  }

  async function openExportLasModal() {
    const { modal, datasetSummary, sourceSelect, filenameInput } = getModalElements();
    modal.classList.add('open');
    sourceSelect.innerHTML = '';
    setExportSourceOptions([]);
    applySafeDefaultTransformMode(getActiveDatasetContext());
    filenameInput.value = buildDefaultExportFilename();
    setDatasetSummaryText(datasetSummary, 'modal-msg show info', t('viewer.export.readingSources', 'Reading exportable LAS / LAZ source files...'));
    updateExportUnitModeVisibility();

    const query = getExportContextQuery();
    if (!query) {
      setDatasetSummaryText(datasetSummary, 'modal-msg show err', t('viewer.export.needDataset', 'Load a point cloud or scanner project first.'));
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
      const syncedContext = typeof syncActiveDatasetContext === 'function'
        ? (syncActiveDatasetContext(data.context) || data.context)
        : data.context;
      applySafeDefaultTransformMode(syncedContext || getActiveDatasetContext());
      setDatasetSummaryHtml(
        datasetSummary,
        'modal-msg show info',
        `${data.context?.type === 'scanner' ? t('viewer.export.context.scannerProject', 'Scanner project') : t('viewer.export.context.pointCloud', 'Point cloud')}: ${escapeHtml(data.context?.name || t('common.unnamed', 'Unnamed'))}<br>${t('viewer.export.sourcesFound', 'Found {{count}} exportable source file(s)', { count: getExportSourceOptions().length })}`
      );
      filenameInput.value = buildDefaultExportFilename();
      if (!getExportSourceOptions().length) {
        sourceSelect.innerHTML = `<option value="">${escapeHtml(t('viewer.export.noSources', 'No exportable source files'))}</option>`;
      } else {
        sourceSelect.innerHTML = getExportSourceOptions().map(item =>
          `<option value="${escapeHtml(item.relPath)}">${escapeHtml(item.name)} · ${escapeHtml(item.sizeLabel || t('viewer.export.unknownSize', 'Unknown size'))}</option>`
        ).join('');
      }
    } catch (error) {
      setDatasetSummaryText(datasetSummary, 'modal-msg show err', t('viewer.export.sourcesFailed', `Failed to read export sources: ${error.message}`, { message: error.message }));
    }

    updateExportLasNote();
  }

  async function ensureExportSources() {
    if (getExportSourceOptions().length) {
      return getExportSourceOptions();
    }
    const query = getExportContextQuery();
    if (!query) {
      throw new Error(t('viewer.export.needDataset', 'Load a point cloud or scanner project first.'));
    }
    const data = await fetchImpl(`/api/export-sources?${query}`).then(async response => {
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const summary = translateError(json.errorCode, json.error || `HTTP ${response.status}`);
        throw new Error(summary);
      }
      return json;
    });
    setExportSourceOptions(data.sources || []);
    applySafeDefaultTransformMode(data.context || getActiveDatasetContext());
    return getExportSourceOptions();
  }

  function buildExportPayload(overrides = {}) {
    const activeDatasetContext = getActiveDatasetContext();
    const sourceRelPath = overrides.sourceRelPath
      ?? document.getElementById('sel-export-source')?.value
      ?? getExportSourceOptions()[0]?.relPath
      ?? '';
    const transformMode = overrides.transformMode
      ?? document.getElementById('sel-export-transform-mode')?.value
      ?? (datasetCanUseCurrentTransform(activeDatasetContext) ? 'current' : 'local');
    const outputFilename = overrides.outputFilename
      ?? document.getElementById('inp-export-filename')?.value?.trim()
      ?? buildDefaultExportFilename();
    return {
      projectId: activeDatasetContext?.type === 'scanner' ? activeDatasetContext.projectId : undefined,
      cloudName: activeDatasetContext?.type === 'cloud' ? activeDatasetContext.cloudName : undefined,
      sourceRelPath,
      coordConfig: getCoordConfig() || createDefaultCoordinateConfig(),
      resolvedCoordinateSystem: getCurrentResolvedCoordinateSystem(),
      deleteRegions: serializeDeleteRegions?.() || [],
      clipBoxes: serializeClipBoxes?.() || [],
      exportOptions: {
        format: overrides.format || getSelectedFormat(),
        plyEncoding: overrides.plyEncoding || getSelectedPlyEncoding(),
        transformMode,
        outputLinearUnit: overrides.outputLinearUnit || resolveSelectedExportLinearUnit(),
        outputFilename,
        includeCrsMetadata: overrides.includeCrsMetadata ?? Boolean(document.getElementById('chk-export-crs')?.checked ?? true),
        includeExportMetadataVlr: overrides.includeExportMetadataVlr ?? Boolean(document.getElementById('chk-export-vlr')?.checked ?? true),
        clipMode: overrides.clipMode || getClipMode?.() || 'inside',
        workflow: overrides.workflow || undefined,
        importToViewer: overrides.importToViewer || undefined,
      },
    };
  }

  function createExportError(json = {}, response = null) {
    const rawMessage = json.summary || json.message || json.error || (response ? `HTTP ${response.status}` : '');
    const localized = typeof translateError === 'function'
      ? translateError(json.errorCode, rawMessage)
      : rawMessage;
    const details = [localized, json.summary, json.message, json.error, json.stderr].filter(Boolean).join('\n');
    return new Error(details || rawMessage || t('viewer.export.unknownError', 'Unknown error'));
  }

  function waitForExportPoll(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  async function startExportJob(payload) {
    return fetchImpl('/api/export-pointcloud/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async response => {
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.ok === false) {
        throw createExportError(json, response);
      }
      return json;
    });
  }

  function getExportJobStatusUrl(jobInit = {}) {
    const statusUrl = String(jobInit.statusUrl || '').trim();
    if (statusUrl) return statusUrl;
    const jobId = String(jobInit.jobId || '').trim();
    if (!jobId) {
      throw new Error(t('viewer.export.jobMissing', 'Export job was not created.'));
    }
    return `/api/jobs/${encodeURIComponent(jobId)}`;
  }

  function createExportJobError(job = {}) {
    const status = String(job.status || '').trim();
    const errorPayload = job.error && typeof job.error === 'object' ? job.error : {};
    const message = errorPayload.summary
      || errorPayload.message
      || errorPayload.error
      || job.message
      || (status === 'cancelled'
        ? t('viewer.export.cancelled', 'Export was cancelled.')
        : t('viewer.export.failedGeneric', 'Export failed.'));
    const error = new Error(message);
    error.status = status;
    error.payload = errorPayload;
    return error;
  }

  async function pollExportJob(jobInit, {
    onProgress = null,
    pollIntervalMs = 1000,
  } = {}) {
    const statusUrl = getExportJobStatusUrl(jobInit);
    while (true) {
      const data = await fetchImpl(statusUrl).then(async response => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok || json.ok === false) {
          throw createExportError(json, response);
        }
        return json;
      });
      const job = data.job || {};
      const status = String(job.status || '').trim().toLowerCase();
      onProgress?.(job);
      if (status === 'completed') {
        const result = job.result || {};
        if (result.ok === false) {
          throw createExportJobError({ ...job, error: result });
        }
        return result;
      }
      if (status === 'failed' || status === 'cancelled') {
        throw createExportJobError(job);
      }
      await waitForExportPoll(pollIntervalMs);
    }
  }

  async function postExportPayload(payload, {
    onProgress = null,
  } = {}) {
    const jobInit = await startExportJob(payload);
    return pollExportJob(jobInit, { onProgress });
  }

  function triggerExportDownload(data = {}) {
    if (!data.downloadUrl) return false;
    const link = document.createElement('a');
    link.href = data.downloadUrl;
    link.download = data.outputFilename || '';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  async function submitExportLas() {
    const { note } = getModalElements();
    const activeDatasetContext = getActiveDatasetContext();
    if (exportBusy) return;
    if (!activeDatasetContext) {
      toast(t('viewer.export.needDataset', 'Load a point cloud or scanner project first.'), 'err');
      return;
    }

    note.className = 'modal-msg show info';
    note.style.display = 'block';
    const format = getSelectedFormat().toUpperCase();
    note.textContent = t('viewer.export.exporting', `Exporting ${format}. Large point clouds may take a few minutes...`, { format });
    setModalBusy(true, note.textContent);

    try {
      const data = await postExportPayload(buildExportPayload(), {
        onProgress: (job) => {
          if (progressTimer) {
            window.clearInterval(progressTimer);
            progressTimer = null;
          }
          const percent = Number.isFinite(job?.progress) ? job.progress : progressValue;
          setProgress(percent, job?.message || note.textContent);
        },
      });
      stopProgress(true, t('viewer.export.completed', 'Export completed'));

      note.className = 'modal-msg show ok';
      const deleteSummary = Number.isFinite(data.deletedPoints)
        ? `<br>${t('viewer.export.deletedPoints', 'Deleted points')}: ${formatNumber(data.deletedPoints)}${Number.isFinite(data.writtenPoints) ? `, ${t('viewer.export.writtenPoints', 'Written points')}: ${formatNumber(data.writtenPoints)}` : ''}`
        : '';
      const e57Summary = Number.isFinite(data.e57ScanCount)
        ? `<br>${t('viewer.export.e57ScanCount', 'E57 scan chunks')}: ${formatNumber(data.e57ScanCount)}${data.scannerContextReport ? `<br>${t('viewer.export.scannerContextReport', 'Scanner context report')}: ${escapeHtml(data.scannerContextReport)}` : ''}`
        : '';
      note.innerHTML = `${t('viewer.export.completed', 'Export completed')}: ${escapeHtml(data.outputFilename)}<br>${t('viewer.export.fileSize', 'File size')}: ${escapeHtml(data.sizeLabel || t('common.unknown', 'Unknown'))}${data.plyEncoding ? `<br>PLY: ${escapeHtml(data.plyEncoding)}` : ''}${deleteSummary}${e57Summary}${data.crsOmitReason ? `<br>${t('viewer.export.note', 'Note')}: ${escapeHtml(data.crsOmitReason)}` : ''}`;

      triggerExportDownload(data);

      toast(t('viewer.export.completedToast', '{{format}} export completed: {{filename}}', { format: (data.format || getSelectedFormat()).toUpperCase(), filename: data.outputFilename }), 'ok', 5000);
    } catch (error) {
      const message = String(error.message || error);
      const detail = message.split('\n').filter(Boolean).slice(0, 3).join('\n');
      note.className = 'modal-msg show err';
      note.textContent = t('viewer.export.failed', `Export failed: ${detail || 'Unknown error'}`, { message: detail || t('viewer.export.unknownError', 'Unknown error') });
      toast(t('viewer.export.failedShort', `Point cloud export failed: ${detail || 'Unknown error'}`, { message: detail || t('viewer.export.unknownError', 'Unknown error') }), 'err', 5000);
    } finally {
      setModalBusy(false, '', { refreshNote: false });
    }
  }

  async function exportFilteredPointCloudAndOpen({
    reason = 'clip',
    onProgress = null,
  } = {}) {
    if (exportBusy) return null;
    const activeDatasetContext = getActiveDatasetContext();
    if (!activeDatasetContext) {
      throw new Error(t('viewer.export.needDataset', 'Load a point cloud or scanner project first.'));
    }
    onProgress?.({ progress: 8, message: t('viewer.export.readingSources', 'Reading exportable LAS / LAZ source files...') });
    const sources = await ensureExportSources();
    const source = sources[0];
    if (!source) {
      throw new Error(t('viewer.export.noSources', 'No exportable LAS/LAZ source files are available for the current dataset.'));
    }
    const message = reason === 'delete'
      ? t('viewer.deleteRegion.exporting', 'Exporting delete-region result for download...')
      : t('viewer.clipBox.exporting', 'Exporting clipped LAS for download...');
    exportBusy = true;
    let quickProgress = 20;
    let quickTimer = null;
    const emitQuickProgress = (progress, nextMessage = message) => {
      quickProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || quickProgress)));
      onProgress?.({ progress: quickProgress, message: nextMessage });
    };
    emitQuickProgress(quickProgress, message);
    quickTimer = window.setInterval(() => {
      const next = quickProgress < 60
        ? quickProgress + 4
        : (quickProgress < 90 ? quickProgress + 1 : quickProgress);
      emitQuickProgress(Math.min(next, 92), message);
    }, 900);
    try {
      const data = await postExportPayload(buildExportPayload({
        sourceRelPath: source.relPath,
        format: 'las',
        transformMode: 'local',
        workflow: 'clip-result',
        importToViewer: false,
        outputFilename: '',
      }), {
        onProgress: (job) => {
          if (quickTimer) {
            window.clearInterval(quickTimer);
            quickTimer = null;
          }
          const percent = Number.isFinite(job?.progress) ? job.progress : quickProgress;
          emitQuickProgress(percent, job?.message || message);
        },
      });
      emitQuickProgress(100, t('viewer.export.completed', 'Export completed'));
      triggerExportDownload(data);
      return data;
    } finally {
      if (quickTimer) window.clearInterval(quickTimer);
      exportBusy = false;
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
    exportFilteredPointCloudAndOpen,
  };
}
