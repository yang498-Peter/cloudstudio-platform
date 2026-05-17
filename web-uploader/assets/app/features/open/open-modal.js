export function createOpenModalFeature({
  apiClient,
  translate,
  translateText,
  applyTranslations,
  toast,
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

  function createActionButton({ target, label, fallback }) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.dataset.openImportTarget = target;
    button.dataset.baseLabel = translate(label, {}, fallback);
    button.textContent = button.dataset.baseLabel;
    button.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;font-size:11px;padding:7px 12px;min-width:148px;';
    button.addEventListener('click', () => {
      runDesktopImport(target);
    });
    return button;
  }

  function updateActionButtonsState() {
    modal.querySelectorAll('[data-open-import-target]').forEach(button => {
      const target = button.dataset.openImportTarget || '';
      const isBusy = importInFlightTarget === target;
      const disabled = !desktopDialogsAvailable || Boolean(importInFlightTarget);
      button.disabled = disabled;
      button.textContent = isBusy
        ? translate('viewer.open.importing', {}, 'Importing...')
        : (button.dataset.baseLabel || button.textContent);
      button.style.opacity = disabled && !isBusy ? '0.55' : '1';
      button.style.cursor = disabled ? 'default' : 'pointer';
    });

    const note = modal.querySelector('[data-open-import-note]');
    if (!note) return;
    if (!desktopDialogsResolved) {
      note.textContent = translate('viewer.open.importLoadingSupport', {}, 'Checking local file access...');
      note.style.display = 'block';
      return;
    }
    if (!desktopDialogsAvailable) {
      note.textContent = translate('viewer.open.importDesktopOnly', {}, 'Local import is available in the Windows desktop app.');
      note.style.display = 'block';
      return;
    }
    note.textContent = translate(
      'viewer.open.importHint',
      {},
      'Choose a scanner folder, a folder containing LAS/LAZ, a single LAS/LAZ file, or an OBJ mesh.'
    );
    note.style.display = 'block';
  }

  function buildQuickImportSection() {
    const section = document.createElement('div');
    section.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:0 0 12px 0;margin-bottom:10px;border-bottom:1px solid var(--border);';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;font-weight:700;color:var(--accent2);letter-spacing:.02em;';
    title.textContent = translate('viewer.open.quickImportTitle', {}, 'Open From This Computer');
    section.appendChild(title);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
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
    row.appendChild(createActionButton({
      target: 'mesh-file',
      label: 'viewer.open.openObjFile',
      fallback: 'Open OBJ Mesh',
    }));
    section.appendChild(row);

    const note = document.createElement('div');
    note.dataset.openImportNote = 'true';
    note.style.cssText = 'font-size:10px;color:var(--text3);line-height:1.45;';
    section.appendChild(note);

    updateActionButtonsState();
    return section;
  }

  async function ensureDesktopDialogSupport() {
    if (desktopDialogsResolved) return desktopDialogsAvailable;
    try {
      const health = await apiClient.getJson('/health');
      desktopDialogsAvailable = Boolean(health?.desktopDialogs);
    } catch (_error) {
      desktopDialogsAvailable = false;
    }
    desktopDialogsResolved = true;
    return desktopDialogsAvailable;
  }

  async function runDesktopImport(target) {
    if (importInFlightTarget) return;
    importInFlightTarget = target;
    updateActionButtonsState();
    try {
      const result = await apiClient.postJson('/api/desktop/import-dialog', { target });
      if (result?.cancelled) return;

      modal.classList.remove('open');

      if (result?.importedKind === 'scannerProject' && result.projectId) {
        const name = result.projectName || result.displayName || result.projectId;
        toast(translate('viewer.open.importScannerReady', { name }, `Imported scanner project: ${name}`), 'ok', 3200);
        loadScanProject(result.projectId, result.metadataUrl, result.scanDataUrl, name);
        return;
      }

      if (result?.metadataUrl) {
        const name = result.displayName || result.cloudName || 'Point Cloud';
        toast(translate('viewer.open.importCloudReady', { name }, `Imported point cloud: ${name}`), 'ok', 3200);
        loadCloud(result.metadataUrl, {
          type: 'cloud',
          cloudName: result.cloudName || name,
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
    } catch (error) {
      toast(translate('viewer.open.importFailed', { message: error.message }, `Import failed: ${error.message}`), 'err', 4200);
    } finally {
      importInFlightTarget = '';
      updateActionButtonsState();
    }
  }

  async function openOpenModal() {
    modal.classList.add('open');
    list.innerHTML = `<div style="color:var(--text3);font-size:11px;text-align:center;padding:22px;">${translate('viewer.open.loading', {}, 'Loading...')}</div>`;

    try {
      const [cloudData, scanData] = await Promise.all([
        apiClient.getJson('/api/clouds').catch(() => ({ clouds: [] })),
        apiClient.getJson('/api/scan-projects').catch(() => ({ projects: [] })),
      ]);
      await ensureDesktopDialogSupport();
      const clouds = cloudData.clouds || [];
      const projects = scanData.projects || [];
      const regularClouds = clouds.filter(cloud => !cloud.scannerProjectId);

      list.innerHTML = '';
      list.appendChild(buildQuickImportSection());

      if (!regularClouds.length && !projects.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text3);font-size:11px;text-align:center;padding:18px 12px 22px;';
        empty.innerHTML = `${translate('viewer.open.emptyTitle', {}, 'No available point clouds')}<br><small>${translate('viewer.open.emptyHint', {}, 'Use the buttons above to open a local scanner folder, LAS/LAZ file, or Potree folder')}</small>`;
        list.appendChild(empty);
        applyTranslations(modal);
        return;
      }

      if (projects.length) {
        const sectionHeader = document.createElement('div');
        sectionHeader.style.cssText = 'padding:6px 8px;font-size:11px;font-weight:700;color:var(--accent2);border-bottom:1px solid var(--border);';
        sectionHeader.textContent = translate('viewer.open.scannerProjects', { count: projects.length }, `Scanner Projects (${projects.length})`);
        list.appendChild(sectionHeader);

        projects.forEach(project => {
          const features = project.features || {};
          const badges = [];
          if (features.hasPotree) badges.push(translate('viewer.open.badges.pointCloud', {}, 'Point Cloud'));
          if (features.hasOdom) badges.push(translate('viewer.open.badges.trajectory', {}, 'Trajectory'));
          if (features.hasCameras) badges.push(translate('viewer.open.badges.cameras', {}, 'Cameras'));
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
            <button class="btn pri" style="font-size:10px;padding:4px 10px;flex-shrink:0;">${translate('common.actions.open', {}, 'Open')}</button>`;
          item.querySelector('button').addEventListener('click', () => {
            modal.classList.remove('open');
            toast(translate('viewer.open.loadingScannerProject', { name: project.name }, `Loading scanner project: ${project.name}`), 'info', 3000);
            loadScanProject(project.projectId, project.pointcloudUrl, project.scanDataUrl, project.name);
          });
          list.appendChild(item);
        });
      }

      if (projects.length && regularClouds.length) {
        const spacer = document.createElement('div');
        spacer.style.height = '4px';
        list.appendChild(spacer);
      }

      if (regularClouds.length) {
        const sectionHeader = document.createElement('div');
        sectionHeader.style.cssText = 'padding:6px 8px;font-size:11px;font-weight:700;color:var(--text2);border-bottom:1px solid var(--border);margin-top:4px;';
        sectionHeader.textContent = translate('viewer.open.pointClouds', { count: regularClouds.length }, `Point Clouds (${regularClouds.length})`);
        list.appendChild(sectionHeader);

        regularClouds.forEach(cloud => {
          const points = cloud.points
            ? translate('viewer.open.points', { count: Number(cloud.points).toLocaleString() }, '{{count}} pts')
            : translate('viewer.open.unknownPointCount', {}, 'Unknown point count');
          const metadataUrl = cloud.metadataUrl || `/pointclouds/${encodeURIComponent(cloud.cloudName || cloud.name)}/metadata.json`;
          const item = document.createElement('div');
          item.className = 'cloud-list-item';
          item.innerHTML = `
            <span style="font-size:18px;">${translate('viewer.open.cloudLabel', {}, 'Cloud')}</span>
            <div style="flex:1;">
              <div style="font-size:12px;font-weight:600;color:var(--text);">${cloud.name}</div>
              <div style="font-size:10px;color:var(--text3);">${points}</div>
            </div>
            <button class="btn pri" style="font-size:10px;padding:4px 10px;">${translate('common.actions.open', {}, 'Open')}</button>`;
          item.querySelector('button').addEventListener('click', () => {
            modal.classList.remove('open');
            loadCloud(metadataUrl, { type: 'cloud', cloudName: cloud.cloudName || cloud.name });
          });
          list.appendChild(item);
        });
      }

      applyTranslations(modal);
    } catch (error) {
      list.innerHTML = `<div style="color:var(--error);font-size:11px;text-align:center;padding:22px;">${translate('viewer.open.loadFailed', { message: error.message }, `Load failed: ${error.message}`)}</div>`;
    }
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
  };
}
