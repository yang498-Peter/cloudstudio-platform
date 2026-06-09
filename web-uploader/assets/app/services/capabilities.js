export const DEFAULT_SERVER_CAPABILITIES = Object.freeze({
  mode: 'server',
  features: Object.freeze({
    viewerUiV2: true,
    measurement: true,
    clipBox: true,
    deleteRegion: true,
    profile: true,
    capture: true,
    crs: true,
    export: true,
    sceneTree: true,
    scannerRuntime: true,
    datasetManagement: false,
    desktopLocalImport: false,
    mvpSolver: false,
    forestry: false,
    pointcloudRegistration: false,
    terrainProcessing: false,
    volumeJobs: false,
    orthoImage: false,
  }),
});

function normalizeCapabilities(payload) {
  const source = payload?.capabilities || payload || {};
  const sourceFeatures = source.features || {};
  return {
    mode: source.mode || DEFAULT_SERVER_CAPABILITIES.mode,
    features: {
      ...DEFAULT_SERVER_CAPABILITIES.features,
      ...sourceFeatures,
    },
  };
}

export async function loadServerCapabilities(apiClient) {
  try {
    if (apiClient?.getJson) {
      return normalizeCapabilities(await apiClient.getJson('/api/capabilities'));
    }
    const response = await fetch('/api/capabilities', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeCapabilities(await response.json());
  } catch (error) {
    console.warn('[CloudStudio] Using fallback server capabilities:', error?.message || error);
    return normalizeCapabilities(DEFAULT_SERVER_CAPABILITIES);
  }
}

export function isCapabilityEnabled(capabilities, feature) {
  return Boolean(capabilities?.features?.[feature]);
}

export function addFeatureIfEnabled(target, capabilities, feature, name, factory) {
  if (isCapabilityEnabled(capabilities, feature)) {
    target[name] = factory;
  }
  return target;
}
