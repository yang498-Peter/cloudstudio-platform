export function createMinimapFeature({
  getScannerState,
  getSelectedProjectId,
  getLoadedScannerProjects,
  ecefToWGS84,
  localToECEF,
} = {}) {
  let controlsBound = false;
  let lastWheelAt = 0;
  const state = {
    collapsed: false,
    canvas: null,
    ctx: null,
    wgsPoints: [],
    tracks: [],
    originLat: null,
    originLon: null,
    tileCache: new Map(),
    tileErrors: new Set(),
    basemapMode: 'street',
    providerLabel: 'OpenStreetMap',
    attributionLabel: '© OpenStreetMap contributors',
    currentZoom: null,
    centerLat: null,
    centerLon: null,
    manualView: false,
    expanded: false,
    dragActive: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartCenterX: 0,
    dragStartCenterY: 0,
  };

  function updateProviderMeta() {
    if (state.basemapMode === 'satellite') {
      state.providerLabel = 'Esri World Imagery';
      state.attributionLabel = 'Tiles © Esri';
    } else {
      state.providerLabel = 'OpenStreetMap';
      state.attributionLabel = '© OpenStreetMap contributors';
    }
  }

  function renderInfo() {
    const info = document.getElementById('minimap-info');
    if (!info || state.originLat === null || state.originLon === null) return;
    const projectCount = getLoadedScannerProjects().filter(project => project.geoInfo).length;
    info.innerHTML = `📍 ${state.originLat.toFixed(6)}, ${state.originLon.toFixed(6)} (WGS84)<br>🗺 ${state.providerLabel}${projectCount > 1 ? `<br>📡 ${projectCount} projects` : ''}`;
  }

  function bindControls() {
    if (controlsBound) return;
    controlsBound = true;

    document.getElementById('minimap-header')?.addEventListener('click', togglePanel);
    document.getElementById('btn-minimap-basemap')?.addEventListener('click', event => {
      event.stopPropagation();
      toggleBasemap();
    });
    document.getElementById('btn-minimap-reset')?.addEventListener('click', event => {
      event.stopPropagation();
      resetView();
    });
    document.getElementById('btn-minimap-expand')?.addEventListener('click', event => {
      event.stopPropagation();
      toggleExpanded();
    });
  }

  function togglePanel() {
    state.collapsed = !state.collapsed;
    document.getElementById('minimap-body').style.display = state.collapsed ? 'none' : '';
    document.getElementById('minimap-toggle-arrow').textContent = state.collapsed ? '▸' : '▾';
  }

  function toggleExpanded() {
    state.expanded = !state.expanded;
    const panel = document.getElementById('minimap-panel');
    panel.classList.toggle('expanded', state.expanded);
    const button = document.querySelector('#minimap-controls .minimap-icon-btn:nth-child(3)');
    if (button) button.textContent = state.expanded ? '🗗' : '⛶';
    resizeCanvas();
    draw();
  }

  function toggleBasemap() {
    state.basemapMode = state.basemapMode === 'street' ? 'satellite' : 'street';
    state.tileCache.clear();
    state.tileErrors.clear();
    updateProviderMeta();
    renderInfo();
    draw();
  }

  function resetView() {
    state.manualView = false;
    state.currentZoom = null;
    state.centerLat = null;
    state.centerLon = null;
    resizeCanvas();
    draw();
  }

  function initCanvas() {
    const container = document.getElementById('minimap-container');
    if (state.canvas) return state.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = 244;
    canvas.height = 220;
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    container.appendChild(canvas);
    state.canvas = canvas;
    state.ctx = canvas.getContext('2d');
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('dblclick', event => {
      event.preventDefault();
      resetView();
    });
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    resizeCanvas();
    return canvas;
  }

  function resizeCanvas() {
    const canvas = state.canvas;
    const container = document.getElementById('minimap-container');
    if (!canvas || !container) return;
    const rect = container.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(244, Math.round(rect.width || 244));
    const height = Math.max(220, Math.round(rect.height || 220));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.scale(dpr, dpr);
  }

  function lonLatToTilePixel(lon, lat, zoom) {
    const latClamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sinLat = Math.sin(latClamped * Math.PI / 180);
    const scale = 256 * Math.pow(2, zoom);
    return {
      x: ((lon + 180) / 360) * scale,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
    };
  }

  function chooseZoom(points, width, height) {
    if (!points.length) return 17;
    const lats = points.map(p => p.lat);
    const lons = points.map(p => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    if ((maxLat - minLat) < 1e-6 && (maxLon - minLon) < 1e-6) return 18;
    for (let zoom = 19; zoom >= 1; zoom--) {
      const nw = lonLatToTilePixel(minLon, maxLat, zoom);
      const se = lonLatToTilePixel(maxLon, minLat, zoom);
      const spanX = Math.abs(se.x - nw.x);
      const spanY = Math.abs(se.y - nw.y);
      if (spanX <= width * 0.74 && spanY <= height * 0.74) return zoom;
    }
    return 1;
  }

  function getTileUrl(z, x, y) {
    if (state.basemapMode === 'satellite') {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    }
    return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  }

  function ensureTile(z, x, y) {
    const maxIndex = Math.pow(2, z);
    const tileX = ((x % maxIndex) + maxIndex) % maxIndex;
    if (y < 0 || y >= maxIndex) return null;
    const key = `${state.basemapMode}:${z}/${tileX}/${y}`;
    const cached = state.tileCache.get(key);
    if (cached) return cached;
    if (state.tileErrors.has(key)) return null;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => draw();
    img.onerror = () => {
      state.tileErrors.add(key);
      state.tileCache.delete(key);
      draw();
    };
    img.src = getTileUrl(z, tileX, y);
    state.tileCache.set(key, img);
    return img;
  }

  function drawFallbackBackground(ctx, width, height) {
    ctx.fillStyle = '#f2f4f7';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(60,64,67,0.08)';
    ctx.lineWidth = 0.5;
    for (let y = 0; y <= height; y += 24) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    for (let x = 0; x <= width; x += 24) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
  }

  function getAutoView(width, height) {
    const allPoints = [];
    state.tracks.forEach(track => {
      if (Array.isArray(track.points)) allPoints.push(...track.points);
      if (Number.isFinite(track.originLat) && Number.isFinite(track.originLon)) {
        allPoints.push({ lat: track.originLat, lon: track.originLon });
      }
    });
    if (!allPoints.length && state.originLat !== null && state.originLon !== null) {
      allPoints.push({ lat: state.originLat, lon: state.originLon });
    }
    if (!allPoints.length) return { centerLat: 0, centerLon: 0, zoom: 2 };
    const lats = allPoints.map(point => point.lat);
    const lons = allPoints.map(point => point.lon);
    return {
      centerLat: (Math.min(...lats) + Math.max(...lats)) / 2,
      centerLon: (Math.min(...lons) + Math.max(...lons)) / 2,
      zoom: chooseZoom(allPoints, width, height),
    };
  }

  function onWheel(event) {
    if (!state.canvas || state.originLat === null) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheelAt < 140) return;
    lastWheelAt = now;
    const rect = state.canvas.getBoundingClientRect();
    const width = rect.width || 244;
    const height = rect.height || 220;
    const autoView = getAutoView(width, height);
    const prevZoom = state.manualView ? state.currentZoom : autoView.zoom;
    const prevCenterLat = state.manualView ? state.centerLat : autoView.centerLat;
    const prevCenterLon = state.manualView ? state.centerLon : autoView.centerLon;
    const nextZoom = Math.max(1, Math.min(20, prevZoom + (event.deltaY < 0 ? 1 : -1)));
    if (nextZoom === prevZoom) return;
    const prevCenterWorld = lonLatToTilePixel(prevCenterLon, prevCenterLat, prevZoom);
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const targetWorldX = prevCenterWorld.x + mouseX - width / 2;
    const targetWorldY = prevCenterWorld.y + mouseY - height / 2;
    const zoomScale = Math.pow(2, nextZoom - prevZoom);
    const nextCenterWorld = {
      x: targetWorldX * zoomScale - (mouseX - width / 2),
      y: targetWorldY * zoomScale - (mouseY - height / 2),
    };
    state.currentZoom = nextZoom;
    state.centerLon = (nextCenterWorld.x / (256 * Math.pow(2, nextZoom))) * 360 - 180;
    const mercY = 0.5 - nextCenterWorld.y / (256 * Math.pow(2, nextZoom));
    state.centerLat = 90 - 360 * Math.atan(Math.exp(-mercY * 2 * Math.PI)) / Math.PI;
    state.manualView = true;
    draw();
  }

  function onPointerDown(event) {
    if (!state.canvas || event.button !== 0 || state.originLat === null) return;
    const rect = state.canvas.getBoundingClientRect();
    const width = rect.width || 244;
    const height = rect.height || 220;
    const autoView = getAutoView(width, height);
    const centerLat = state.manualView ? state.centerLat : autoView.centerLat;
    const centerLon = state.manualView ? state.centerLon : autoView.centerLon;
    const zoom = state.manualView ? state.currentZoom : autoView.zoom;
    const centerWorld = lonLatToTilePixel(centerLon, centerLat, zoom);
    state.dragActive = true;
    state.canvas.classList.add('dragging');
    state.dragStartX = event.clientX;
    state.dragStartY = event.clientY;
    state.dragStartCenterX = centerWorld.x;
    state.dragStartCenterY = centerWorld.y;
    state.currentZoom = zoom;
    state.centerLat = centerLat;
    state.centerLon = centerLon;
    state.manualView = true;
  }

  function onPointerMove(event) {
    if (!state.dragActive || !state.canvas) return;
    const dx = event.clientX - state.dragStartX;
    const dy = event.clientY - state.dragStartY;
    const zoom = state.currentZoom ?? 17;
    const centerWorld = { x: state.dragStartCenterX - dx, y: state.dragStartCenterY - dy };
    state.centerLon = (centerWorld.x / (256 * Math.pow(2, zoom))) * 360 - 180;
    const mercY = 0.5 - centerWorld.y / (256 * Math.pow(2, zoom));
    state.centerLat = 90 - 360 * Math.atan(Math.exp(-mercY * 2 * Math.PI)) / Math.PI;
    draw();
  }

  function onPointerUp() {
    if (!state.dragActive) return;
    state.dragActive = false;
    if (state.canvas) state.canvas.classList.remove('dragging');
  }

  function draw() {
    const canvas = state.canvas;
    if (!canvas) return;
    const ctx = state.ctx;
    const width = parseFloat(canvas.style.width) || (canvas.width / (window.devicePixelRatio || 1));
    const height = parseFloat(canvas.style.height) || (canvas.height / (window.devicePixelRatio || 1));
    ctx.clearRect(0, 0, width, height);
    if (state.originLat === null) return;

    const autoView = getAutoView(width, height);
    const centerLat = state.manualView ? state.centerLat : autoView.centerLat;
    const centerLon = state.manualView ? state.centerLon : autoView.centerLon;
    const zoom = state.manualView ? state.currentZoom : autoView.zoom;
    const centerWorld = lonLatToTilePixel(centerLon, centerLat, zoom);

    function toXY(lat, lon) {
      const world = lonLatToTilePixel(lon, lat, zoom);
      return { x: world.x - centerWorld.x + width / 2, y: world.y - centerWorld.y + height / 2 };
    }

    drawFallbackBackground(ctx, width, height);

    let loadedTileCount = 0;
    const minTileX = Math.floor((centerWorld.x - width / 2) / 256);
    const maxTileX = Math.floor((centerWorld.x + width / 2) / 256);
    const minTileY = Math.floor((centerWorld.y - height / 2) / 256);
    const maxTileY = Math.floor((centerWorld.y + height / 2) / 256);
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        const img = ensureTile(zoom, tx, ty);
        if (!img || !img.complete || img.naturalWidth === 0) continue;
        ctx.drawImage(img, tx * 256 - centerWorld.x + width / 2, ty * 256 - centerWorld.y + height / 2, 256, 256);
        loadedTileCount += 1;
      }
    }
    if (loadedTileCount === 0) {
      ctx.fillStyle = 'rgba(245, 247, 250, 0.82)';
      ctx.fillRect(0, 0, width, height);
    }

    const selectedProjectId = getSelectedProjectId();
    state.tracks.forEach(track => {
      const points = Array.isArray(track.points) ? track.points : [];
      if (points.length > 1) {
        ctx.strokeStyle = track.color || '#4078ff';
        ctx.lineWidth = track.projectId === selectedProjectId ? 2.5 : 1.75;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        const start = toXY(points[0].lat, points[0].lon);
        ctx.moveTo(start.x, start.y);
        for (let i = 1; i < points.length; i++) {
          const next = toXY(points[i].lat, points[i].lon);
          ctx.lineTo(next.x, next.y);
        }
        ctx.stroke();
      }
      if (Number.isFinite(track.originLat) && Number.isFinite(track.originLon)) {
        const { x, y } = toXY(track.originLat, track.originLon);
        ctx.shadowColor = track.projectId === selectedProjectId ? '#ffffff' : (track.color || '#ef4444');
        ctx.shadowBlur = track.projectId === selectedProjectId ? 7 : 4;
        ctx.fillStyle = track.color || '#ef4444';
        ctx.beginPath();
        ctx.arc(x, y, track.projectId === selectedProjectId ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    });

    const metersPerPixel = 156543.03392 * Math.cos(centerLat * Math.PI / 180) / Math.pow(2, zoom);
    const scaleMeters = [20, 50, 100, 200, 500, 1000].find(v => (v / metersPerPixel) >= 24) || 1000;
    const scalePixels = scaleMeters / metersPerPixel;
    if (scalePixels > 10 && scalePixels < width * 0.6) {
      const barX = 10;
      const barY = height - 14;
      ctx.strokeStyle = 'rgba(29, 29, 31, 0.78)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX, barY); ctx.lineTo(barX + scalePixels, barY);
      ctx.moveTo(barX, barY - 3); ctx.lineTo(barX, barY + 3);
      ctx.moveTo(barX + scalePixels, barY - 3); ctx.lineTo(barX + scalePixels, barY + 3);
      ctx.stroke();
      ctx.fillStyle = 'rgba(29, 29, 31, 0.72)';
      ctx.font = '9px sans-serif';
      ctx.fillText(scaleMeters >= 1000 ? `${(scaleMeters / 1000).toFixed(scaleMeters % 1000 === 0 ? 0 : 1)} km` : `${scaleMeters} m`, barX + 2, barY - 4);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fillRect(0, 0, width, 14);
    ctx.fillStyle = 'rgba(62, 67, 76, 0.86)';
    ctx.font = '10px monospace';
    ctx.fillText(`${state.originLat.toFixed(6)}, ${state.originLon.toFixed(6)}  z${zoom}`, 4, 11);
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillRect(0, height - 13, width, 13);
    ctx.fillStyle = 'rgba(62, 67, 76, 0.80)';
    ctx.font = '9px sans-serif';
    ctx.fillText(state.attributionLabel, 4, height - 4);
  }

  function updateTrajectory() {
    const tracks = [];
    getLoadedScannerProjects().forEach(project => {
      if (!project.geoInfo) return;
      const originWgs = ecefToWGS84(project.geoInfo.origin.x, project.geoInfo.origin.y, project.geoInfo.origin.z);
      const odom = Array.isArray(project.odomData) ? project.odomData : [];
      const step = Math.max(1, Math.floor(Math.max(odom.length, 1) / 800));
      const points = [];
      for (let i = 0; i < odom.length; i += step) {
        const point = odom[i];
        const ecef = localToECEF({ x: point.x, y: point.y, z: point.z }, project.geoInfo);
        const wgs = ecefToWGS84(ecef.x, ecef.y, ecef.z);
        if (Number.isFinite(wgs.lat) && Number.isFinite(wgs.lon)) {
          points.push({ lat: wgs.lat, lon: wgs.lon });
        }
      }
      tracks.push({
        projectId: project.projectId,
        name: project.projectName || project.projectId,
        color: project.accentColor || '#4078ff',
        originLat: originWgs.lat,
        originLon: originWgs.lon,
        points,
      });
    });
    state.tracks = tracks;
    const selected = tracks.find(track => track.projectId === getSelectedProjectId()) || tracks[0] || null;
    state.wgsPoints = selected?.points || [];
    state.originLat = selected?.originLat ?? null;
    state.originLon = selected?.originLon ?? null;
    draw();
  }

  function update() {
    const scannerState = getScannerState();
    if (!scannerState?.geoInfo) return;
    const { lat, lon } = ecefToWGS84(
      scannerState.geoInfo.origin.x,
      scannerState.geoInfo.origin.y,
      scannerState.geoInfo.origin.z
    );
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const placeholder = document.getElementById('minimap-placeholder');
    const container = document.getElementById('minimap-container');
    const info = document.getElementById('minimap-info');
    placeholder.style.display = 'none';
    container.style.display = 'block';
    info.style.display = 'block';
    state.originLat = lat;
    state.originLon = lon;
    updateProviderMeta();
    renderInfo();
    initCanvas();
    draw();
    setTimeout(updateTrajectory, 400);
  }

  return {
    bindControls,
    togglePanel,
    toggleExpanded,
    toggleBasemap,
    resetView,
    updateTrajectory,
    update,
  };
}
