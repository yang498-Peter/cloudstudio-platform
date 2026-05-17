export function createOpenLoadOrchestrationFeature({
  fetchImpl = window.fetch.bind(window),
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
  function prepareCloudOpen(url, context = null) {
    const nameParts = String(url || '').split('/').filter(Boolean);
    const inferredCloudName = inferCloudNameFromMetadataUrl(url);
    const name = (context && (context.cloudName || context.projectName))
      || inferredCloudName
      || nameParts[nameParts.length - 2]
      || 'PointCloud';
    const nextContext = context || { type: 'cloud', cloudName: inferredCloudName || name };

    setActiveDatasetContext(nextContext);
    setStatus(`${translateText('Loading')}: ${name}…`);
    toast(`${translateText('Loading point cloud')}: ${name}`, 'info');
    setCloudDisplayName(name);

    return {
      name,
      inferredCloudName,
      context: nextContext,
    };
  }

  function handlePointCloudLoaded({ name }) {
    pruneScannerProjectVisuals();
    setStatus(translateText('Ready'));
    toast(`${translateText('✓ Point cloud loaded')}: ${name}`, 'ok');
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
      pointcloud,
    };
  }

  async function openScannerProject({ projectId, pointcloudUrl, scanDataUrl, projectName }) {
    setSelectedScannerProject(projectId, { syncContext: true });
    await loadCoordinateConfig(projectId);
    if (pointcloudUrl) {
      return {
        shouldOpenPointCloud: true,
        pointcloudUrl,
        context: {
          type: 'scanner',
          projectId,
          projectName: projectName || projectId,
          scanDataUrl,
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
