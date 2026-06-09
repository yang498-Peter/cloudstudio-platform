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
  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    if (typeof window !== 'undefined' && typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
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
      items.push({ icon: '📡', key: t('viewer.scanner.info.rtk', 'RTK Positioning'), val: params.enableRtk ? `✓ ${t('viewer.scanner.info.enabled', 'Enabled')}` : `✗ ${t('viewer.scanner.info.disabled', 'Disabled')}` });
      items.push({ icon: '🎨', key: t('viewer.scanner.info.colorStatus', 'Color status'), val: params.enableColorizer ? `✓ ${t('viewer.scanner.info.colorized', 'Colorized')}` : `✗ ${t('viewer.scanner.info.notColorized', 'Not colorized')}` });
      items.push({ icon: '🏞', key: t('viewer.scanner.info.sceneType', 'Scene type'), val: params.sceneType || t('common.unknown', 'Unknown') });
    } catch (error) {
      console.warn('params.json load failed', error);
    }

    try {
      const metadataUrl = (typeof getMetadataUrl === 'function' ? getMetadataUrl() : '')
        || `${basePath}/converted/metadata.json`;
      const meta = await readJson(metadataUrl);
      state.metaJson = meta;
      const points = meta.points ? Number(meta.points).toLocaleString(locale === 'zh-CN' ? 'zh-CN' : locale) : t('common.unknown', 'Unknown');
      items.push({ icon: '☁', key: t('viewer.scanner.info.totalPoints', 'Total points'), val: points });
      if (meta.boundingBox) {
        const bb = meta.boundingBox;
        const dx = formatLinearMeasurement(bb.max[0] - bb.min[0], 'm', { digits: 1 });
        const dy = formatLinearMeasurement(bb.max[1] - bb.min[1], 'm', { digits: 1 });
        const dz = formatLinearMeasurement(bb.max[2] - bb.min[2], 'm', { digits: 1 });
        items.push({ icon: '📐', key: `${t('viewer.scanner.info.extent', 'Extent')} (${getActiveLinearUnit().symbol})`, val: `${dx} × ${dy} × ${dz}` });
      }
    } catch (error) {
      console.warn('metadata.json load failed', error);
    }

    if (state.odomData.length) {
      const odom = state.odomData;
      const duration = ((odom[odom.length - 1].t - odom[0].t) / 1e9).toFixed(1);
      items.push({ icon: '⏱', key: t('viewer.scanner.info.scanDuration', 'Scan duration'), val: `${duration} ${t('viewer.scanner.info.seconds', 's')}` });
      items.push({ icon: '📊', key: t('viewer.scanner.info.odometryFrames', 'Odometry frames'), val: odom.length.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : locale) });

      let totalLength = 0;
      for (let i = 1; i < odom.length; i++) {
        const dx = odom[i].x - odom[i - 1].x;
        const dy = odom[i].y - odom[i - 1].y;
        const dz = odom[i].z - odom[i - 1].z;
        totalLength += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      items.push({ icon: '📏', key: t('viewer.scanner.info.pathLength', 'Path length'), val: formatLinearMeasurement(totalLength, 'm', { digits: 2 }) });
    }

    const leftCameras = state.cameras.filter(camera => camera.side === 'left');
    if (leftCameras.length) {
      items.push({ icon: '📷', key: t('viewer.scanner.info.stereoPairs', 'Stereo camera pairs'), val: `${leftCameras.length} ${t('viewer.scanner.info.pairs', 'pairs')}` });
    }

    const coordinateBasis = String(state.coordinateContext?.coordinateBasis || (state.geoInfo ? 'local-with-geo-info' : 'unknown')).toLowerCase();
    const originWgs = state.geoInfo
      ? ecefToWGS84(state.geoInfo.origin.x, state.geoInfo.origin.y, state.geoInfo.origin.z)
      : (state.coordinateContext?.originWgs84 || null);
    if (coordinateBasis === 'ecef-absolute') {
      items.push({ icon: '🌐', key: t('viewer.scanner.info.coordinateSource', 'Coordinate source'), val: t('viewer.scanner.info.ecefAbsolute', 'ECEF absolute') });
    } else if (state.geoInfo) {
      items.push({ icon: '🌐', key: t('viewer.scanner.info.coordinateSource', 'Coordinate source'), val: t('viewer.scanner.info.localGeoInfo', 'Local + geo_info.csv') });
    }

    if (originWgs) {
      const { lat, lon, alt } = originWgs;
      items.push({ icon: '🌍', key: t('viewer.scanner.info.longitude', 'Longitude'), val: `${lon.toFixed(6)}°` });
      items.push({ icon: '🌍', key: t('viewer.scanner.info.latitude', 'Latitude'), val: `${lat.toFixed(6)}°` });
      items.push({ icon: '🏔', key: t('viewer.scanner.info.altitude', 'Altitude'), val: formatLinearMeasurement(alt, 'm', { digits: 1 }) });

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
        items.push({ icon: '🗺', key: t('viewer.scanner.info.recommendedProjection', 'Recommended projection'), val: `${autoGrid.label} · ${autoGrid.source}` });
      }
    }

    container.innerHTML = items.map(item =>
      `<div class="scanner-stat"><span class="s-icon">${item.icon}</span><span class="s-key">${escapeHtml(item.key)}</span><span class="s-val">${escapeHtml(item.val)}</span></div>`
    ).join('');
    applyTranslations(container);
  }

  return {
    loadScanInfo,
  };
}
