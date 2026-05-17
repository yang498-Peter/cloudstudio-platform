export function createScannerInfoPanelFeature({
  fetchImpl = window.fetch.bind(window),
  getBasePath,
  getMetadataUrl,
  getScannerState,
  translate,
  translateText,
  applyTranslations,
  formatLinearMeasurement,
  formatLinearAxis,
  resolveCoordinateSystem,
  getOriginCoordinateForCurrentSystem,
  getAutoProjectedSystem,
  getActiveLinearUnit,
  ecefToWGS84,
  escapeHtml,
  getLocale,
} = {}) {
  function t(key, fallback) {
    return typeof translate === 'function' ? translate(key, {}, fallback) : translateText(fallback);
  }

  async function readJson(url) {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  async function loadScanInfo() {
    const state = getScannerState();
    const container = document.getElementById('scan-info-list');
    const basePath = getBasePath();
    const items = [];
    const locale = typeof getLocale === 'function' ? getLocale() : 'en';

    try {
      const params = await readJson(`${basePath}/params.json`);
      state.paramsJson = params;
      items.push({ icon: '📡', key: 'viewer.scannerInfo.rtkPositioning', val: params.enableRtk ? `✓ ${t('viewer.scannerInfo.enabled', 'Enabled')}` : `✗ ${t('viewer.scannerInfo.disabled', 'Disabled')}` });
      items.push({ icon: '🎨', key: 'viewer.scannerInfo.colorization', val: params.enableColorizer ? `✓ ${t('viewer.scannerInfo.colorized', 'Colorized')}` : `✗ ${t('viewer.scannerInfo.notColorized', 'Not colorized')}` });
      items.push({ icon: '🏞', key: 'viewer.scannerInfo.sceneType', val: params.sceneType || t('viewer.scannerInfo.unknown', 'Unknown') });
    } catch (error) {
      console.warn('params.json load failed', error);
    }

    try {
      const metadataUrl = (typeof getMetadataUrl === 'function' ? getMetadataUrl() : '')
        || `${basePath}/converted/metadata.json`;
      const meta = await readJson(metadataUrl);
      state.metaJson = meta;
      const points = meta.points ? Number(meta.points).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : locale) : t('viewer.scannerInfo.unknown', 'Unknown');
      items.push({ icon: '☁', key: 'viewer.scannerInfo.totalPoints', val: points });
      if (meta.boundingBox) {
        const bb = meta.boundingBox;
        const dx = formatLinearMeasurement(bb.max[0] - bb.min[0], 'm', { digits: 1 });
        const dy = formatLinearMeasurement(bb.max[1] - bb.min[1], 'm', { digits: 1 });
        const dz = formatLinearMeasurement(bb.max[2] - bb.min[2], 'm', { digits: 1 });
        items.push({ icon: '📐', key: `${t('viewer.scannerInfo.extent', 'Extent')} (${getActiveLinearUnit().symbol})`, val: `${dx} × ${dy} × ${dz}` });
      }
    } catch (error) {
      console.warn('metadata.json load failed', error);
    }

    if (state.odomData.length) {
      const odom = state.odomData;
      const duration = ((odom[odom.length - 1].t - odom[0].t) / 1e9).toFixed(1);
      items.push({ icon: '⏱', key: 'viewer.scannerInfo.scanDuration', val: `${duration} ${t('viewer.scannerInfo.seconds', 's')}` });
      items.push({ icon: '📊', key: 'viewer.scannerInfo.odometryFrames', val: odom.length.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : locale) });

      let totalLength = 0;
      for (let i = 1; i < odom.length; i++) {
        const dx = odom[i].x - odom[i - 1].x;
        const dy = odom[i].y - odom[i - 1].y;
        const dz = odom[i].z - odom[i - 1].z;
        totalLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      items.push({ icon: '📏', key: 'viewer.scannerInfo.pathLength', val: formatLinearMeasurement(totalLength, 'm', { digits: 2 }) });
    }

    const leftCameras = state.cameras.filter(camera => camera.side === 'left');
    if (leftCameras.length) {
      items.push({ icon: '📷', key: 'viewer.scannerInfo.stereoCameraPairs', val: `${leftCameras.length} ${t('viewer.scannerInfo.pairs', 'pairs')}` });
    }

    if (state.geoInfo) {
      const { lat, lon, alt } = ecefToWGS84(state.geoInfo.origin.x, state.geoInfo.origin.y, state.geoInfo.origin.z);
      items.push({ icon: '🌍', key: 'viewer.scannerInfo.longitude', val: `${lon.toFixed(6)}°` });
      items.push({ icon: '🌍', key: 'viewer.scannerInfo.latitude', val: `${lat.toFixed(6)}°` });
      items.push({ icon: '🏔', key: 'viewer.scannerInfo.altitude', val: formatLinearMeasurement(alt, 'm', { digits: 1 }) });

      const resolved = state.resolvedCoordinateSystem || resolveCoordinateSystem();
      const originCoord = getOriginCoordinateForCurrentSystem();
      if (originCoord && !originCoord.error) {
        if (originCoord.kind === 'geographic') {
          items.push({ icon: '🧭', key: `${resolved.label}`, val: `${originCoord.lon.toFixed(8)}°, ${originCoord.lat.toFixed(8)}°, ${formatLinearAxis(originCoord.alt, 'm')}` });
        } else if (originCoord.kind === 'projected') {
          const xyUnit = originCoord.xyUnitSpec || 'm';
          items.push({ icon: '🧭', key: `${resolved.label}`, val: `E ${formatLinearAxis(originCoord.x, xyUnit)} / N ${formatLinearAxis(originCoord.y, xyUnit)} / H ${formatLinearAxis(originCoord.z, 'm')}` });
        } else {
          items.push({ icon: '🧭', key: `${resolved.label}`, val: `X ${formatLinearAxis(originCoord.x, 'm')} / Y ${formatLinearAxis(originCoord.y, 'm')} / Z ${formatLinearAxis(originCoord.z, 'm')}` });
        }
      }

      const autoGrid = getAutoProjectedSystem({ lat, lon, alt });
      if (autoGrid) {
        items.push({ icon: '🗺', key: 'viewer.scannerInfo.recommendedProjection', val: `${autoGrid.label} · ${autoGrid.source}` });
      }
    }

    container.innerHTML = items.map(item =>
      `<div class="scanner-stat"><span class="s-icon">${item.icon}</span><span class="s-key">${escapeHtml(translateText(item.key))}</span><span class="s-val">${escapeHtml(item.val)}</span></div>`
    ).join('');
    applyTranslations(container);
  }

  return {
    loadScanInfo,
  };
}
