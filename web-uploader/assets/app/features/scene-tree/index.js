export function createSceneTreeFeature({
  viewer,
  translateText,
  applyTranslations,
  elements = {},
  refreshMeasurements,
  refreshVolumes,
  removePointCloudFromScene,
} = {}) {
  const leftPanel = elements.leftPanel || document.getElementById('left-panel');
  const cloudCount = elements.cloudCount || document.getElementById('cnt-clouds');
  const cloudTree = elements.cloudTree || document.getElementById('cloud-tree');
  const cloudsEmpty = elements.cloudsEmpty || document.getElementById('clouds-empty');

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
      item.innerHTML = `
        <span class="ti-icon">☁</span>
        <span class="ti-name" title="${pointcloud.name}">${pointcloud.name}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${pointcloud.visible ? translateText('Hide') : translateText('Show')}">${pointcloud.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${translateText('Fit view')}">⌖</button>
          <button class="icon-btn" title="${translateText('Close')}" style="color:#f55;font-size:13px;">✕</button>
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
      cloudTree.appendChild(item);
    });

    const contourLayers = viewer.scene.scene.children.filter(child => child.name === 'contour_layer');
    contourLayers.forEach(layer => {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `
        <span class="ti-icon" style="color:#19be6b">&#x27BF;</span>
        <span class="ti-name" title="${translateText('Contour Layer')}">3D ${translateText('Contours')}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${layer.visible ? translateText('Hide') : translateText('Show')}">${layer.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${translateText('Close')}" style="color:#f55;font-size:13px;">✕</button>
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
        ? `${translateText('Volume Surface')}${layer.userData?.ownerRegionId ? ` · ${layer.userData.ownerRegionId.replace(/^volume-region-/, 'R')}` : ''}`
        : (type === 'imported-obj' ? (layer.userData?.displayName || translateText('OBJ Mesh')) : translateText('Surface Mesh'));
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.innerHTML = `
        <span class="ti-icon" style="color:#7dd3fc">&#x25A3;</span>
        <span class="ti-name" title="${displayName}">${displayName}</span>
        <div class="ti-acts">
          <button class="icon-btn" title="${layer.visible ? translateText('Hide') : translateText('Show')}">${layer.visible ? '👁' : '🚫'}</button>
          <button class="icon-btn" title="${translateText('Close')}" style="color:#f55;font-size:13px;">✕</button>
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
