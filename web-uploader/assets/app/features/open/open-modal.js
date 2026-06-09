export function createOpenModalFeature({
  apiClient,
  capabilities = window.__APP_CAPABILITIES || {},
  translate,
  translateText,
  applyTranslations,
  toast,
  confirmDialog,
  loadCloud,
  loadScanProject,
  loadMeshFile,
  elements = {},
} = {}) {
  const modal = elements.modal || document.getElementById('modal-open');
  const list = elements.list || document.getElementById('open-list');
  const cancelButton = elements.cancelButton || document.getElementById('open-cancel');
  let desktopDialogsResolved = false;
  let desktopDialogsAvailable = false;
  let importInFlightTarget = '';
  let removeInFlightProjectId = '';
  let removeInFlightCloudName = '';
  let cachedOpenModalData = null;
  let activeOpenModalLoadId = 0;
  let activeImportJobId = '';
  let importBusyOverlay = null;

  function isFeatureEnabled(feature) {
    return Boolean(capabilities?.features?.[feature]);
  }

  function canUseDesktopImport() {
    return Boolean(desktopDialogsAvailable && isFeatureEnabled('desktopLocalImport'));
  }

  function canManageDatasets() {
    return Boolean(isFeatureEnabled('datasetManagement'));
  }

  function createActionButton({ target, label, fallback }) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.dataset.openImportTarget = target;
    button.dataset.baseLabel = translate(label, {}, fallback);
    button.textContent = button.dataset.baseLabel;
    button.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;font-size:12px;padding:10px 14px;min-width:0;width:100%;height:44px;border-radius:12px;';
    button.addEventListener('click', () => {
      runDesktopImport(target);
    });
    return button;
  }

  function updateActionButtonsState(root = modal) {
    root.querySelectorAll('[data-open-import-target]').forEach(button => {
      const target = button.dataset.openImportTarget || '';
      const isBusy = importInFlightTarget === target;
      const disabled = (desktopDialogsResolved && !desktopDialogsAvailable) || Boolean(importInFlightTarget);
      button.disabled = disabled;
      button.textContent = isBusy
        ? translate('viewer.open.importing', {}, 'Importing...')
        : (button.dataset.baseLabel || button.textContent);
      button.style.opacity = disabled && !isBusy ? '0.55' : '1';
      button.style.cursor = disabled ? 'default' : 'pointer';
    });

    const note = root.querySelector('[data-open-import-note]');
    if (!note) return;
    if (desktopDialogsResolved && !desktopDialogsAvailable) {
      note.textContent = translate('viewer.open.importDesktopOnly', {}, 'Local import is available in the Windows desktop app.');
      note.style.display = 'block';
      return;
    }
    note.textContent = translate(
      'viewer.open.importHint',
      {},
      'Choose a scanner folder, a folder containing LAS/LAZ, or a single LAS/LAZ file.'
    );
    note.style.display = 'block';
  }

  function ensureImportBusyOverlay() {
    if (importBusyOverlay) return importBusyOverlay;
    importBusyOverlay = document.createElement('div');
    importBusyOverlay.dataset.localImportBusy = 'true';
    importBusyOverlay.setAttribute('data-local-import-busy', 'true');
    importBusyOverlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'background:rgba(15,23,42,.42)',
      'backdrop-filter:blur(2px)',
      'pointer-events:auto',
    ].join(';');
    importBusyOverlay.innerHTML = `
      <div style="width:min(460px,calc(100vw - 40px));border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 24px 80px rgba(15,23,42,.22);padding:18px;">
        <div data-import-title style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:8px;"></div>
        <div data-import-message style="font-size:12px;color:var(--text2);line-height:1.45;min-height:18px;"></div>
        <div style="height:8px;border-radius:999px;background:var(--hover);overflow:hidden;margin-top:14px;">
          <div data-import-bar style="height:100%;width:0%;border-radius:999px;background:var(--accent);transition:width .25s ease;"></div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
          <span data-import-stage style="font-size:10px;color:var(--text3);"></span>
          <span data-import-percent style="font-size:11px;font-weight:700;color:var(--accent);">0%</span>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:14px;">
          <button class="btn" data-import-cancel style="min-width:96px;"></button>
        </div>
      </div>`;
    importBusyOverlay.querySelector('[data-import-cancel]')?.addEventListener('click', async () => {
      if (!activeImportJobId) return;
      const cancelButton = importBusyOverlay.querySelector('[data-import-cancel]');
      if (cancelButton) {
        cancelButton.disabled = true;
        cancelButton.textContent = translate('viewer.open.importCancelling', {}, 'Cancelling...');
      }
      try {
        await apiClient.postJson(`/api/import/local/jobs/${encodeURIComponent(activeImportJobId)}/cancel`, {});
      } catch (error) {
        toast(translate('viewer.open.cancelFailed', { message: error.message }, `Cancel failed: ${error.message}`), 'err', 3200);
      }
    });
    document.body.appendChild(importBusyOverlay);
    return importBusyOverlay;
  }

  function setImportBusy(job = null, { visible = true } = {}) {
    const overlay = ensureImportBusyOverlay();
    overlay.style.display = visible ? 'flex' : 'none';
    if (!visible) return;
    const progress = Math.max(0, Math.min(100, Number(job?.progress) || 0));
    overlay.querySelector('[data-import-title]').textContent = translate('viewer.open.importTitle', {}, 'Opening Point Cloud');
    overlay.querySelector('[data-import-message]').textContent = job?.message || translate('viewer.open.importStarting', {}, 'Preparing local import...');
    overlay.querySelector('[data-import-stage]').textContent = job?.stage || '';
    overlay.querySelector('[data-import-percent]').textContent = `${Math.round(progress)}%`;
    overlay.querySelector('[data-import-bar]').style.width = `${progress}%`;
    const cancelButton = overlay.querySelector('[data-import-cancel]');
    if (cancelButton) {
      const terminal = ['done', 'failed', 'cancelled'].includes(job?.status);
      cancelButton.disabled = terminal;
      cancelButton.textContent = translate('common.actions.cancel', {}, 'Cancel');
    }
  }

  async function waitForImportJob(jobId) {
    activeImportJobId = jobId;
    let lastJob = null;
    try {
      while (activeImportJobId === jobId) {
        const payload = await apiClient.getJson(`/api/import/local/jobs/${encodeURIComponent(jobId)}`);
        const job = payload?.job;
        lastJob = job;
        setImportBusy(job, { visible: true });
        if (['done', 'failed', 'cancelled'].includes(job?.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 700));
      }
      return lastJob;
    } finally {
      if (activeImportJobId === jobId) activeImportJobId = '';
    }
  }

  async function openImportedResult(result) {
    if (result?.importedKind === 'scannerProject' && result.projectId) {
      const name = result.projectName || result.displayName || result.projectId;
      toast(translate('viewer.open.importScannerReady', { name }, `Imported scanner project: ${name}`), 'ok', 3200);
      cachedOpenModalData = null;
      loadScanProject(result.projectId, result.metadataUrl, result.scanDataUrl, name, result.sourcePath || '', {
        coordinateContext: result.features?.coordinateContext || null,
        coordinateBasis: result.features?.coordinateBasis || result.features?.coordinateContext?.coordinateBasis || null,
        globalCoordinateAvailable: Boolean(result.features?.globalCoordinateAvailable || result.features?.coordinateContext?.globalCoordinateAvailable),
        vendor: result.features?.vendor || result.vendor || null,
        scannerFormat: result.features?.scannerFormat || result.scannerFormat || null,
      });
      return;
    }

    if (result?.metadataUrl) {
      const name = result.displayName || result.cloudName || 'Point Cloud';
      toast(translate('viewer.open.importCloudReady', { name }, `Imported point cloud: ${name}`), 'ok', 3200);
      cachedOpenModalData = null;
      loadCloud(result.metadataUrl, {
        type: 'cloud',
        cloudName: result.cloudName || name,
        displayName: name,
        sourcePath: result.sourcePath || result.originalPath || result.dirPath || '',
        dirPath: result.dirPath || result.sourcePath || '',
      });
      return;
    }

    if (result?.importedKind === 'meshFile' && result.meshPath) {
      const name = result.displayName || 'OBJ Mesh';
      toast(translate('viewer.open.importMeshReady', { name }, `Imported mesh: ${name}`), 'ok', 3200);
      await loadMeshFile?.(result.meshPath, { displayName: name });
      return;
    }

    toast(translate('viewer.open.importCompleted', {}, 'Import completed.'), 'ok', 2600);
    await openOpenModal();
  }

  function buildQuickImportSection() {
    const section = document.createElement('div');
    section.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:0 0 16px 0;margin-bottom:12px;border-bottom:1px solid var(--border);';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:700;color:var(--accent2);letter-spacing:.02em;';
    title.textContent = translate('viewer.open.quickImportTitle', {}, 'Open From This Computer');
    section.appendChild(title);

    const row = document.createElement('div');
    // Keep OBJ hidden for now and pin the two primary local actions to a compact two-column layout.
    row.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;';
    row.appendChild(createActionButton({
      target: 'scan-folder',
      label: 'viewer.open.openLocalFolder',
      fallback: 'Open Local Folder',
    }));
    row.appendChild(createActionButton({
      target: 'las-file',
      label: 'viewer.open.openLasFile',
      fallback: 'Open LAS / LAZ',
    }));
    section.appendChild(row);

    const note = document.createElement('div');
    note.dataset.openImportNote = 'true';
    note.style.cssText = 'font-size:10px;color:var(--text3);line-height:1.45;';
    section.appendChild(note);

    updateActionButtonsState(section);
    return section;
  }

  function rememberDesktopDialogsSupport(available) {
    desktopDialogsAvailable = Boolean(available);
    desktopDialogsResolved = true;
  }

  function rememberOpenModalData(data) {
    cachedOpenModalData = data && typeof data === 'object'
      ? {
          desktopDialogs: Boolean(data.desktopDialogs),
          projects: Array.isArray(data.projects) ? data.projects : [],
          clouds: Array.isArray(data.clouds) ? data.clouds : [],
        }
      : { desktopDialogs: false, projects: [], clouds: [] };
    rememberDesktopDialogsSupport(cachedOpenModalData.desktopDialogs);
    return cachedOpenModalData;
  }

  function buildSectionHeader(text, { accent = 'var(--text2)', marginTop = '0' } = {}) {
    const sectionHeader = document.createElement('div');
    sectionHeader.style.cssText = `padding:6px 8px;font-size:11px;font-weight:700;color:${accent};border-bottom:1px solid var(--border);margin-top:${marginTop};`;
    sectionHeader.textContent = text;
    return sectionHeader;
  }

  function buildStatusMessage(message, { color = 'var(--text3)' } = {}) {
    const element = document.createElement('div');
    element.style.cssText = `color:${color};font-size:11px;text-align:center;padding:18px 12px;`;
    element.textContent = message;
    return element;
  }

  function getRegularClouds(clouds = []) {
    return (Array.isArray(clouds) ? clouds : []).filter(cloud => !cloud.scannerProjectId);
  }

  function renderScannerProjects(projects = []) {
    if (!projects.length) return;

    list.appendChild(buildSectionHeader(
      translate('viewer.open.scannerProjects', { count: projects.length }, `Scanner Projects (${projects.length})`),
      { accent: 'var(--accent2)' }
    ));

    projects.forEach(project => {
      const features = project.features || {};
      const badges = [];
      if (features.hasPotree) badges.push(translate('viewer.open.badges.pointCloud', {}, 'Point Cloud'));
      if (features.hasOdom) badges.push(translate('viewer.open.badges.trajectory', {}, 'Trajectory'));
      if (features.hasCameras) badges.push(translate('viewer.open.badges.cameras', {}, 'Cameras'));
      if (features.vendor === 'mvps2') badges.push('MVP S2');
      if (features.hasGeo) badges.push(translate('viewer.open.badges.coordinates', {}, 'Coordinates'));
      if (features.hasPhotos) badges.push(translate('viewer.open.badges.photos', {}, 'Photos'));
      const pointSummary = features.pointCount
        ? translate('viewer.open.points', { count: Number(features.pointCount).toLocaleString() }, '{{count}} pts')
        : '';
      const badgeHtml = badges
        .map(badge => `<span style="display:inline-block;background:rgba(64,120,255,.15);color:var(--accent2);padding:1px 5px;border-radius:3px;font-size:9px;margin-right:3px;">${badge}</span>`)
        .join('');

      const item = document.createElement('div');
      item.className = 'cloud-list-item';
      item.innerHTML = `
        <span style="font-size:20px;">${translate('viewer.open.scanLabel', {}, 'Scan')}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${project.name}</div>
          <div style="margin-top:2px;">${badgeHtml}</div>
          ${pointSummary ? `<div style="font-size:9px;color:var(--text3);margin-top:1px;">${pointSummary}</div>` : ''}
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button class="btn pri" data-open-project style="font-size:10px;padding:4px 10px;">${translate('common.actions.open', {}, 'Open')}</button>
          ${canManageDatasets() ? `<button class="btn" data-remove-project style="font-size:10px;padding:4px 10px;color:var(--error);">${translate('viewer.open.removeAction', {}, 'Remove')}</button>` : ''}
        </div>`;

      item.querySelector('[data-open-project]')?.addEventListener('click', () => {
        modal.classList.remove('open');
        toast(translate('viewer.open.loadingScannerProject', { name: project.name }, `Loading scanner project: ${project.name}`), 'info', 3000);
        const sourcePath = project.sourcePath || project.originalPath || project.dirPath || '';
        loadScanProject(project.projectId, project.pointcloudUrl, project.scanDataUrl, project.name, sourcePath, {
          sourcePath,
          dirPath: project.dirPath || sourcePath,
          coordinateContext: project.features?.coordinateContext || null,
          coordinateBasis: project.features?.coordinateBasis || project.features?.coordinateContext?.coordinateBasis || null,
          globalCoordinateAvailable: Boolean(project.features?.globalCoordinateAvailable || project.features?.coordinateContext?.globalCoordinateAvailable),
          vendor: project.features?.vendor || project.vendor || null,
          scannerFormat: project.features?.scannerFormat || project.scannerFormat || null,
        });
      });

      item.querySelector('[data-remove-project]')?.addEventListener('click', async () => {
        if (removeInFlightProjectId) return;
        const message = translate('viewer.open.removeConfirm', { name: project.name }, `Remove "${project.name}" from this list?`);
        const confirmed = typeof confirmDialog === 'function'
          ? await confirmDialog({
            title: translate('viewer.open.removeConfirmTitle', {}, 'Remove scanner project?'),
            message,
            confirmText: translate('viewer.open.removeAction', {}, 'Remove'),
            cancelText: translate('common.actions.cancel', {}, 'Cancel'),
            tone: 'danger',
          })
          : false;
        if (!confirmed) return;

        removeInFlightProjectId = project.projectId;
        const removeButton = item.querySelector('[data-remove-project]');
        if (removeButton) {
          removeButton.disabled = true;
          removeButton.textContent = translate('viewer.open.removing', {}, 'Removing...');
        }
        try {
          await apiClient.postJson('/api/scan-projects/remove', { projectId: project.projectId });
          toast(translate('viewer.open.removeSuccess', { name: project.name }, `Removed "${project.name}" from the list.`), 'ok', 2600);
          cachedOpenModalData = null;
          await openOpenModal();
        } catch (error) {
          toast(
            translate('viewer.open.removeFailed', { message: error.message }, `Remove failed: ${error.message}`),
            'err',
            3600
          );
          if (removeButton) {
            removeButton.disabled = false;
            removeButton.textContent = translate('viewer.open.removeAction', {}, 'Remove');
          }
        } finally {
          removeInFlightProjectId = '';
        }
      });
      list.appendChild(item);
    });
  }

  function renderPointClouds(clouds = []) {
    const regularClouds = getRegularClouds(clouds);
    if (!regularClouds.length) return;

    list.appendChild(buildSectionHeader(
      translate('viewer.open.pointClouds', { count: regularClouds.length }, `Point Clouds (${regularClouds.length})`),
      { marginTop: '4px' }
    ));

    regularClouds.forEach(cloud => {
      const points = cloud.points
        ? translate('viewer.open.points', { count: Number(cloud.points).toLocaleString() }, '{{count}} pts')
        : translate('viewer.open.unknownPointCount', {}, 'Unknown point count');
      const metadataUrl = cloud.metadataUrl || `/pointclouds/${encodeURIComponent(cloud.cloudName || cloud.name)}/metadata.json`;
      const cloudName = cloud.cloudName || cloud.name;
      const item = document.createElement('div');
      item.className = 'cloud-list-item';
      item.innerHTML = `
        <span style="font-size:18px;">${translate('viewer.open.cloudLabel', {}, 'Cloud')}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${cloud.name}</div>
          <div style="font-size:10px;color:var(--text3);">${points}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <button class="btn pri" data-open-cloud style="font-size:10px;padding:4px 10px;">${translate('common.actions.open', {}, 'Open')}</button>
          ${canManageDatasets() ? `<button class="btn" data-remove-cloud style="font-size:10px;padding:4px 10px;color:var(--error);">${translate('viewer.open.removeAction', {}, 'Remove')}</button>` : ''}
        </div>`;
      item.querySelector('[data-open-cloud]')?.addEventListener('click', () => {
        modal.classList.remove('open');
        loadCloud(metadataUrl, {
          type: 'cloud',
          cloudName: cloud.cloudName || cloud.name,
          displayName: cloud.name || cloud.cloudName,
          sourcePath: cloud.sourcePath || cloud.originalPath || cloud.dirPath || '',
          dirPath: cloud.dirPath || cloud.sourcePath || '',
        });
      });
      item.querySelector('[data-remove-cloud]')?.addEventListener('click', async () => {
        if (removeInFlightCloudName || !cloudName) return;
        const message = translate(
          'viewer.open.removeCloudConfirm',
          { name: cloud.name },
          `Remove "${cloud.name}" from this list? The original data will not be deleted.`
        );
        const confirmed = typeof confirmDialog === 'function'
          ? await confirmDialog({
            title: translate('viewer.open.removeCloudConfirmTitle', {}, 'Remove point cloud?'),
            message,
            confirmText: translate('viewer.open.removeAction', {}, 'Remove'),
            cancelText: translate('common.actions.cancel', {}, 'Cancel'),
            tone: 'danger',
          })
          : false;
        if (!confirmed) return;

        removeInFlightCloudName = cloudName;
        const removeButton = item.querySelector('[data-remove-cloud]');
        if (removeButton) {
          removeButton.disabled = true;
          removeButton.textContent = translate('viewer.open.removing', {}, 'Removing...');
        }
        try {
          await apiClient.postJson('/api/clouds/remove', {
            cloudName,
            resourceType: cloud.resourceType || 'pointcloud',
          });
          toast(translate('viewer.open.removeCloudSuccess', { name: cloud.name }, `Removed "${cloud.name}" from the list.`), 'ok', 2600);
          cachedOpenModalData = null;
          await openOpenModal();
        } catch (error) {
          toast(
            translate('viewer.open.removeCloudFailed', { message: error.message }, `Remove failed: ${error.message}`),
            'err',
            3600
          );
          if (removeButton) {
            removeButton.disabled = false;
            removeButton.textContent = translate('viewer.open.removeAction', {}, 'Remove');
          }
        } finally {
          removeInFlightCloudName = '';
        }
      });
      list.appendChild(item);
    });
  }

  function renderOpenModalContents({
    projects = [],
    clouds = [],
    loading = false,
    error = '',
  } = {}) {
    list.innerHTML = '';
    if (canUseDesktopImport()) {
      list.appendChild(buildQuickImportSection());
    }

    if (loading) {
      list.appendChild(buildStatusMessage(
        translate('viewer.open.loadingProjects', {}, 'Loading recent projects...'),
      ));
    }

    if (!projects.length && !getRegularClouds(clouds).length && !loading) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text3);font-size:11px;text-align:center;padding:18px 12px 22px;';
      const emptyHint = canUseDesktopImport()
        ? translate('viewer.open.emptyHint', {}, 'Use the buttons above to open a local folder or LAS/LAZ file')
        : translate('viewer.open.emptyServerHint', {}, 'Upload datasets from the CloudStudio home page or server backend.');
      empty.innerHTML = `${translate('viewer.open.emptyTitle', {}, 'No available point clouds')}<br><small>${emptyHint}</small>`;
      if (!canUseDesktopImport()) {
        const uploadLink = document.createElement('a');
        uploadLink.className = 'btn';
        uploadLink.href = '/';
        uploadLink.textContent = translate('viewer.open.uploadHomeAction', {}, 'Upload data');
        uploadLink.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;margin-top:12px;min-width:128px;height:34px;text-decoration:none;font-size:12px;';
        empty.appendChild(document.createElement('br'));
        empty.appendChild(uploadLink);
      }
      list.appendChild(empty);
    } else {
      renderScannerProjects(projects);
      if (projects.length && getRegularClouds(clouds).length) {
        const spacer = document.createElement('div');
        spacer.style.height = '4px';
        list.appendChild(spacer);
      }
      renderPointClouds(clouds);
    }

    if (error) {
      list.appendChild(buildStatusMessage(error, { color: 'var(--error)' }));
    }

    applyTranslations(modal);
  }

  async function runDesktopImport(target) {
    if (desktopDialogsResolved && !desktopDialogsAvailable) {
      toast(translate('viewer.open.importDesktopOnly', {}, 'Local import is available in the Windows desktop app.'), 'info', 2600);
      updateActionButtonsState();
      return;
    }
    if (importInFlightTarget) return;
    importInFlightTarget = target;
    updateActionButtonsState();
    try {
      setImportBusy({ stage: 'selecting', progress: 2, message: translate('viewer.open.selectingPath', {}, 'Waiting for file selection...') }, { visible: true });
      const selected = await apiClient.postJson('/api/desktop/open-dialog', { target });
      if (selected?.cancelled || !selected?.selectedPath) return;

      const queued = await apiClient.postJson('/api/import/local/jobs', { entryPath: selected.selectedPath });
      const jobId = queued?.job?.jobId;
      if (!jobId) throw new Error('Import job was not created.');
      const job = await waitForImportJob(jobId);
      if (job?.status === 'cancelled') {
        toast(translate('viewer.open.importCancelled', {}, 'Import cancelled.'), 'info', 2600);
        return;
      }
      if (job?.status !== 'done') {
        throw new Error(job?.error || 'Import failed.');
      }

      modal.classList.remove('open');
      await openImportedResult(job.result);
    } catch (error) {
      toast(translate('viewer.open.importFailed', { message: error.message }, `Import failed: ${error.message}`), 'err', 4200);
    } finally {
      importInFlightTarget = '';
      activeImportJobId = '';
      setImportBusy(null, { visible: false });
      updateActionButtonsState();
    }
  }

  async function loadOpenModalDataLegacy() {
    const [cloudData, scanData] = await Promise.all([
      apiClient.getJson('/api/clouds').catch(() => ({ clouds: [] })),
      apiClient.getJson('/api/scan-projects').catch(() => ({ projects: [] })),
    ]);

    let desktopDialogs = cachedOpenModalData?.desktopDialogs || false;
    try {
      const health = await apiClient.getJson('/health');
      desktopDialogs = Boolean(health?.desktopDialogs);
    } catch (_error) {
      desktopDialogs = Boolean(cachedOpenModalData?.desktopDialogs);
    }

    return {
      desktopDialogs,
      projects: Array.isArray(scanData?.projects) ? scanData.projects : [],
      clouds: Array.isArray(cloudData?.clouds) ? cloudData.clouds : [],
    };
  }

  async function loadOpenModalData({ background = false } = {}) {
    const requestId = ++activeOpenModalLoadId;
    if (!background || !cachedOpenModalData) {
      renderOpenModalContents({
        projects: cachedOpenModalData?.projects || [],
        clouds: cachedOpenModalData?.clouds || [],
        loading: true,
      });
    }
    try {
      let payload;
      try {
        payload = await apiClient.getJson('/api/open-modal/data?mode=quick');
      } catch (_error) {
        payload = await loadOpenModalDataLegacy();
      }
      payload = rememberOpenModalData(payload);
      if (requestId !== activeOpenModalLoadId) return;
      renderOpenModalContents({
        projects: payload.projects,
        clouds: payload.clouds,
      });
    } catch (error) {
      if (requestId !== activeOpenModalLoadId) return;
      renderOpenModalContents({
        projects: cachedOpenModalData?.projects || [],
        clouds: cachedOpenModalData?.clouds || [],
        error: translate('viewer.open.loadFailed', { message: error.message }, `Load failed: ${error.message}`),
      });
    }
  }

  async function openOpenModal() {
    modal.classList.add('open');
    if (cachedOpenModalData) {
      rememberDesktopDialogsSupport(cachedOpenModalData.desktopDialogs);
      renderOpenModalContents({
        projects: cachedOpenModalData.projects,
        clouds: cachedOpenModalData.clouds,
        loading: true,
      });
      void loadOpenModalData({ background: true });
      return;
    }

    renderOpenModalContents({ loading: true });
    void loadOpenModalData();
  }

  function invalidateCache() {
    cachedOpenModalData = null;
  }

  function bindEvents({ triggerIds = [], cancelButtonId } = {}) {
    triggerIds.forEach(id => {
      const element = document.getElementById(id);
      if (element) {
        element.addEventListener('click', openOpenModal);
      }
    });
    const cancel = cancelButtonId ? document.getElementById(cancelButtonId) : cancelButton;
    if (cancel) {
      cancel.addEventListener('click', () => modal.classList.remove('open'));
    }
  }

  return {
    openOpenModal,
    bindEvents,
    invalidateCache,
  };
}
