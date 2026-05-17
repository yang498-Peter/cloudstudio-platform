export function createTerrainFeature({
  fetchImpl = window.fetch.bind(window),
  viewer,
  translateText,
  toast,
  getCurrentScannerProjectId,
  getActiveDatasetContext,
  showImageInViewer,
  updateTerrainStats,
  refreshSceneTree,
  loadCloud,
  activateClassificationView,
  convertLocalPointToCurrentSystem,
} = {}) {
  const dtmState = { lastJobId: null };
  const surfaceState = { lastJobId: null, lastGrid: null, lastMeta: null };
  const contourState = { lastJobId: null };
  const gcState = { lastOutputPath: null };
  const semanticState = { lastOutputPath: null, lastIntermediates: null };
  const treeState = { lastOutputPath: null };

  function getThree() {
    return window.__CLOUDSTUDIO_THREE || window.THREE || window.Potree?.THREE || null;
  }

  /**
   * Convert a local-space Z value to the display Z in the current coordinate
   * system (e.g., applies heightOffset or full CRS transformation).
   *
   * Uses a representative XY position near the center of the data.  For local
   * and height-offset-only systems this is exact.  For full projected CRS the
   * result is precise for small areas (the Z shift is nearly constant across a
   * typical survey polygon).
   *
   * Falls back to the raw local Z when no transform function is available or
   * when the transform returns a pending-native (server-side) result.
   *
   * @param {number} localZ  – Z value in Three.js world / LAS space
   * @param {number} [refX]  – representative X (defaults to 0)
   * @param {number} [refY]  – representative Y (defaults to 0)
   * @returns {number}  display Z value
   */
  function localZToDisplayZ(localZ, refX = 0, refY = 0) {
    if (typeof convertLocalPointToCurrentSystem !== 'function') return localZ;
    try {
      const result = convertLocalPointToCurrentSystem({ x: refX, y: refY, z: localZ });
      // Pending native = server transform queued but not yet complete — fall back
      if (result?.pendingNative) return localZ;
      // Projected / local result: use .z; geographic result: use .alt
      const dz = result?.z ?? result?.alt;
      return (typeof dz === 'number' && isFinite(dz)) ? dz : localZ;
    } catch (_) {
      return localZ;
    }
  }

  const TERRAIN_PRESETS = {
    forest: {
      label: 'Forest',
      semantic: { hagNeighborCount: 8, geometryNeighborCount: 24 },
      tree: { seedMinHeight: 1.5, seedMaxHeight: 4.0, clusterRadius: 0.75, maxCrownRadius: 5.5, chmResolution: 0.8 },
    },
    park: {
      label: 'Park',
      semantic: { hagNeighborCount: 8, geometryNeighborCount: 16 },
      tree: { seedMinHeight: 1.2, seedMaxHeight: 3.0, clusterRadius: 0.6, maxCrownRadius: 4.0, chmResolution: 0.75 },
    },
    urban: {
      label: 'Urban',
      semantic: { hagNeighborCount: 6, geometryNeighborCount: 12 },
      tree: { seedMinHeight: 1.0, seedMaxHeight: 2.8, clusterRadius: 0.5, maxCrownRadius: 3.5, chmResolution: 0.6 },
    },
  };

  function setStatusText(elementId, text, color = null) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = tx(text);
    if (color) el.style.color = color;
  }

  function tx(text) {
    if (text == null) return '';
    return typeof translateText === 'function' ? translateText(String(text)) : String(text);
  }

  function tk(key, vars = {}, fallback = '') {
    if (window.APP_I18N?.t) {
      return window.APP_I18N.t(key, vars, fallback);
    }
    return tx(fallback || key);
  }

  function terrainToast(message, level = 'info', duration) {
    toast?.(tx(message), level, duration);
  }

  function terrainStats(message) {
    updateTerrainStats?.(tx(message));
  }

  function getSelectedPresetKey(selectId, fallback = 'park') {
    const value = document.getElementById(selectId)?.value;
    return TERRAIN_PRESETS[value] ? value : fallback;
  }

  function applySemanticPreset(presetKey = getSelectedPresetKey('sel-semantic-preset')) {
    const preset = TERRAIN_PRESETS[presetKey];
    if (!preset) return;
    const presetLabel = tx(preset.label);
    const hagSelect = document.getElementById('sel-semantic-hag-neighbors');
    const geomSelect = document.getElementById('sel-semantic-geom-neighbors');
    if (hagSelect) hagSelect.value = String(preset.semantic.hagNeighborCount);
    if (geomSelect) geomSelect.value = String(preset.semantic.geometryNeighborCount);
    setStatusText('semantic-status', `${tx('Preset applied')}: ${presetLabel}`, 'var(--text2)');
    terrainStats(`${tx('Semantic preset')}: ${presetLabel}`);
  }

  function applyTreePreset(presetKey = getSelectedPresetKey('sel-tree-preset')) {
    const preset = TERRAIN_PRESETS[presetKey];
    if (!preset) return;
    const presetLabel = tx(preset.label);
    const tree = preset.tree;
    const assignValue = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.value = String(value);
    };
    assignValue('inp-tree-seed-min', tree.seedMinHeight);
    assignValue('inp-tree-seed-max', tree.seedMaxHeight);
    assignValue('inp-tree-cluster-radius', tree.clusterRadius);
    assignValue('inp-tree-crown-radius', tree.maxCrownRadius);
    assignValue('inp-tree-chm-res', tree.chmResolution);
    setStatusText('tree-status', `${tx('Preset applied')}: ${presetLabel}`, 'var(--text2)');
    terrainStats(`${tx('Tree preset')}: ${presetLabel}`);
  }

  function openTerrainModal(tab) {
    window.APP_I18N?.applyTranslations?.(document.getElementById('terrain-overlay'));
    document.getElementById('terrain-overlay')?.classList.add('open');
    if (tab) switchTerrainTab(tab);
    if (tab === 'semantic' && !document.getElementById('semantic-status')?.textContent) {
      applySemanticPreset(getSelectedPresetKey('sel-semantic-preset'));
    }
    if (tab === 'trees' && !document.getElementById('tree-status')?.textContent) {
      applyTreePreset(getSelectedPresetKey('sel-tree-preset'));
    }
    if (tab === 'dtm' && !document.getElementById('inp-las-path')?.value) {
      autoDetectLas();
    }
    if (tab === 'dtm') {
      toggleSurfaceFixedHeightRow();
    }
    if (tab === 'semantic' && !document.getElementById('inp-semantic-las')?.value) {
      autoFillSemanticInput();
    }
    if (tab === 'trees' && !document.getElementById('inp-tree-las')?.value) {
      autoFillTreeInput();
    }
  }

  function closeTerrainModal() {
    document.getElementById('terrain-overlay')?.classList.remove('open');
  }

  window.APP_I18N?.onLocaleChange?.(() => {
    window.APP_I18N?.applyTranslations?.(document.getElementById('terrain-overlay'));
  });

  function switchTerrainTab(tabKey) {
    document.querySelectorAll('.terrain-step-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.terrainTab === tabKey);
    });
    document.querySelectorAll('.terrain-form-step').forEach(step => {
      step.classList.toggle('active', step.dataset.terrainStep === tabKey);
    });
  }

  function toggleSurfaceFixedHeightRow() {
    const mode = document.getElementById('sel-surface-hole-mode')?.value || 'interpolate';
    const row = document.getElementById('row-surface-fixed-height');
    if (row) row.style.display = mode === 'fixed' ? '' : 'none';
  }

  function disposeSceneNode(node) {
    if (!node) return;
    node.traverse?.(child => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach(mat => mat?.dispose?.());
      else child.material?.dispose?.();
    });
  }

  function collectRoots() {
    return [viewer?.scene?.scene, viewer?.scene?.scenePointCloud].filter(Boolean);
  }

  function findSceneNodesByName(name) {
    const matches = [];
    collectRoots().forEach(root => {
      root.traverse?.(node => {
        if (node?.name === name) matches.push(node);
      });
    });
    return matches;
  }

  function getSurfaceLayerName(kind = 'terrain', ownerRegionId = null, surfaceRole = 'analysis') {
    if (kind === 'volume' && ownerRegionId) {
      return `volume_surface_mesh_layer_${ownerRegionId}_${surfaceRole || 'analysis'}`;
    }
    return 'surface_mesh_layer';
  }

  function getSurfaceLayerNames(kind = 'terrain', ownerRegionId = null, surfaceRole = 'analysis') {
    const names = [getSurfaceLayerName(kind, ownerRegionId, surfaceRole)];
    // Backward compatibility with older volume layers that did not encode role.
    if (kind === 'volume' && ownerRegionId && (surfaceRole || 'analysis') === 'analysis') {
      names.push(`volume_surface_mesh_layer_${ownerRegionId}`);
    }
    return names;
  }

  function findPointCloudByUuid(uuid) {
    if (!uuid || !viewer?.scene?.pointclouds?.length) return null;
    return viewer.scene.pointclouds.find(pointcloud => pointcloud?.uuid === uuid) || null;
  }

  /**
   * Build THREE.Plane array from a 2-D polygon (array of {x,y} or [x,y]) so that
   * material.clippingPlanes keeps only fragments inside the polygon.
   * Works correctly for both CW and CCW windings.
   */
  function createPolygonClippingPlanes(THREE, polygonXY) {
    const n = polygonXY?.length || 0;
    if (n < 3) return [];
    const pts = polygonXY.map(p => ({
      x: Number(p?.x ?? p?.[0] ?? 0),
      y: Number(p?.y ?? p?.[1] ?? 0),
    }));
    // Shoelace signed area — positive means CCW (standard math / LAS Y-north)
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    const sign = area2 >= 0 ? 1 : -1; // CCW → +1, CW → −1
    const planes = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) continue;
      // Inward normal: left-perp of edge for CCW, right-perp for CW
      const nx = sign * (-dy / len);
      const ny = sign * (dx / len);
      // THREE.Plane keeps fragments where nx*px + ny*py + c >= 0;
      // boundary passes through a, so c = −(nx*a.x + ny*a.y)
      planes.push(new THREE.Plane(
        new THREE.Vector3(nx, ny, 0),
        -(nx * a.x + ny * a.y),
      ));
    }
    return planes;
  }

  function resolveSurfaceAttachParent(attachPointcloudUuid = null) {
    // Mesh must be added to viewer.scene.scene (rendered by Three.js renderer),
    // NOT to scenePointCloud subtree (only rendered by Potree pRenderer for point clouds).
    return viewer?.scene?.scene || null;
  }

  function resolveSurfaceAttachObject(attachPointcloudUuid = null) {
    const pointcloud = findPointCloudByUuid(attachPointcloudUuid);
    return pointcloud?.parent || pointcloud || null;
  }

  function computeSurfaceLocalOrigin(meshData) {
    const polygon = Array.isArray(meshData?.meta?.polygon) ? meshData.meta.polygon : [];
    const source = polygon.length
      ? polygon.map(point => ({
        x: Number(point?.x ?? 0),
        y: Number(point?.y ?? 0),
        z: Number(point?.z ?? 0),
      }))
      : (Array.isArray(meshData?.vertices) ? meshData.vertices.map(vertex => ({
        x: Number(vertex?.[0] ?? 0),
        y: Number(vertex?.[1] ?? 0),
        z: Number(vertex?.[2] ?? 0),
      })) : []);
    if (!source.length) return { x: 0, y: 0, z: 0 };
    const sum = source.reduce((acc, point) => {
      acc.x += point.x;
      acc.y += point.y;
      acc.z += point.z;
      return acc;
    }, { x: 0, y: 0, z: 0 });
    return {
      x: sum.x / source.length,
      y: sum.y / source.length,
      z: sum.z / source.length,
    };
  }

  function localPointToWorld(THREE, point, attachObject = null) {
    const vector = new THREE.Vector3(
      Number(point?.x ?? point?.[0] ?? 0),
      Number(point?.y ?? point?.[1] ?? 0),
      Number(point?.z ?? point?.[2] ?? 0),
    );
    if (!attachObject) return vector;
    attachObject.updateMatrixWorld?.(true);
    return vector.applyMatrix4(attachObject.matrixWorld);
  }

  function buildSurfaceLayerContainer(THREE, {
    kind = 'terrain',
    attachPointcloudUuid = null,
    ownerRegionId = null,
    displayName = '',
    surfaceRole = 'analysis',
    localOrigin = { x: 0, y: 0, z: 0 },
    meta = null,
  } = {}) {
    const attachParent = resolveSurfaceAttachParent(attachPointcloudUuid);
    const attachObject = resolveSurfaceAttachObject(attachPointcloudUuid);
    const originWorld = localPointToWorld(THREE, localOrigin, attachObject);
    const attachQuaternion = new THREE.Quaternion();
    const attachScale = new THREE.Vector3(1, 1, 1);
    if (attachObject) {
      const worldPosition = new THREE.Vector3();
      attachObject.updateMatrixWorld?.(true);
      attachObject.matrixWorld.decompose(worldPosition, attachQuaternion, attachScale);
    }

    const layer = new THREE.Group();
    layer.name = kind === 'volume'
      ? getSurfaceLayerName(kind, ownerRegionId, surfaceRole)
      : (kind === 'obj' ? `imported_obj_mesh_${Date.now()}` : getSurfaceLayerName(kind, ownerRegionId));
    layer.position.copy(originWorld);
    layer.quaternion.copy(attachQuaternion);
    layer.scale.copy(attachScale);
    layer.userData.surfaceMeta = meta || null;
    layer.userData.meshLayerType = kind === 'volume' ? 'volume-surface' : (kind === 'obj' ? 'imported-obj' : 'surface');
    layer.userData.ownerRegionId = ownerRegionId || null;
    layer.userData.surfaceRole = surfaceRole || 'analysis';
    layer.userData.sourceJobId = meta?.sourceJobId || null;
    layer.userData.displayName = displayName || meta?.displayName || layer.name;
    layer.userData.localOrigin = { ...localOrigin };

    attachParent?.add(layer);
    return { layer, attachObject };
  }

  function normalizeSurfaceMeshPayload(meshSource) {
    if (!meshSource || typeof meshSource !== 'object') return null;

    const looksLikeMeshData = value => Boolean(
      value
      && typeof value === 'object'
      && (Array.isArray(value.vertices) || Array.isArray(value.faces))
    );

    if (looksLikeMeshData(meshSource)) {
      return {
        jobId: meshSource.jobId || meshSource.meta?.sourceJobId || null,
        gridData: meshSource.gridData || meshSource.grid || null,
        meshData: {
          meta: meshSource.meta || {},
          vertices: meshSource.vertices || [],
          colors: meshSource.colors || [],
          faces: meshSource.faces || [],
        },
      };
    }

    const nestedMeshData = meshSource.meshData || meshSource.mesh || null;
    if (!looksLikeMeshData(nestedMeshData)) return null;

    return {
      jobId: meshSource.jobId || nestedMeshData.meta?.sourceJobId || null,
      gridData: meshSource.gridData || meshSource.grid || null,
      meshData: {
        meta: nestedMeshData.meta || meshSource.meta || {},
        vertices: nestedMeshData.vertices || [],
        colors: nestedMeshData.colors || [],
        faces: nestedMeshData.faces || [],
      },
    };
  }

  function createMeshLayerFromData(meshData, {
    kind = 'terrain',
    attachPointcloudUuid = null,
    ownerRegionId = null,
    displayName = '',
    surfaceRole = 'analysis',
  } = {}) {
    const THREE = getThree();
    if (!THREE) {
      throw new Error('THREE runtime is unavailable');
    }
    const isVolume = kind === 'volume';
    const localOrigin = computeSurfaceLocalOrigin(meshData);
    const { layer, attachObject } = buildSurfaceLayerContainer(THREE, {
      kind,
      attachPointcloudUuid,
      ownerRegionId,
      displayName,
      surfaceRole,
      localOrigin,
      meta: meshData.meta || null,
    });
    const positions = new Float32Array((meshData.vertices || []).length * 3);
    const colors = new Float32Array((meshData.colors || []).length * 3);
    (meshData.vertices || []).forEach((vertex, index) => {
      positions[index * 3 + 0] = Number(vertex[0] || 0) - localOrigin.x;
      positions[index * 3 + 1] = Number(vertex[1] || 0) - localOrigin.y;
      positions[index * 3 + 2] = Number(vertex[2] || 0) - localOrigin.z;
    });
    (meshData.colors || []).forEach((color, index) => {
      colors[index * 3 + 0] = color[0];
      colors[index * 3 + 1] = color[1];
      colors[index * 3 + 2] = color[2];
    });

    const flatFaces = [];
    (meshData.faces || []).forEach(face => flatFaces.push(face[0], face[1], face[2]));

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(flatFaces);
    geometry.computeVertexNormals();

    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: isVolume ? 0.85 : 0.70,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0;
    mesh.name = 'surface_mesh_body';

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 0),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthTest: true })
    );
    edges.name = 'surface_mesh_edges';
    edges.renderOrder = 1;
    mesh.add(edges);

    // ── Polygon clipping planes ──────────────────────────────────────────────
    // Clip the mesh and edges exactly to the selection polygon so the boundary
    // follows the polygon shape rather than the blocky grid cell pattern.
    const polygon = meshData?.meta?.polygon;
    if (polygon?.length >= 3) {
      const worldPolygon = polygon.map(point => localPointToWorld(THREE, point, attachObject));
      const planes = createPolygonClippingPlanes(THREE, worldPolygon);
      if (planes.length >= 3) {
        material.clippingPlanes = planes;
        material.clipIntersection = false;
        edges.material.clippingPlanes = planes;
        edges.material.clipIntersection = false;
        // localClippingEnabled must be true on the renderer for per-material planes to work.
        if (viewer?.renderer) viewer.renderer.localClippingEnabled = true;
      }
    }

    layer.add(mesh);
    return layer;
  }

  function toggleSurfaceEdgesVisibility(kind = 'volume', ownerRegionId = null, visible = null, surfaceRole = 'analysis') {
    const layerNames = getSurfaceLayerNames(kind, ownerRegionId, surfaceRole);
    const nodes = layerNames.flatMap(name => findSceneNodesByName(name));
    nodes.forEach(node => {
      const edgesNode = node.getObjectByName('surface_mesh_edges');
      if (edgesNode) {
        edgesNode.visible = visible !== null ? Boolean(visible) : !edgesNode.visible;
      }
    });
  }

  // ─── Contour generation from grid data ────────────────────────────────────

  function getContourLayerName(kind = 'volume', ownerRegionId = null) {
    return ownerRegionId ? `volume_contour_layer_${ownerRegionId}` : `${kind}_contour_layer`;
  }

  function removeContoursFrom3D(kind = 'volume', ownerRegionId = null) {
    const layerName = getContourLayerName(kind, ownerRegionId);
    const nodes = findSceneNodesByName(layerName);
    nodes.forEach(node => { node.parent?.remove(node); disposeSceneNode(node); });
    refreshSceneTree?.();
  }

  function toggleContourLabels(kind = 'volume', ownerRegionId = null, visible = null) {
    const layerName = getContourLayerName(kind, ownerRegionId);
    const nodes = findSceneNodesByName(layerName);
    let found = false;
    nodes.forEach(group => {
      group.traverse(child => {
        if (child.isSprite) {
          child.visible = visible !== null ? Boolean(visible) : !child.visible;
          found = true;
        }
      });
    });
    return found;
  }

  function resizeContourLabels(kind = 'volume', ownerRegionId = null, labelScale = 1.0) {
    const layerName = getContourLayerName(kind, ownerRegionId);
    const nodes = findSceneNodesByName(layerName);
    const sy = LABEL_BASE_SCALE_Y * Math.max(0.1, labelScale);
    nodes.forEach(group => {
      group.traverse(child => {
        if (child.isSprite) {
          child.scale.set(sy * LABEL_ASPECT, sy, 1);
        }
      });
    });
  }

  // ─── Export contour lines as DXF ──────────────────────────────────────────
  // Each elevation level becomes a named DXF layer so the recipient can
  // filter / style by elevation in AutoCAD, QGIS, etc.
  function exportContoursAsDXF(kind = 'volume', ownerRegionId = null) {
    const THREE = getThree();
    const layerName = getContourLayerName(kind, ownerRegionId);
    const nodes = findSceneNodesByName(layerName);
    if (!nodes.length) {
      toast(tx('No contour lines — generate contours first'), 'err', 2500);
      return;
    }

    const parts = [];
    // Minimal DXF R12 header
    parts.push(
      '0\nSECTION\n2\nHEADER\n',
      '9\n$ACADVER\n1\nAC1009\n',  // R12
      '0\nENDSEC\n',
      '0\nSECTION\n2\nTABLES\n',
      '0\nTABLE\n2\nLAYER\n70\n0\n',
      '0\nENDTABLE\n',
      '0\nENDSEC\n',
      '0\nSECTION\n2\nENTITIES\n',
    );

    let segCount = 0;
    for (const group of nodes) {
      // Retrieve the Z display transform stored when contours were generated
      const _shift = typeof group.userData.zDispShift === 'number' ? group.userData.zDispShift : 0;
      const _scale = typeof group.userData.zDispScale === 'number' ? group.userData.zDispScale : 1;
      const _origin = group.userData?.localOrigin || { x: 0, y: 0, z: 0 };
      const toDispZ = (lz) => lz * _scale + _shift;

      group.traverse(child => {
        if (!child.isLineSegments) return;
        const pos = child.geometry?.getAttribute('position');
        if (!pos || pos.count < 2) return;
        child.updateMatrixWorld?.(true);
        for (let i = 0; i + 1 < pos.count; i += 2) {
          const p1 = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(child.matrixWorld);
          const p2 = new THREE.Vector3(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)).applyMatrix4(child.matrixWorld);
          const x1 = p1.x, y1 = p1.y, z1 = toDispZ(pos.getZ(i) + Number(_origin.z || 0));
          const x2 = p2.x, y2 = p2.y, z2 = toDispZ(pos.getZ(i + 1) + Number(_origin.z || 0));
          const elev = z1.toFixed(3);
          parts.push(
            `0\nLINE\n8\nContour_${elev}m\n`,
            `10\n${x1.toFixed(4)}\n20\n${y1.toFixed(4)}\n30\n${z1.toFixed(4)}\n`,
            `11\n${x2.toFixed(4)}\n21\n${y2.toFixed(4)}\n31\n${z2.toFixed(4)}\n`,
          );
          segCount++;
        }
      });
    }

    parts.push('0\nENDSEC\n0\nEOF\n');

    if (!segCount) {
      toast(tx('Contour group exists but contains no line segments'), 'err', 2500);
      return;
    }

    const blob = new Blob([parts.join('')], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `contours_${ownerRegionId || kind}_${Date.now()}.dxf`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast(`${tx('Contours exported')}: ${segCount} ${tx('segments')} → DXF`, 'ok', 2800);
  }

  function _elevColorThree(THREE, t) {
    const tc = Math.max(0, Math.min(1, t));
    const stops = [
      [0.00, [0.10, 0.24, 0.56]],
      [0.18, [0.14, 0.47, 0.73]],
      [0.36, [0.21, 0.62, 0.45]],
      [0.58, [0.70, 0.74, 0.42]],
      [0.80, [0.63, 0.43, 0.25]],
      [1.00, [0.94, 0.95, 0.98]],
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      if (tc <= t1) {
        const local = t1 > t0 ? (tc - t0) / (t1 - t0) : 0;
        return new THREE.Color(
          c0[0] + (c1[0] - c0[0]) * local,
          c0[1] + (c1[1] - c0[1]) * local,
          c0[2] + (c1[2] - c0[2]) * local
        );
      }
    }
    return new THREE.Color(0.94, 0.95, 0.98);
  }

  function _makeElevLabel(THREE, text, color) {
    // No background box — just bold text with a thick dark outline stroke so it
    // reads cleanly against the coloured mesh surface.
    // 3× DPR gives sharp rasterisation regardless of screen resolution.
    const DPR = 3;
    const LW = 120, LH = 44; // logical canvas size (pixels)
    const canvas = document.createElement('canvas');
    canvas.width = LW * DPR;
    canvas.height = LH * DPR;
    const ctx = canvas.getContext('2d');
    ctx.scale(DPR, DPR);
    ctx.clearRect(0, 0, LW, LH);
    const cr = Math.round(color.r * 255);
    const cg = Math.round(color.g * 255);
    const cb = Math.round(color.b * 255);
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Heavy dark outline — ensures readability on any background colour
    ctx.strokeStyle = 'rgba(0,0,0,0.95)';
    ctx.lineWidth = 8;
    ctx.strokeText(text, LW / 2, LH / 2);
    // Elevation-matched fill colour
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillText(text, LW / 2, LH / 2);
    const texture = new THREE.CanvasTexture(canvas);
    // sizeAttenuation: false keeps constant screen size regardless of camera distance.
    // Scale is in NDC units where full screen height = 2.0.
    // (0.28, 0.095) ≈ 51 px tall at 1080 p — clearly legible.
    const mat = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    return new THREE.Sprite(mat);
  }

  // Base sprite scale (NDC units, sizeAttenuation:false).
  // scale.y=0.047 ≈ 25px at 1080p — readable but compact.
  const LABEL_BASE_SCALE_Y = 0.047;
  const LABEL_ASPECT = 120 / 44; // canvas width/height

  function generateContoursFromGrid(gridData, contourInterval, {
    kind = 'volume',
    ownerRegionId = null,
    labelScale = 1.0,
    attachPointcloudUuid = null,
  } = {}) {
    const THREE = getThree();
    if (!THREE || !viewer || !gridData?.meta || !gridData?.grid) return null;

    const meta = gridData.meta;
    const grid = gridData.grid;
    const xMin = meta.xMin;
    const yMin = meta.yMin;
    const resX = meta.resolutionX;
    const resY = meta.resolutionY;
    const rows = grid.length;
    if (!rows) return null;
    const cols = grid[0]?.length || 0;
    if (!cols) return null;

    let zMin = Infinity, zMax = -Infinity;
    for (const row of grid) {
      for (const v of row) {
        if (v !== null && v !== undefined && isFinite(v)) {
          if (v < zMin) zMin = v;
          if (v > zMax) zMax = v;
        }
      }
    }
    if (!isFinite(zMin) || !isFinite(zMax) || zMax <= zMin) {
      toast(tx('No valid elevation data for contours'), 'err', 2500);
      return null;
    }

    // ── Coordinate display transform ─────────────────────────────────────────
    // The grid Z values are in Three.js local (LAS) space.  If the user has
    // applied a CRS transform (height offset, projected system, etc.) the
    // displayed elevation differs.  We sample the transform at the grid centroid
    // (Z shift is nearly constant across a small survey polygon) to compute a
    // linear mapping: displayZ = localZ + zDisplayShift.
    //
    // For local-only (no CRS), localZToDisplayZ is an identity → shift = 0.
    const refX = xMin + cols * resX * 0.5;
    const refY = yMin + rows * resY * 0.5;
    const _dispZMin = localZToDisplayZ(zMin, refX, refY);
    const _dispZMax = localZToDisplayZ(zMax, refX, refY);
    // Scale (handles rare cases where Z axis is inverted / scaled by CRS)
    const _zDispScale  = (zMax > zMin) ? (_dispZMax - _dispZMin) / (zMax - zMin) : 1.0;
    const _zDispShift  = _dispZMin - zMin * _zDispScale;
    /** Local Z → display Z (label text, DXF export) */
    const localToDisp  = (lz) => lz * _zDispScale + _zDispShift;
    /** Display Z → local Z (for triangle-crossing placement) */
    const dispToLocal  = (dz) => (dz - _zDispShift) / _zDispScale;

    removeContoursFrom3D(kind, ownerRegionId);

    const interval = Math.max(0.001, Number(contourInterval) || 0.5);
    // Generate level list in DISPLAY space so the user-facing interval is exact.
    const displayZMin = localToDisp(zMin);
    const displayZMax = localToDisp(zMax);
    const firstLevel = Math.ceil((displayZMin + 1e-9) / interval) * interval;
    // levels[] stores DISPLAY-space Z values (what the user sees in labels)
    const levels = [];
    for (let dz = firstLevel; dz <= displayZMax + 1e-9; dz += interval) {
      levels.push(Math.round(dz / interval) * interval);
    }
    if (!levels.length) {
      toast(tx('Contour interval too large — no contour lines in this elevation range'), 'info', 2800);
      return null;
    }

    const labelEvery = Math.max(1, Math.ceil(levels.length / 8));
    const contourPolygon = Array.isArray(gridData?.meta?.polygon) ? gridData.meta.polygon : [];
    const localOrigin = computeSurfaceLocalOrigin({ meta: { polygon: contourPolygon } });
    const { layer: contourGroup, attachObject } = buildSurfaceLayerContainer(THREE, {
      kind: 'obj',
      attachPointcloudUuid,
      ownerRegionId,
      displayName: 'Volume Contours',
      surfaceRole: 'analysis',
      localOrigin,
      meta: gridData.meta,
    });
    contourGroup.name = getContourLayerName(kind, ownerRegionId);
    contourGroup.userData.meshLayerType = 'volume-contours';
    contourGroup.userData.ownerRegionId = ownerRegionId;
    contourGroup.userData.zDispShift = _zDispShift;
    contourGroup.userData.zDispScale = _zDispScale;

    for (let li = 0; li < levels.length; li++) {
      const zLevelDisp = levels[li];           // display-space Z for label text / DXF
      const zLevel     = dispToLocal(zLevelDisp); // local-space Z for geometry (triangle crossing)
      const t = (zLevelDisp - displayZMin) / Math.max(displayZMax - displayZMin, 1e-9);
      const color = _elevColorThree(THREE, t);
      const positions = [];
      let labelPos = null;

      for (let iy = 0; iy < rows - 1; iy++) {
        for (let ix = 0; ix < cols - 1; ix++) {
          const z00 = grid[iy][ix];
          const z10 = grid[iy][ix + 1];
          const z01 = grid[iy + 1][ix];
          const z11 = grid[iy + 1][ix + 1];
          if (z00 === null || z10 === null || z01 === null || z11 === null) continue;

          const x0 = xMin + ix * resX + resX * 0.5;
          const x1 = xMin + (ix + 1) * resX + resX * 0.5;
          const y0 = yMin + iy * resY + resY * 0.5;
          const y1 = yMin + (iy + 1) * resY + resY * 0.5;

          const processTriangle = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
            const zLo = Math.min(az, bz, cz), zHi = Math.max(az, bz, cz);
            if (zLo >= zLevel || zHi < zLevel) return;
            const crossings = [];
            const checkEdge = (x1e, y1e, z1e, x2e, y2e, z2e) => {
              if ((z1e >= zLevel) !== (z2e >= zLevel)) {
                const tt = (zLevel - z1e) / (z2e - z1e);
                crossings.push([x1e + (x2e - x1e) * tt, y1e + (y2e - y1e) * tt, zLevel]);
              }
            };
            checkEdge(ax, ay, az, bx, by, bz);
            checkEdge(bx, by, bz, cx, cy, cz);
            checkEdge(cx, cy, cz, ax, ay, az);
            if (crossings.length === 2) {
              positions.push(
                crossings[0][0] - localOrigin.x,
                crossings[0][1] - localOrigin.y,
                crossings[0][2] - localOrigin.z
              );
              positions.push(
                crossings[1][0] - localOrigin.x,
                crossings[1][1] - localOrigin.y,
                crossings[1][2] - localOrigin.z
              );
              if (!labelPos) {
                labelPos = [
                  ((crossings[0][0] + crossings[1][0]) / 2) - localOrigin.x,
                  ((crossings[0][1] + crossings[1][1]) / 2) - localOrigin.y,
                  zLevel - localOrigin.z,
                ];
              }
            }
          };

          processTriangle(x0, y0, z00, x1, y0, z10, x0, y1, z01);
          processTriangle(x1, y0, z10, x1, y1, z11, x0, y1, z01);
        }
      }

      if (!positions.length) continue;

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      // White lines at high render order so they always read clearly
      // against the coloured elevation mesh surface.
      const mat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.90,
        depthTest: false,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geom, mat);
      lines.renderOrder = 5;
      contourGroup.add(lines);

      if (labelPos && li % labelEvery === 0) {
        const sprite = _makeElevLabel(THREE, `${zLevelDisp.toFixed(2)} m`, color);
        const sy = LABEL_BASE_SCALE_Y * Math.max(0.1, labelScale);
        sprite.scale.set(sy * LABEL_ASPECT, sy, 1);
        sprite.position.set(labelPos[0], labelPos[1], labelPos[2]);
        sprite.renderOrder = 6;
        contourGroup.add(sprite);
      }
    }

    if (!contourGroup.children.length) {
      toast(tx('No contour lines generated — check grid data'), 'err', 2500);
      return null;
    }

    // Clip contour lines to the same polygon boundary as the mesh.
    if (contourPolygon?.length >= 3) {
      const worldPolygon = contourPolygon.map(point => localPointToWorld(THREE, point, attachObject));
      const planes = createPolygonClippingPlanes(THREE, worldPolygon);
      if (planes.length >= 3) {
        if (viewer?.renderer) viewer.renderer.localClippingEnabled = true;
        contourGroup.traverse(child => {
          if (child.isMesh || child.isLine) {
            child.material.clippingPlanes = planes;
            child.material.clipIntersection = false;
          }
        });
      }
    }

    refreshSceneTree?.();
    toast(`${tx('Contour lines generated')}: ${levels.length} ${tx('levels')} @ ${interval.toFixed(3)} m`, 'ok', 3000);
    return contourGroup;
  }

  // ─── OBJ export for volume surface ────────────────────────────────────────

  function exportVolumeSurfaceMesh(jobId, fmt = 'obj', surfaceRole = 'analysis') {
    if (!jobId) return;
    const isUnifiedVolumeJob = String(jobId).startsWith('vol_');
    const normalizedRole = surfaceRole === 'base' ? 'base' : 'analysis';
    const artifact = normalizedRole === 'base' ? 'base-obj' : 'analysis-obj';
    const url = isUnifiedVolumeJob
      ? `/api/download-volume-job?jobId=${encodeURIComponent(jobId)}&artifact=${encodeURIComponent(artifact)}`
      : `/api/download-volume-surface?jobId=${encodeURIComponent(jobId)}&fmt=${encodeURIComponent(fmt)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = isUnifiedVolumeJob
      ? `volume_${normalizedRole}_surface_${jobId}.${fmt}`
      : `volume_surface_${jobId}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    toast(tx('Surface mesh download started'), 'ok', 2200);
  }

  function removeSurfaceFrom3D({ silent = false, kind = 'terrain', ownerRegionId = null, surfaceRole = 'analysis' } = {}) {
    if (!viewer) return;
    const layerNames = getSurfaceLayerNames(kind, ownerRegionId, surfaceRole);
    const oldNodes = layerNames.flatMap(name => findSceneNodesByName(name));
    if (!oldNodes.length) return;
    oldNodes.forEach(oldNode => {
      oldNode.parent?.remove(oldNode);
      disposeSceneNode(oldNode);
    });
    if (kind === 'terrain') {
      window.__cloudStudioActiveSurfaceGrid = null;
      window.__cloudStudioActiveSurfaceMeta = null;
    }
    refreshSceneTree?.();
    if (!silent) toast(tx('Surface mesh removed from the 3D viewer'), 'info', 2400);
  }

  async function autoDetectLas() {
    const input = document.getElementById('inp-las-path');
    const status = document.getElementById('dtm-las-status');
    if (!input || !status) return;

    status.textContent = tx('Searching for LAS/LAZ files...');
    try {
      let url = '/api/find-las';
      const projectId = getCurrentScannerProjectId?.();
      const activeDatasetContext = getActiveDatasetContext?.();
      if (projectId) url += `?projectId=${encodeURIComponent(projectId)}`;
      else if (activeDatasetContext?.cloudName) url += `?cloudName=${encodeURIComponent(activeDatasetContext.cloudName)}`;

      const data = await fetchImpl(url).then(r => r.json());
      if (data.ok && data.lasPath) {
        input.value = data.lasPath;
        status.textContent = `${tx('Ready')}: ${data.name || data.lasPath.split('/').pop()}`;
        status.style.color = 'var(--success)';
      } else if (data.ok && Array.isArray(data.lasFiles) && data.lasFiles.length > 0) {
        input.value = data.lasFiles[0];
        const select = document.getElementById('sel-las-pick');
        if (select && data.lasFiles.length > 1) {
          select.innerHTML = data.lasFiles.map(file => `<option value="${file}">${file.split('/').pop()}</option>`).join('');
          select.style.display = '';
        }
        status.textContent = `${tx('Found')} ${data.lasFiles.length} ${tx('LAS/LAZ files')}`;
        status.style.color = 'var(--success)';
      } else {
        status.textContent = tx('No LAS/LAZ file found. Enter a path manually.');
        status.style.color = 'var(--warning)';
      }
    } catch (error) {
      status.style.color = 'var(--error)';
      status.textContent = tx('Auto-detect failed:') + ' ' + error.message;
    }
  }

  async function generateDtm() {
    const button = document.getElementById('btn-gen-dtm');
    const progress = document.getElementById('dtm-progress');
    const preview = document.getElementById('dtm-preview');
    const downloadButton = document.getElementById('btn-dl-dtm');
    const dtmType = document.getElementById('sel-dtm-type')?.value;
    const resolution = parseFloat(document.getElementById('sel-dtm-res')?.value);
    const lasPath = document.getElementById('inp-las-path')?.value.trim();
    const status = document.getElementById('dtm-las-status');

    if (!lasPath) {
      terrainToast('Select a LAS/LAZ file first, either by auto-detect or manual path.', 'error', 5000);
      if (status) {
        status.style.color = 'var(--error)';
        status.textContent = tx('Path is required.');
      }
      return;
    }

    button.disabled = true;
    downloadButton.style.display = 'none';
    preview.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = tx('Building elevation model. Large files may take a few minutes...');
    updateTerrainStats?.(tx('Elevation model is being generated...'));

    try {
      const response = await fetchImpl('/api/generate-dtm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lasPath, dtmType, resolution }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || response.statusText);

      dtmState.lastJobId = data.jobId;
      const previewUrl = data.previewUrl + '?t=' + Date.now();
      preview.src = previewUrl;
      preview.style.display = 'none';
      showImageInViewer?.(previewUrl);
      downloadButton.style.display = '';

      document.getElementById('btn-dtm-next')?.style.setProperty('display', '');
      document.querySelector('[data-terrain-tab="dtm"]')?.classList.add('done');

      const stats = data.stats;
      const statText = [
        tx('Done'),
        `Extent: ${stats.width.toFixed(1)} x ${stats.height.toFixed(1)} m`,
        `Z: ${stats.zMin.toFixed(2)} ~ ${stats.zMax.toFixed(2)} m`,
        `Grid: ${stats.cols} x ${stats.rows}`,
        `Coverage: ${stats.coverage.toFixed(1)}%`,
      ].join(' | ');
      progress.textContent = statText;
      updateTerrainStats?.(statText);
      toast(tx('Elevation model generated successfully'), 'ok', 3000);
    } catch (error) {
      progress.textContent = tx('Generation failed') + ': ' + error.message;
      updateTerrainStats?.(tx('Elevation model generation failed'));
      toast(tx('Elevation model generation failed') + ': ' + error.message, 'error', 5000);
    } finally {
      button.disabled = false;
    }
  }

  async function generateSurfaceMesh() {
    const button = document.getElementById('btn-gen-surface');
    const progress = document.getElementById('surface-progress');
    const preview = document.getElementById('surface-preview');
    const downloadObj = document.getElementById('btn-dl-surface-obj');
    const downloadJson = document.getElementById('btn-dl-surface-json');
    const show3d = document.getElementById('btn-surface-3d');
    const contourNext = document.getElementById('btn-surface-next');
    const lasPath = document.getElementById('inp-las-path')?.value.trim();
    const surfaceType = document.getElementById('sel-dtm-type')?.value || 'dsm';
    const resolution = parseFloat(document.getElementById('sel-dtm-res')?.value || '0.5');
    const holeMode = document.getElementById('sel-surface-hole-mode')?.value || 'interpolate';
    const fixedHeightRaw = document.getElementById('inp-surface-fixed-height')?.value;
    const fixedHeight = holeMode === 'fixed' ? parseFloat(fixedHeightRaw) : null;

    if (!lasPath) {
      terrainToast('Select a LAS/LAZ file first, either by auto-detect or manual path.', 'error', 5000);
      return;
    }

    button.disabled = true;
    if (downloadObj) downloadObj.style.display = 'none';
    if (downloadJson) downloadJson.style.display = 'none';
    if (show3d) show3d.style.display = 'none';
    if (contourNext) contourNext.style.display = 'none';
    if (preview) preview.style.display = 'none';
    if (progress) {
      progress.style.display = 'block';
      progress.textContent = tx('Building surface mesh. Large files may take a few minutes...');
    }
    updateTerrainStats?.(tx('Surface mesh is being generated...'));

    try {
      const response = await fetchImpl('/api/generate-surface', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lasPath, surfaceType, resolution, holeMode, fixedHeight }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || response.statusText);

      surfaceState.lastJobId = data.jobId;
      surfaceState.lastGrid = null;
      surfaceState.lastMeta = null;

      const previewUrl = `${data.previewUrl}?t=${Date.now()}`;
      if (preview) {
        preview.src = previewUrl;
        preview.style.display = 'none';
      }
      showImageInViewer?.(previewUrl);

      const stats = data.stats || {};
      const summary = [
        tx('Done'),
        `${tx('Vertices')}: ${(stats.vertexCount || 0).toLocaleString()}`,
        `${tx('Triangles')}: ${(stats.faceCount || 0).toLocaleString()}`,
        `${tx('Filled cells')}: ${(stats.filledCellCount || 0).toLocaleString()}`,
        `${tx('Downsample')}: x${stats.downsampleFactor || 1}`,
      ].join(' | ');
      if (progress) progress.textContent = summary;
      updateTerrainStats?.(summary);

      if (downloadObj) downloadObj.style.display = '';
      if (downloadJson) downloadJson.style.display = '';
      if (show3d) show3d.style.display = '';
      if (contourNext) contourNext.style.display = '';

      await loadSurfaceTo3D({ silent: true });
      toast(tx('Surface mesh generated successfully'), 'ok', 3000);
    } catch (error) {
      if (progress) progress.textContent = tx('Generation failed') + ': ' + error.message;
      updateTerrainStats?.(tx('Surface mesh generation failed'));
      toast(tx('Surface mesh generation failed') + ': ' + error.message, 'error', 5000);
    } finally {
      button.disabled = false;
    }
  }

  function downloadSurfaceFile(fmt = 'obj') {
    if (!surfaceState.lastJobId) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/download-surface?jobId=${surfaceState.lastJobId}&fmt=${fmt}`;
    anchor.download = fmt === 'obj'
      ? `surface_${surfaceState.lastJobId}.obj`
      : `surface_${surfaceState.lastJobId}_${fmt}.json`;
    anchor.click();
  }

  async function loadSurfaceMeshDataTo3D(meshSource, {
    silent = false,
    kind = 'terrain',
    attachPointcloudUuid = null,
    ownerRegionId = null,
    surfaceRole = 'analysis',
    displayName = '',
    replaceExisting = true,
  } = {}) {
    if (!meshSource || !viewer) return null;
    const payload = normalizeSurfaceMeshPayload(meshSource);
    if (!payload?.meshData) throw new Error(tx('Surface mesh data is invalid'));

    const mergedMeta = {
      ...(payload.meshData.meta || {}),
      ...(meshSource?.meta || {}),
      ...(payload.jobId ? { sourceJobId: payload.jobId } : {}),
    };
    const meshData = {
      ...payload.meshData,
      meta: mergedMeta,
    };
    const gridData = payload.gridData || null;
    const resolvedDisplayName = displayName || mergedMeta.displayName || '';

    if (kind === 'terrain') {
      surfaceState.lastGrid = gridData;
      surfaceState.lastMeta = mergedMeta;
      surfaceState.lastJobId = payload.jobId || surfaceState.lastJobId;
      window.__cloudStudioActiveSurfaceGrid = gridData;
      window.__cloudStudioActiveSurfaceMeta = mergedMeta;
    }

    if (replaceExisting && kind !== 'obj') {
      removeSurfaceFrom3D({ silent: true, kind, ownerRegionId, surfaceRole });
    }

    const mesh = createMeshLayerFromData(meshData, {
      kind,
      attachPointcloudUuid,
      ownerRegionId,
      displayName: resolvedDisplayName,
      surfaceRole,
    });
    refreshSceneTree?.();
    if (!silent) toast(tx('Surface mesh loaded into the 3D viewer'), 'ok', 3000);
    return { layer: mesh, grid: gridData, meta: mergedMeta };
  }

  async function loadSurfaceJobTo3D(jobSource, {
    silent = false,
    kind = 'terrain',
    attachPointcloudUuid = null,
    ownerRegionId = null,
    surfaceRole = 'analysis',
    displayName = '',
  } = {}) {
    if (!jobSource || !viewer) return;
    const directPayload = normalizeSurfaceMeshPayload(jobSource);
    if (directPayload) {
      const directResult = await loadSurfaceMeshDataTo3D({
        ...jobSource,
        ...directPayload,
      }, {
        silent,
        kind,
        attachPointcloudUuid,
        ownerRegionId,
        surfaceRole,
        displayName,
      });
      if (kind === 'terrain') closeTerrainModal();
      return directResult;
    }

    const jobId = typeof jobSource === 'object'
      ? (jobSource.jobId || jobSource.id || null)
      : jobSource;
    if (!jobId) throw new Error(tx('Surface job id is missing'));

    try {
      const isUnifiedVolumeJob = kind === 'volume' && String(jobId).startsWith('vol_');
      const meshUrl = kind === 'volume'
        ? (isUnifiedVolumeJob
          ? `/api/volume-mesh?jobId=${jobId}&surface=${surfaceRole === 'base' ? 'base' : 'analysis'}`
          : `/api/volume-surface-mesh?jobId=${jobId}`)
        : `/api/surface-mesh?jobId=${jobId}`;
      const gridUrl = kind === 'volume'
        ? (isUnifiedVolumeJob
          ? `/api/volume-grid?jobId=${jobId}&surface=${surfaceRole === 'base' ? 'base' : 'analysis'}`
          : `/api/volume-surface-grid?jobId=${jobId}`)
        : `/api/surface-grid?jobId=${jobId}`;
      const meshResponse = await fetchImpl(meshUrl);
      if (!meshResponse.ok) throw new Error(tx('Failed to fetch surface mesh'));
      const meshData = await meshResponse.json();

      const gridResponse = await fetchImpl(gridUrl);
      if (!gridResponse.ok) throw new Error(tx('Failed to fetch surface grid'));
      const gridData = await gridResponse.json();
      const result = await loadSurfaceMeshDataTo3D({
        jobId,
        gridData,
        meshData: {
          ...meshData,
          meta: { ...(meshData.meta || {}), sourceJobId: jobId },
        },
      }, {
        silent,
        kind,
        attachPointcloudUuid,
        ownerRegionId,
        surfaceRole,
        displayName,
      });
      if (kind === 'terrain') closeTerrainModal();
      return result;
    } catch (error) {
      toast(tx('Failed to load the surface mesh into the 3D viewer') + ': ' + error.message, 'error', 5000);
      throw error;
    }
  }

  async function loadSurfaceTo3D({ silent = false } = {}) {
    if (!surfaceState.lastJobId || !viewer) return;
    return loadSurfaceJobTo3D(surfaceState.lastJobId, { silent });
  }

  async function loadObjMeshFromPath(meshPath, { displayName = '' } = {}) {
    if (!meshPath || !viewer) return null;
    const response = await fetchImpl(`/api/mesh-file?path=${encodeURIComponent(meshPath)}`);
    const data = await response.json();
    if (!response.ok || data.error || !data.ok) {
      throw new Error(data?.error || response.statusText || 'Failed to load OBJ mesh');
    }
    const result = await loadSurfaceMeshDataTo3D({
      meta: data.meta || {},
      vertices: data.vertices || [],
      colors: data.colors || [],
      faces: data.faces || [],
    }, {
      kind: 'obj',
      displayName: displayName || data.meta?.displayName || '',
      silent: true,
      replaceExisting: false,
    });
    toast(tx('OBJ mesh loaded into the 3D viewer'), 'ok', 2600);
    return result;
  }

  function downloadDtm() {
    if (!dtmState.lastJobId) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/download-dtm?jobId=${dtmState.lastJobId}`;
    anchor.download = `dtm_${dtmState.lastJobId}.tif`;
    anchor.click();
  }

  function toggleDtmPanel() {
    openTerrainModal('dtm');
  }

  function toggleContourPanel() {
    openTerrainModal('contour');
  }

  async function generateContours() {
    const button = document.getElementById('btn-gen-contour');
    const progress = document.getElementById('contour-progress');
    const downloadGeoJson = document.getElementById('btn-dl-contour-geojson');
    const downloadDxf = document.getElementById('btn-dl-contour-dxf');
    const interval = parseFloat(document.getElementById('inp-contour-interval')?.value) || 1.0;
    const wantGeoJson = document.getElementById('chk-contour-geojson')?.checked;
    const wantDxf = document.getElementById('chk-contour-dxf')?.checked;

    const activeSurfaceJobId = surfaceState.lastJobId;
    const activeDtmJobId = dtmState.lastJobId;
    if (!activeSurfaceJobId && !activeDtmJobId) {
      toast(tx('Generate a surface mesh or elevation model first.'), 'error', 4000);
      return;
    }

    button.disabled = true;
    downloadGeoJson.style.display = 'none';
    downloadDxf.style.display = 'none';
    progress.style.display = 'block';
    progress.textContent = `${tx('Generating contours')} (${interval} m)...`;
    updateTerrainStats?.(activeSurfaceJobId ? tx('Contours are being generated from the latest surface mesh...') : tx('Contours are being generated...'));

    try {
      const response = await fetchImpl('/api/generate-contours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dtmJobId: activeSurfaceJobId ? null : activeDtmJobId,
          surfaceJobId: activeSurfaceJobId || null,
          interval,
          formats: { geojson: wantGeoJson, dxf: wantDxf },
        }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || response.statusText);

      contourState.lastJobId = data.jobId;
      const resultText = `${tx('Done')} | ${data.contourCount} ${tx('contour lines')} | ${tx('Z range')}: ${data.zMin.toFixed(2)} ~ ${data.zMax.toFixed(2)} m`;
      progress.textContent = resultText;
      updateTerrainStats?.(resultText);

      document.querySelector('[data-terrain-tab="contour"]')?.classList.add('done');
      if (wantGeoJson && data.hasGeoJSON) downloadGeoJson.style.display = '';
      if (wantDxf && data.hasDxf) downloadDxf.style.display = '';
      if (data.hasGeoJSON) document.getElementById('btn-contour-3d')?.style.setProperty('display', '');

      toast(tx('Contours generated successfully'), 'ok', 3000);
    } catch (error) {
      progress.textContent = tx('Generation failed') + ': ' + error.message;
      updateTerrainStats?.(tx('Contour generation failed'));
      toast(tx('Contour generation failed') + ': ' + error.message, 'error', 5000);
    } finally {
      button.disabled = false;
    }
  }

  function downloadContourFile(fmt) {
    if (!contourState.lastJobId) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/download-contours?jobId=${contourState.lastJobId}&fmt=${fmt}`;
    anchor.download = `contours_${contourState.lastJobId}.${fmt === 'geojson' ? 'geojson' : 'dxf'}`;
    anchor.click();
  }

  function toggleGcPanel() {
    openTerrainModal('gc');
    const dtmPath = document.getElementById('inp-las-path')?.value;
    const gcInput = document.getElementById('inp-gc-las');
    if (dtmPath && gcInput && !gcInput.value) gcInput.value = dtmPath;
    if (gcInput && !gcInput.value) autoDetectLasForGC();
  }

  async function autoDetectLasForGC() {
    const input = document.getElementById('inp-gc-las');
    const status = document.getElementById('gc-las-status');
    const dtmPath = document.getElementById('inp-las-path')?.value;
    if (!input || !status) return;

    if (dtmPath) {
      input.value = dtmPath;
      status.textContent = tx('Using the same LAS as the elevation-model step');
      return;
    }

    status.textContent = tx('Searching for LAS/LAZ files...');
    try {
      let url = '/api/find-las';
      const projectId = getCurrentScannerProjectId?.();
      const activeDatasetContext = getActiveDatasetContext?.();
      if (projectId) url += `?projectId=${encodeURIComponent(projectId)}`;
      else if (activeDatasetContext?.cloudName) url += `?cloudName=${encodeURIComponent(activeDatasetContext.cloudName)}`;

      const data = await fetchImpl(url).then(r => r.json());
      if (data.ok && data.lasPath) {
        input.value = data.lasPath;
        status.textContent = `${tx('Ready')}: ${data.name || data.lasPath.split('/').pop()}`;
        status.style.color = 'var(--success)';
      } else {
        status.textContent = tx('No LAS/LAZ file found. Pick a file manually.');
        status.style.color = 'var(--warning)';
        input.removeAttribute('readonly');
      }
    } catch (error) {
      status.textContent = tx('Auto-detect failed:') + ' ' + error.message;
    }
  }

  function autoFillSemanticInput() {
    const input = document.getElementById('inp-semantic-las');
    const status = document.getElementById('semantic-las-status');
    if (!input) return;
    const candidate = gcState.lastOutputPath || '';
    input.value = candidate;
    if (!status) return;
    if (candidate) {
      status.textContent = tx('Using latest ground-classified LAS');
      status.style.color = 'var(--success)';
    } else {
      status.textContent = tx('Run ground classification first, then semantic classification.');
      status.style.color = 'var(--warning)';
    }
  }

  function autoFillTreeInput() {
    const input = document.getElementById('inp-tree-las');
    const status = document.getElementById('tree-las-status');
    if (!input) return;
    const candidate = semanticState.lastOutputPath || '';
    input.value = candidate;
    if (!status) return;
    if (candidate) {
      status.textContent = tx('Using latest semantic LAS');
      status.style.color = 'var(--success)';
    } else {
      status.textContent = tx('Run semantic classification first, then tree segmentation.');
      status.style.color = 'var(--warning)';
    }
  }

  function formatSemanticSummary(stats = {}) {
    const classes = stats.semantic?.classes || {};
    return Object.entries(classes)
      .slice(0, 6)
      .map(([key, value]) => `${key}:${Number(value).toLocaleString()}`)
      .join(' | ');
  }

  async function runGroundClassification() {
    const lasPath = document.getElementById('inp-gc-las')?.value.trim();
    const clothResolution = parseFloat(document.getElementById('sel-gc-grid')?.value);
    const classThreshold = parseFloat(document.getElementById('sel-gc-threshold')?.value);
    const rigidness = 2;
    const iterations = 500;
    const slopeSmooth = true;
    const button = document.getElementById('btn-gc-run');
    const progressBar = document.getElementById('gc-progress-bar');
    const status = document.getElementById('gc-status');
    const resultBox = document.getElementById('gc-result-box');
    const useButton = document.getElementById('btn-gc-use');

    if (!lasPath) {
      window.alert(tx('Choose a LAS file first, or use auto-detect.'));
      return;
    }

    button.disabled = true;
    button.textContent = tx('Classifying...');
    progressBar.style.width = '15%';
    status.textContent = tx('Running CSF ground classification. Large files may take a few minutes...');
    resultBox.style.display = 'none';
    useButton.style.display = 'none';
    updateTerrainStats?.(tx('Ground classification is running...'));

    let pct = 15;
    const ticker = window.setInterval(() => {
      pct = Math.min(90, pct + (90 - pct) * 0.04);
      progressBar.style.width = pct + '%';
    }, 800);

    try {
      const response = await fetchImpl('/api/classify-ground', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lasPath,
          clothResolution,
          classThreshold,
          rigidness,
          iterations,
          slopeSmooth,
        }),
      });
      const data = await response.json();
      window.clearInterval(ticker);
      if (!data.ok) throw new Error(data.error || tx('Ground classification failed'));

      progressBar.style.width = '100%';
      window.setTimeout(() => {
        progressBar.style.width = '0';
      }, 800);

      gcState.lastOutputPath = data.outputPath;

      const pctLabel = data.groundPct != null ? ` | Ground: ${data.groundPct}%` : '';
      const countLabel = data.nGround != null ? ` (${data.nGround.toLocaleString()} pts)` : '';
      resultBox.innerHTML =
        `${tx('Ground classification complete')}${countLabel}${pctLabel}<br>` +
        `${tx('Output')}: <code style="font-size:10px;word-break:break-all">${data.outputPath}</code>`;
      resultBox.style.display = '';
      status.textContent = '';
      useButton.style.display = '';
      document.getElementById('btn-gc-import')?.style.setProperty('display', '');
      document.querySelector('[data-terrain-tab="gc"]')?.classList.add('done');

      updateTerrainStats?.(`${tx('Ground classification complete')}${countLabel}${pctLabel}`);
      toast(tx('Ground classification complete. You can continue to the elevation-model step.'), 'ok', 5000);
    } catch (error) {
      window.clearInterval(ticker);
      progressBar.style.width = '0';
      status.textContent = tx('Failed') + ': ' + error.message;
      status.style.color = 'var(--error)';
      updateTerrainStats?.(tx('Ground classification failed'));
      toast(tx('Ground classification failed') + ': ' + error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = tx('Run Ground Classification');
    }
  }

  function useClassifiedLasForDtm() {
    if (!gcState.lastOutputPath) return;
    const dtmInput = document.getElementById('inp-las-path');
    const dtmSelect = document.getElementById('sel-las-pick');
    const dtmStatus = document.getElementById('dtm-las-status');
    if (dtmInput) {
      dtmInput.value = gcState.lastOutputPath;
      if (dtmSelect) dtmSelect.style.display = 'none';
      if (dtmStatus) {
        dtmStatus.style.color = 'var(--success)';
        dtmStatus.textContent = tx('Switched to the latest classified LAS file');
      }
    }
    switchTerrainTab('dtm');
    toast(tx('The classified LAS has been sent to the elevation-model step.'), 'ok', 4000);
  }

  async function loadContoursTo3D() {
    if (!contourState.lastJobId || !viewer) return;
    const THREE = getThree();
    if (!THREE) throw new Error('THREE runtime is unavailable');
    try {
      const response = await fetchImpl(`/api/download-contours?jobId=${contourState.lastJobId}&fmt=geojson`);
      if (!response.ok) throw new Error(tx('Failed to fetch GeoJSON'));
      const geojson = await response.json();

      const oldNode = viewer.scene.scene.getObjectByName('contour_layer');
      if (oldNode) {
        viewer.scene.scene.remove(oldNode);
        oldNode.traverse(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
      }

      const contourNode = new THREE.Object3D();
      contourNode.name = 'contour_layer';
      const material = new THREE.LineBasicMaterial({ color: 0x19be6b, linewidth: 1 });

      geojson.features.forEach(feature => {
        if (feature.geometry.type !== 'LineString') return;
        const points = feature.geometry.coordinates.map(coord => new THREE.Vector3(coord[0], coord[1], coord[2] || 0));
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);
        line.position.z += 0.05;
        contourNode.add(line);
      });

      viewer.scene.scene.add(contourNode);
      refreshSceneTree?.();
      toast(tx('Contours were loaded into the 3D viewer'), 'ok', 3000);
      closeTerrainModal();
    } catch (error) {
      toast(tx('Failed to load contours into the 3D viewer') + ': ' + error.message, 'error', 5000);
    }
  }

  async function importProcessedLasToViewer({
    outputPath,
    buttonId,
    defaultNamePrefix,
    successStatus,
  }) {
    if (!outputPath) {
      toast(tx('No processed file yet'), 'error');
      return;
    }

    const button = document.getElementById(buttonId);
    const originalText = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = translateText('Importing processed data...');
    }
    updateTerrainStats?.(translateText('Importing processed point cloud...'));

    try {
      const response = await fetchImpl('/api/upload-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: outputPath,
          name: `${defaultNamePrefix}_${outputPath.split('/').pop().replace(/\.(las|laz)$/i, '')}`,
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || tx('Upload failed'));

      closeTerrainModal();
      loadCloud?.(`/pointclouds/${data.cloudName}/metadata.json`, { type: 'cloud', cloudName: data.cloudName });
      window.setTimeout(() => {
        activateClassificationView?.();
      }, 2000);
      updateTerrainStats?.(successStatus);
    } catch (error) {
      toast(translateText('Import failed: ') + error.message, 'error', 5000);
      updateTerrainStats?.(translateText('Import failed'));
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function importClassifiedLasToViewer() {
    if (!gcState.lastOutputPath) {
      toast(tx('No classified file yet'), 'error');
      return;
    }

    const button = document.getElementById('btn-gc-import');
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = tx('Importing classified cloud...');
    updateTerrainStats?.(tx('Importing classified point cloud...'));

    try {
      const response = await fetchImpl('/api/upload-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: gcState.lastOutputPath,
          name: 'classified_' + gcState.lastOutputPath.split('/').pop().replace(/\.(las|laz)$/i, ''),
        }),
      });
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || tx('Upload failed'));

      closeTerrainModal();
      loadCloud?.(`/pointclouds/${data.cloudName}/metadata.json`, { type: 'cloud', cloudName: data.cloudName });

      window.setTimeout(() => {
        activateClassificationView?.();
      }, 2000);

      updateTerrainStats?.(tx('Imported classified point cloud'));
    } catch (error) {
      toast(tx('Import failed') + ': ' + error.message, 'error', 5000);
      updateTerrainStats?.(tx('Import failed'));
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function toggleSemanticPanel() {
    openTerrainModal('semantic');
  }

  async function runSemanticClassification() {
    const lasPath = document.getElementById('inp-semantic-las')?.value.trim();
    const presetKey = getSelectedPresetKey('sel-semantic-preset');
    const hagNeighborCount = parseInt(document.getElementById('sel-semantic-hag-neighbors')?.value || '8', 10);
    const geometryNeighborCount = parseInt(document.getElementById('sel-semantic-geom-neighbors')?.value || '16', 10);
    const button = document.getElementById('btn-semantic-run');
    const progressBar = document.getElementById('semantic-progress-bar');
    const status = document.getElementById('semantic-status');
    const resultBox = document.getElementById('semantic-result-box');
    const useButton = document.getElementById('btn-semantic-use');

    if (!lasPath) {
      autoFillSemanticInput();
      window.alert(tx('Run ground classification first so semantic classification receives a classified LAS/LAZ file.'));
      return;
    }

    button.disabled = true;
    if (progressBar) progressBar.style.width = '8%';
    status.textContent = `${tx('Queued semantic pipeline')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`;
    status.style.color = 'var(--text2)';
    resultBox.style.display = 'none';
    useButton.style.display = 'none';
    document.getElementById('btn-semantic-import')?.style.setProperty('display', 'none');
    updateTerrainStats?.(`${tx('Semantic pipeline running')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`);

    try {
      const response = await fetchImpl('/api/run-semantic-pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lasPath,
          groundClass: 2,
          hagNeighborCount,
          geometryNeighborCount,
          async: true,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);

      const jobId = data.jobId;
      if (!jobId) throw new Error(tx('Missing semantic job id'));
      status.textContent = `${tx('Semantic pipeline started')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`;
      if (progressBar) progressBar.style.width = '10%';

      let jobResult = null;
      while (true) {
        await new Promise(resolve => window.setTimeout(resolve, 1200));
        const pollResponse = await fetchImpl(`/api/terrain-jobs/${encodeURIComponent(jobId)}`);
        const pollData = await pollResponse.json();
        if (!pollResponse.ok || !pollData.ok) {
          throw new Error(pollData.error || pollResponse.statusText || tx('Failed to fetch semantic job progress'));
        }
        const job = pollData.job || {};
        const progress = Number(job.progress || 0);
        if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
        status.textContent = job.message || `${tx('Semantic pipeline running')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`;
        updateTerrainStats?.(job.message || `${tx('Semantic pipeline running')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`);

        if (job.status === 'completed') {
          jobResult = job.result || null;
          break;
        }
        if (job.status === 'failed') {
          throw new Error(job.error || job.message || tx('Semantic pipeline failed'));
        }
      }

      if (!jobResult?.outputPath) throw new Error(tx('Semantic pipeline completed without output'));
      semanticState.lastOutputPath = jobResult.outputPath;
      semanticState.lastIntermediates = jobResult.intermediates || null;
      autoFillTreeInput();

      const summary = formatSemanticSummary(jobResult.stats || {});
      resultBox.innerHTML =
        `${tx('Semantic classification complete')} (${tx(TERRAIN_PRESETS[presetKey].label)})<br>` +
        `<code style="font-size:10px;word-break:break-all">${jobResult.outputPath}</code><br>` +
        `<span style="font-size:11px;color:var(--text2)">${summary}</span>`;
      resultBox.style.display = '';
      status.textContent = tx('Semantic pipeline finished');
      if (progressBar) {
        progressBar.style.width = '100%';
        window.setTimeout(() => {
          progressBar.style.width = '0';
        }, 1200);
      }
      useButton.style.display = '';
      document.getElementById('btn-semantic-import')?.style.setProperty('display', '');
      document.querySelector('[data-terrain-tab="semantic"]')?.classList.add('done');
      updateTerrainStats?.(summary || `${tx('Semantic classification complete')} (${tx(TERRAIN_PRESETS[presetKey].label)})`);
      toast(`${tx('Semantic classification ready')} (${tx(TERRAIN_PRESETS[presetKey].label)})`, 'ok', 4000);
    } catch (error) {
      if (progressBar) progressBar.style.width = '0';
      status.textContent = tx('Semantic classification failed') + ': ' + error.message;
      status.style.color = 'var(--error)';
      terrainStats(tx('Semantic classification failed'));
      terrainToast(tx('Semantic classification failed') + ': ' + error.message, 'error', 5000);
    } finally {
      button.disabled = false;
    }
  }

  function useSemanticLasForTrees() {
    if (!semanticState.lastOutputPath) return;
    const treeInput = document.getElementById('inp-tree-las');
    const treeStatus = document.getElementById('tree-las-status');
    if (treeInput) treeInput.value = semanticState.lastOutputPath;
    if (treeStatus) {
      treeStatus.style.color = 'var(--success)';
      treeStatus.textContent = tx('Semantic LAS is ready for tree segmentation');
    }
    switchTerrainTab('trees');
    toast(tx('Semantic LAS sent to the tree-segmentation step'), 'ok', 3000);
  }

  async function importSemanticLasToViewer() {
    await importProcessedLasToViewer({
      outputPath: semanticState.lastOutputPath,
      buttonId: 'btn-semantic-import',
      defaultNamePrefix: 'semantic',
      successStatus: 'Imported semantic point cloud',
    });
  }

  function toggleTreePanel() {
    openTerrainModal('trees');
  }

  async function runTreeSegmentation() {
    const lasPath = document.getElementById('inp-tree-las')?.value.trim();
    const presetKey = getSelectedPresetKey('sel-tree-preset');
    const seedMinHeight = parseFloat(document.getElementById('inp-tree-seed-min')?.value || '1.2');
    const seedMaxHeight = parseFloat(document.getElementById('inp-tree-seed-max')?.value || '3.0');
    const clusterRadius = parseFloat(document.getElementById('inp-tree-cluster-radius')?.value || '0.6');
    const maxCrownRadius = parseFloat(document.getElementById('inp-tree-crown-radius')?.value || '4.0');
    const chmResolution = parseFloat(document.getElementById('inp-tree-chm-res')?.value || '0.75');
    const button = document.getElementById('btn-tree-run');
    const status = document.getElementById('tree-status');
    const resultBox = document.getElementById('tree-result-box');

    if (!lasPath) {
      autoFillTreeInput();
      window.alert(tx('Run semantic classification first so tree segmentation receives a semantic LAS/LAZ file.'));
      return;
    }

    button.disabled = true;
    status.textContent = `${tx('Running tree segmentation')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`;
    status.style.color = 'var(--text2)';
    resultBox.style.display = 'none';
    updateTerrainStats?.(`${tx('Tree segmentation running')} (${tx(TERRAIN_PRESETS[presetKey].label)})...`);

    try {
      const response = await fetchImpl('/api/segment-individual-trees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lasPath,
          seedMinHeight,
          seedMaxHeight,
          clusterRadius,
          maxCrownRadius,
          chmResolution,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);

      treeState.lastOutputPath = data.outputPath;
      const stats = data.stats || {};
      resultBox.innerHTML =
        `${tx('Tree segmentation complete')} (${tx(TERRAIN_PRESETS[presetKey].label)})<br>` +
        `<code style="font-size:10px;word-break:break-all">${data.outputPath}</code><br>` +
        `<span style="font-size:11px;color:var(--text2)">${tx('Seeds')}: ${(stats.seedCount || 0).toLocaleString()} | ${tx('Trees')}: ${(stats.treeCount || 0).toLocaleString()} | ${tx('Assigned points')}: ${(stats.assignedPointCount || 0).toLocaleString()}</span>`;
      resultBox.style.display = '';
      status.textContent = tx('Tree segmentation finished');
      document.getElementById('btn-tree-import')?.style.setProperty('display', '');
      document.querySelector('[data-terrain-tab="trees"]')?.classList.add('done');
      updateTerrainStats?.(`${tx('Seeds')}: ${(stats.seedCount || 0).toLocaleString()} | ${tx('Trees')}: ${(stats.treeCount || 0).toLocaleString()} | ${tx('Assigned points')}: ${(stats.assignedPointCount || 0).toLocaleString()}`);
      toast(`${tx('Tree segmentation ready')} (${tx(TERRAIN_PRESETS[presetKey].label)})`, 'ok', 4000);
    } catch (error) {
      status.textContent = tx('Tree segmentation failed') + ': ' + error.message;
      status.style.color = 'var(--error)';
      terrainStats(tx('Tree segmentation failed'));
      terrainToast(tx('Tree segmentation failed') + ': ' + error.message, 'error', 5000);
    } finally {
      button.disabled = false;
    }
  }

  async function importTreeLasToViewer() {
    await importProcessedLasToViewer({
      outputPath: treeState.lastOutputPath,
      buttonId: 'btn-tree-import',
      defaultNamePrefix: 'trees',
      successStatus: 'Imported tree segmentation point cloud',
    });
  }

  return {
    applySemanticPreset,
    applyTreePreset,
    autoDetectLas,
    autoDetectLasForGC,
    closeTerrainModal,
    downloadContourFile,
    downloadDtm,
    downloadSurfaceFile,
    generateSurfaceMesh,
    generateContours,
    generateDtm,
    importClassifiedLasToViewer,
    importSemanticLasToViewer,
    importTreeLasToViewer,
    loadContoursTo3D,
    loadObjMeshFromPath,
    loadSurfaceJobTo3D,
    loadSurfaceMeshDataTo3D,
    loadSurfaceTo3D,
    openTerrainModal,
    removeSurfaceFrom3D,
    runGroundClassification,
    runSemanticClassification,
    runTreeSegmentation,
    switchTerrainTab,
    toggleContourPanel,
    toggleDtmPanel,
    toggleSurfaceFixedHeightRow,
    toggleGcPanel,
    toggleSemanticPanel,
    exportContoursAsDXF,
    exportVolumeSurfaceMesh,
    generateContoursFromGrid,
    removeContoursFrom3D,
    toggleContourLabels,
    resizeContourLabels,
    toggleSurfaceEdgesVisibility,
    toggleTreePanel,
    useClassifiedLasForDtm,
    useSemanticLasForTrees,
  };
}
