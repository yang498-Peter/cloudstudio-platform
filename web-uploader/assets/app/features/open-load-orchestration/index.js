export function createOpenLoadOrchestrationFeature({
  fetchImpl = window.fetch.bind(window),
  translate,
  translateText,
  toast,
  setStatus,
  getLocationSearch = () => window.location.search,
  inferCloudNameFromMetadataUrl,
  setActiveDatasetContext,
  setCloudDisplayName,
  pruneScannerProjectVisuals,
  refreshSceneTree,
  refreshClassification,
  getActiveDatasetContext,
  setSelectedScannerProject,
  loadCoordinateConfig,
  loadScannerData,
} = {}) {
  function t(key, fallback, vars = {}) {
    if (typeof translate === 'function') return translate(key, vars, fallback);
    if (typeof window !== 'undefined' && typeof window.__APP_SERVICES?.i18n?.t === 'function') {
      return window.__APP_SERVICES.i18n.t(key, vars, fallback);
    }
    return typeof translateText === 'function' ? translateText(fallback) : fallback;
  }

  function inferScannerProjectIdFromScanDataUrl(url = '') {
    const match = String(url || '').match(/\/scan-data\/([^/]+)\//i);
    return match?.[1] ? decodeURIComponent(match[1]) : '';
  }

  function prepareCloudOpen(url, context = null) {
    const nameParts = String(url || '').split('/').filter(Boolean);
    const inferredCloudName = inferCloudNameFromMetadataUrl(url);
    const inferredProjectId = inferScannerProjectIdFromScanDataUrl(url);
    const name = (context && (context.displayName || context.projectName || context.cloudName))
      || inferredCloudName
      || inferredProjectId
      || nameParts[nameParts.length - 2]
      || 'PointCloud';
    const nextContext = context || (inferredProjectId ? {
      type: 'scanner',
      projectId: inferredProjectId,
      projectName: name,
      scanDataUrl: `/scan-data/${encodeURIComponent(inferredProjectId)}`,
      metadataUrl: url,
      cloudName: inferredCloudName || name,
    } : { type: 'cloud', cloudName: inferredCloudName || name });

    setActiveDatasetContext(nextContext);
    setStatus(t('viewer.openLoad.status.loading', 'Loading: {{name}}...', { name }));
    toast(t('viewer.openLoad.toast.loadingPointCloud', 'Loading point cloud: {{name}}', { name }), 'info');
    setCloudDisplayName(name);

    return {
      name,
      inferredCloudName,
      context: nextContext,
    };
  }

  function handlePointCloudLoaded({ name }) {
    pruneScannerProjectVisuals();
    setStatus(t('common.status.ready', 'Ready'));
    toast(t('viewer.openLoad.toast.pointCloudLoaded', 'Point cloud loaded: {{name}}', { name }), 'ok');
    refreshSceneTree();
    refreshClassification();
    pruneScannerProjectVisuals();
  }

  async function resolveScannerAssociation({ inferredCloudName, pointcloud, currentContext }) {
    if (!inferredCloudName || currentContext?.type === 'scanner') return null;

    const response = await fetchImpl(`/api/cloud-source?cloudName=${encodeURIComponent(inferredCloudName)}`);
    const data = await response.json();
    if (!data?.ok || !data.manifest?.scannerProjectId) return null;

    const manifest = data.manifest;
    return {
      projectId: manifest.scannerProjectId,
      projectName: manifest.scannerProjectName || manifest.scannerProjectId,
      scanDataUrl: manifest.scanDataUrl || `/scan-data/${manifest.scannerProjectId}`,
      cloudName: inferredCloudName,
      sourcePath: manifest.sourcePath || manifest.dirPath || '',
      dirPath: manifest.dirPath || manifest.sourcePath || '',
      metadataUrl: manifest.pointcloudUrl || pointcloud?.userData?.metadataUrl || '',
      coordinateContext: manifest.coordinateContext || null,
      coordinateBasis: manifest.coordinateBasis || manifest.coordinateContext?.coordinateBasis || null,
      globalCoordinateAvailable: Boolean(manifest.globalCoordinateAvailable || manifest.coordinateContext?.globalCoordinateAvailable),
      vendor: manifest.vendor || null,
      scannerFormat: manifest.scannerFormat || null,
      pointcloud,
    };
  }

  async function openScannerProject({
    projectId,
    pointcloudUrl,
    scanDataUrl,
    projectName,
    sourcePath = '',
    coordinateContext = null,
    coordinateBasis = null,
    globalCoordinateAvailable = null,
    vendor = null,
    scannerFormat = null,
  }) {
    setSelectedScannerProject(projectId, { syncContext: true });
    await loadCoordinateConfig(projectId);
    const contextCoordinateBasis = coordinateBasis || coordinateContext?.coordinateBasis || null;
    const contextGlobalCoordinateAvailable = Boolean(globalCoordinateAvailable ?? coordinateContext?.globalCoordinateAvailable ?? false);
    if (pointcloudUrl) {
      return {
        shouldOpenPointCloud: true,
        pointcloudUrl,
        context: {
          type: 'scanner',
          projectId,
          projectName: projectName || projectId,
          scanDataUrl,
          metadataUrl: pointcloudUrl,
          sourcePath,
          dirPath: sourcePath,
          coordinateContext,
          coordinateBasis: contextCoordinateBasis,
          globalCoordinateAvailable: contextGlobalCoordinateAvailable,
          vendor,
          scannerFormat,
        },
      };
    }

    setTimeout(() => loadScannerData(projectId), 800);
    return {
      shouldOpenPointCloud: false,
      pointcloudUrl: null,
      context: {
        type: 'scanner',
        projectId,
        projectName: projectName || projectId,
        scanDataUrl,
        sourcePath,
        dirPath: sourcePath,
        coordinateContext,
        coordinateBasis: contextCoordinateBasis,
        globalCoordinateAvailable: contextGlobalCoordinateAvailable,
        vendor,
        scannerFormat,
      },
    };
  }

  function parseInitialRoute() {
    const urlParams = new URLSearchParams(getLocationSearch());
    const initCloud = urlParams.get('pointcloud');
    const projectId = urlParams.get('projectId');
    const scanDataUrl = urlParams.get('scanDataUrl');
    const projectName = urlParams.get('projectName');

    if (projectId) {
      return {
        type: 'scanner',
        projectId,
        pointcloudUrl: initCloud || '',
        scanDataUrl: scanDataUrl || `/scan-data/${projectId}`,
        projectName: projectName || projectId,
      };
    }

    if (!initCloud) return null;

    const scanDataMatch = initCloud.match(/\/scan-data\/([^/]+)\//);
    if (scanDataMatch) {
      const decodedProjectId = decodeURIComponent(scanDataMatch[1]);
      return {
        type: 'scanner',
        projectId: decodedProjectId,
        pointcloudUrl: initCloud,
        scanDataUrl: scanDataUrl || `/scan-data/${decodedProjectId}`,
        projectName: projectName || decodedProjectId,
      };
    }

    return {
      type: 'cloud',
      pointcloudUrl: initCloud,
      context: { type: 'cloud', cloudName: inferCloudNameFromMetadataUrl(initCloud) },
    };
  }

  return {
    prepareCloudOpen,
    handlePointCloudLoaded,
    resolveScannerAssociation,
    openScannerProject,
    parseInitialRoute,
    getActiveDatasetContext,
  };
}
