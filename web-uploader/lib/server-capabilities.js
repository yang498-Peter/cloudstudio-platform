const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

export const DEFAULT_SERVER_CAPABILITIES = Object.freeze({
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
});

const FEATURE_ENV_NAMES = Object.freeze({
  viewerUiV2: 'VIEWER_UI_V2',
  measurement: 'MEASUREMENT',
  clipBox: 'CLIP_BOX',
  deleteRegion: 'DELETE_REGION',
  profile: 'PROFILE',
  capture: 'CAPTURE',
  crs: 'CRS',
  export: 'EXPORT',
  sceneTree: 'SCENE_TREE',
  scannerRuntime: 'SCANNER_RUNTIME',
  datasetManagement: 'DATASET_MANAGEMENT',
  desktopLocalImport: 'DESKTOP_LOCAL_IMPORT',
  mvpSolver: 'MVP_SOLVER',
  forestry: 'FORESTRY',
  pointcloudRegistration: 'POINTCLOUD_REGISTRATION',
  terrainProcessing: 'TERRAIN_PROCESSING',
  volumeJobs: 'VOLUME_JOBS',
  orthoImage: 'ORTHO_IMAGE',
});

const FEATURE_ROUTE_RULES = Object.freeze([
  { feature: 'datasetManagement', pattern: /^\/api\/(?:delete-cloud|clouds\/remove|scan-projects\/remove)(?:\/|$)/ },
  { feature: 'desktopLocalImport', pattern: /^\/api\/(?:upload-by-path|desktop(?:\/|$)|grids\/import-dialog(?:\/|$)|import\/local\/jobs(?:\/|$)|scan-projects\/register(?:\/|$)|scan-roots(?:\/|$))/ },
  { feature: 'mvpSolver', pattern: /^\/api\/metacam-solver(?:\/|$)/ },
  { feature: 'export', pattern: /^\/api\/(?:export-pointcloud|export-las|export-sources)(?:\/|$)/ },
  { feature: 'crs', pattern: /^\/api\/(?:crs(?:\/|$)|grids(?:\/|$)|scan-projects\/crs(?:\/|$))/ },
  { feature: 'scannerRuntime', pattern: /^\/api\/scan-projects(?:\/?$|\/photos(?:\/|$))/ },
  { feature: 'forestry', pattern: /^\/api\/forestry(?:\/|$)/ },
  { feature: 'pointcloudRegistration', pattern: /^\/api\/pointcloud-registration(?:\/|$)/ },
  { feature: 'orthoImage', pattern: /^\/api\/ortho-image(?:\/|$)/ },
  {
    feature: 'terrainProcessing',
    pattern: /^\/api\/(?:find-las|mesh-file|project-dir|floorplan\/extract|generate-dtm|download-dtm|generate-surface|download-surface|surface-mesh|surface-grid|generate-contours|download-contours|contour-geojson|classify-ground|generate-hag|compute-geometric-features|classify-rule-based|segment-individual-trees|terrain-jobs|run-semantic-pipeline)(?:\/|$|\?)/,
  },
  {
    feature: 'volumeJobs',
    pattern: /^\/api\/(?:generate-volume-surface|download-volume-surface|volume-surface-mesh|volume-surface-grid|volume-jobs|volume-results|volume-mesh|volume-grid|volume-report-view-snapshot|download-volume-job)(?:\/|$|\?)/,
  },
]);

const STATIC_PROJECT_SUBPATH_RULES = Object.freeze([
  { feature: 'forestry', pattern: /^\/forestry(?:\/|$)/i },
  { feature: 'terrainProcessing', pattern: /^\/(?:terrain|dtm|floorplan|surface|contour|contours|hag|classification|classified)(?:\/|$)/i },
  { feature: 'volumeJobs', pattern: /^\/(?:volume|volume_jobs|volume-jobs|volume_surface|volume-surface)(?:\/|$)/i },
  { feature: 'orthoImage', pattern: /^\/(?:ortho|ortho-image|orthophoto)(?:\/|$)/i },
]);

function normalizeStaticProjectSubpath(requestPath, { stripFirstSegment = false } = {}) {
  let pathname = String(requestPath || '').split('?')[0] || '/';
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  if (stripFirstSegment) pathname = pathname.replace(/^\/[^/]+/i, '') || '/';
  return pathname;
}

function parseEnvBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return null;
}

function resolveFeatureOverride(feature, env = process.env) {
  const suffix = FEATURE_ENV_NAMES[feature];
  if (!suffix) return null;
  const explicit = parseEnvBoolean(env[`CLOUDSTUDIO_FEATURE_${suffix}`]);
  if (explicit != null) return explicit;
  const enabled = parseEnvBoolean(env[`CLOUDSTUDIO_ENABLE_${suffix}`]);
  if (enabled != null) return enabled;
  const disabled = parseEnvBoolean(env[`CLOUDSTUDIO_DISABLE_${suffix}`]);
  if (disabled != null) return !disabled;
  return null;
}

export function resolveServerCapabilities(env = process.env, defaults = DEFAULT_SERVER_CAPABILITIES) {
  const features = {};
  for (const [feature, defaultValue] of Object.entries(defaults)) {
    const override = resolveFeatureOverride(feature, env);
    features[feature] = override == null ? Boolean(defaultValue) : override;
  }
  return Object.freeze({
    mode: 'server',
    features: Object.freeze(features),
  });
}

export function isFeatureEnabled(capabilities, feature) {
  return Boolean(capabilities?.features?.[feature]);
}

export function getDisabledFeatureForPath(pathname, capabilities) {
  // Express routing is case-insensitive by default, so a disabled handler is
  // reachable as /api/Volume-Results even though the rule prefixes are lowercase.
  // Lowercase the path before matching so case variants cannot bypass the gate.
  const pathOnly = String(pathname || '').split('?')[0].toLowerCase();
  for (const rule of FEATURE_ROUTE_RULES) {
    if (rule.pattern.test(pathOnly) && !isFeatureEnabled(capabilities, rule.feature)) {
      return rule.feature;
    }
  }
  return null;
}

export function getDisabledFeatureForStaticProjectPath(requestPath, capabilities, options = {}) {
  const pathname = normalizeStaticProjectSubpath(requestPath, options);
  for (const rule of STATIC_PROJECT_SUBPATH_RULES) {
    if (rule.pattern.test(pathname) && !isFeatureEnabled(capabilities, rule.feature)) {
      return rule.feature;
    }
  }
  return null;
}

export function createFeatureDisabledError(feature) {
  const error = new Error(`Feature is disabled on this CloudStudio server: ${feature}`);
  error.code = 'FEATURE_DISABLED';
  error.feature = feature;
  return error;
}
