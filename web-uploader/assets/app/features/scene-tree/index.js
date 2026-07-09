export function createSceneTreeFeature({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  viewer,
  translate,
  translateText,
  applyTranslations,
  elements = {},
  refreshMeasurements,
  refreshVolumes,
  removePointCloudFromScene,
  toast,
} = {}) {
  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    if (typeof window !== 'undefined' && typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  const leftPanel = elements.leftPanel || document.getElementById('left-panel');
  const cloudCount = elements.cloudCount || document.getElementById('cnt-clouds');
  const cloudTree = elements.cloudTree || document.getElementById('cloud-tree');
  const cloudsEmpty = elements.cloudsEmpty || document.getElementById('clouds-empty');
  let pointcloudContextMenu = null;

  function escapeHtml(value = '') {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closePointcloudContextMenu() {
    if (!pointcloudContextMenu) return;
    pointcloudContextMenu.remove();
    pointcloudContextMenu = null;
  }

  function getPointcloudFolderPayload(pointcloud) {
    return {
      metadataUrl: pointcloud?.userData?.metadataUrl || pointcloud?.pcoGeometry?.url || '',
      cloudName: pointcloud?.userData?.cloudName || pointcloud?.name || '',
      projectId: pointcloud?.userData?.scannerProjectId || pointcloud?.userData?.projectId || '',
    };
  }

  async function openPointcloudFolder(pointcloud) {
    const response = await fetchImpl('/api/desktop/open-pointcloud-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getPointcloudFolderPayload(pointcloud)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.error || data?.message || t('viewer.sceneTree.openFolderFailed', 'Could not open point cloud folder'));
      error.code = data?.errorCode || 'OPEN_POINTCLOUD_FOLDER_FAILED';
      throw error;
    }
    toast?.(t('viewer.sceneTree.folderOpened', 'Point cloud folder opened'), 'ok');
    return data;
  }

  function showPointcloudContextMenu(event, pointcloud) {
    event.preventDefault();
    event.stopPropagation();
    closePointcloudContextMenu();

    const menu = document.createElement('div');
    menu.className = 'scene-tree-context-menu';
    menu.setAttribute('role', 'menu');

    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'scene-tree-context-menu-item';
    openButton.setAttribute('role', 'menuitem');
    openButton.textContent = t('viewer.sceneTree.openPointCloudFolder', 'Open Point Cloud Folder');
    openButton.addEventListener('click', async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closePointcloudContextMenu();
      try {
        await openPointcloudFolder(pointcloud);
      } catch (error) {
        toast?.(t('viewer.sceneTree.openFolderFailedWithMessage', 'Could not open point cloud folder: {{message}}', { message: error.message }), 'err');
      }
    });

    menu.appendChild(openButton);
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(event.clientX, window.innerWidth - rect.width - margin);
    const top = Math.min(event.clientY, window.innerHeight - rect.height - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
    pointcloudContextMenu = menu;

    setTimeout(() => {
      const closeOnOutsidePointer = (pointerEvent) => {
        if (menu.contains(pointerEvent.target)) {
          document.addEventListener('pointerdown', closeOnOutsidePointer, { once: true });
          return;
        }
        closePointcloudContextMenu();
      };
      document.addEventListener('pointerdown', closeOnOutsidePointer, { once: true });
      document.addEventListener('keydown', closePointcloudContextMenu, { once: true });
      window.addEventListener('resize', closePointcloudContextMenu, { once: true });
      window.addEventListener('scroll', closePointcloudContextMenu, { once: true, capture: true });
    }, 0);
  }

  function removeContourLayer(layer) {
    layer.parent?.remove(layer);
    layer.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
    refreshSceneTree();
  }

  function removeSceneLayer(layer) {
    layer.parent?.remove(layer);
    layer.traverse?.(child => {
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach(mat => mat?.dispose?.());
      else if (child.material) child.material.dispose();
    });
  }

  function findMeshLayers() {
    const matches = [];
    [viewer.scene.scene, viewer.scene.scenePointCloud].filter(Boolean).forEach(root => {
      root.traverse?.(child => {
        if (child?.userData?.meshLayerType === 'surface' || child?.userData?.meshLayerType === 'volume-surface' || child?.userData?.meshLayerType === 'imported-obj') {
          matches.push(child);
        }
      });
    });
    return matches;
  }

  function refreshClouds() {
    const clouds = viewer.scene.pointclouds;
    cloudCount.textContent = clouds.length;
    cloudTree.innerHTML = '';
    cloudsEmpty.style.display = clouds.length ? 'none' : '';

    clouds.forEach(pointcloud => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.setAttribute('data-pointcloud-context-menu', 'true');
      item.innerHTML = `
        <span class="ti-icon">☁</span>
        <span class="ti-name" title="${escapeHtml(pointcloud.name)}">${escapeHtml(pointcloud.name)}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${escapeHtml(pointcloud.visible ? t('viewer.sceneTree.hide', 'Hide') : t('viewer.sceneTree.show', 'Show'))}">${pointcloud.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${escapeHtml(t('viewer.sceneTree.fitView', 'Fit view'))}">⌖</button>
          <button class="icon-btn" title="${escapeHtml(t('common.actions.close', 'Close'))}" style="color:#f55;font-size:13px;">✕</button>
        </div>`;
      const [visButton, fitButton, closeButton] = item.querySelectorAll('.icon-btn');
      visButton.addEventListener('click', event => {
        event.stopPropagation();
        pointcloud.visible = !pointcloud.visible;
        visButton.textContent = pointcloud.visible ? '👁' : '🚫';
      });
      fitButton.addEventListener('click', event => {
        event.stopPropagation();
        viewer.fitToScreen();
      });
      closeButton.addEventListener('click', event => {
        event.stopPropagation();
        removePointCloudFromScene(pointcloud);
      });
      item.addEventListener('contextmenu', event => {
        showPointcloudContextMenu(event, pointcloud);
      });
      cloudTree.appendChild(item);
    });

    const contourLayers = viewer.scene.scene.children.filter(child => child.name === 'contour_layer');
    contourLayers.forEach(layer => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `
        <span class="ti-icon" style="color:#19be6b">&#x27BF;</span>
        <span class="ti-name" title="${escapeHtml(t('viewer.sceneTree.contourLayer', 'Contour Layer'))}">3D ${escapeHtml(t('viewer.sceneTree.contours', 'Contours'))}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${escapeHtml(layer.visible ? t('viewer.sceneTree.hide', 'Hide') : t('viewer.sceneTree.show', 'Show'))}">${layer.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${escapeHtml(t('common.actions.close', 'Close'))}" style="color:#f55;font-size:13px;">✕</button>
        </div>`;
      const [visButton, closeButton] = item.querySelectorAll('.icon-btn');
      visButton.addEventListener('click', event => {
        event.stopPropagation();
        layer.visible = !layer.visible;
        visButton.textContent = layer.visible ? '👁' : '🚫';
      });
      closeButton.addEventListener('click', event => {
        event.stopPropagation();
        removeContourLayer(layer);
      });
      cloudTree.appendChild(item);
      cloudCount.textContent = Number.parseInt(cloudCount.textContent, 10) + 1;
      cloudsEmpty.style.display = 'none';
    });

    const surfaceLayers = findMeshLayers();
    surfaceLayers.forEach(layer => {
      const type = layer.userData?.meshLayerType;
      const displayName = type === 'volume-surface'
        ? (layer.userData?.displayName || `${t('viewer.sceneTree.volumeSurface', 'Volume Surface')}${layer.userData?.ownerRegionId ? ` · ${layer.userData.ownerRegionId.replace(/^volume-region-/, 'R')}` : ''}`)
        : (type === 'imported-obj' ? (layer.userData?.displayName || t('viewer.sceneTree.objMesh', 'OBJ Mesh')) : t('viewer.sceneTree.surfaceMesh', 'Surface Mesh'));
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `
        <span class="ti-icon" style="color:#7dd3fc">&#x25A3;</span>
        <span class="ti-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${escapeHtml(layer.visible ? t('viewer.sceneTree.hide', 'Hide') : t('viewer.sceneTree.show', 'Show'))}">${layer.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${escapeHtml(t('common.actions.close', 'Close'))}" style="color:#f55;font-size:13px;">✕</button>
        </div>`;
      const [visButton, closeButton] = item.querySelectorAll('.icon-btn');
      visButton.addEventListener('click', event => {
        event.stopPropagation();
        layer.visible = !layer.visible;
        visButton.textContent = layer.visible ? '👁' : '🚫';
      });
      closeButton.addEventListener('click', event => {
        event.stopPropagation();
        removeSceneLayer(layer);
        refreshSceneTree();
      });
      cloudTree.appendChild(item);
      cloudCount.textContent = Number.parseInt(cloudCount.textContent, 10) + 1;
      cloudsEmpty.style.display = 'none';
    });
  }

  function refreshSceneTree() {
    refreshClouds();
    refreshMeasurements();
    refreshVolumes();
    applyTranslations(leftPanel);
  }

  return {
    refreshClouds,
    refreshSceneTree,
  };
}
