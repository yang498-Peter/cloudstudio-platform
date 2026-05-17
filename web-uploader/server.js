import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readLastJsonLine } from './lib/job-result.js';
import {
  buildRuntimeStorageLayout,
  createStaticFallbackMiddleware,
  ensureRuntimeStorageLayout,
  getDiskUsageSummary,
  isSafePublicStaticRequest,
  listDirectoryEntries,
  resolveFirstExistingPath as resolveFirstExistingRuntimePath,
  resolveRuntimePath,
} from './lib/runtime-storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8090;
const IS_WINDOWS = process.platform === 'win32';
const IS_DESKTOP_BUILD = false;
const HOST = process.env.HOST || '0.0.0.0';
const EMBEDDED_VIEWER_HTML = '';
const DEFAULT_UPLOAD_PASSWORD_SHA256 = '4beb94958cd5b507d6b013c89964bf72c5434bddcc06f98baf8eb70143720e63';
const SPLAT_TRANSFORM_VERSION = '2.0.3';
const GAUSSIAN_CONVERT_ROTATION = String(process.env.GAUSSIAN_CONVERT_ROTATION || '90,0,180').trim();
const DEFAULT_GAUSSIAN_VIEWER_ROTATION = Object.freeze({ rx: 90, ry: 0, rz: 180 });
const BAKED_GAUSSIAN_VIEWER_ROTATION = Object.freeze({ rx: 0, ry: 0, rz: 0 });
let gaussianConversionQueue = Promise.resolve();
const UPLOAD_PASSWORD_SHA256 = resolveUploadPasswordHash(process.env);
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const UPLOAD_MAX_BYTES = parsePositiveIntegerEnv('CLOUDSTUDIO_UPLOAD_MAX_BYTES', 50 * GIB);
const ZIP_MAX_TOTAL_BYTES = parsePositiveIntegerEnv('CLOUDSTUDIO_ZIP_MAX_TOTAL_BYTES', 50 * GIB);
const ZIP_MAX_FILE_BYTES = parsePositiveIntegerEnv('CLOUDSTUDIO_ZIP_MAX_FILE_BYTES', 10 * GIB);
const ZIP_MAX_FILES = parsePositiveIntegerEnv('CLOUDSTUDIO_ZIP_MAX_FILES', 100000);
const GRID_UPLOAD_MAX_BYTES = parsePositiveIntegerEnv('CLOUDSTUDIO_GRID_UPLOAD_MAX_BYTES', 2 * GIB);

const ROOT = path.resolve(__dirname, '..');
const POTREE_ROOT = path.join(ROOT, 'potree');
const PYTHON_VENDOR_SITE = '';
const RUNTIME_STORAGE = buildRuntimeStorageLayout({ appDir: __dirname, env: process.env });

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function pathExists(candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function canWriteDirectory(dirPath) {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getRuntimeStorageHealth() {
  const directoryConfigs = [
    RUNTIME_STORAGE.uploads,
    RUNTIME_STORAGE.pointclouds,
    RUNTIME_STORAGE.gaussians,
    RUNTIME_STORAGE.projects,
    RUNTIME_STORAGE.exports,
    RUNTIME_STORAGE.cache,
  ];
  const directories = {};
  for (const dirConfig of directoryConfigs) {
    directories[dirConfig.key] = {
      primaryExists: pathExists(dirConfig.primary),
      primaryWritable: canWriteDirectory(dirConfig.primary),
      legacyExists: pathExists(dirConfig.legacy),
    };
  }
  const disk = getDiskUsageSummary(STORAGE_ROOT);
  return {
    configured: Boolean(RUNTIME_STORAGE.configuredStorageRoot),
    env: RUNTIME_STORAGE.configuredStorageEnv,
    external: RUNTIME_STORAGE.usesExternalStorage,
    directories,
    disk: disk ? {
      totalBytes: disk.totalBytes,
      usedBytes: disk.usedBytes,
      freeBytes: disk.freeBytes,
      usageRatio: disk.usageRatio,
    } : null,
  };
}

function buildPythonEnv(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const pythonPaths = [PYTHON_VENDOR_SITE, env.PYTHONPATH].filter(Boolean);
  env.PYTHONPATH = pythonPaths.join(path.delimiter);
  env.PYTHONUTF8 = env.PYTHONUTF8 || '1';
  env.PYTHONIOENCODING = env.PYTHONIOENCODING || 'utf-8';
  env.PYTHONNOUSERSITE = env.PYTHONNOUSERSITE || '1';
  if (IS_WINDOWS) {
    env.PYTHONLEGACYWINDOWSSTDIO = env.PYTHONLEGACYWINDOWSSTDIO || '1';
  }
  return env;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function requiresExplicitUploadPasswordEnv(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  const cloudstudioEnv = String(env.CLOUDSTUDIO_ENV || '').trim().toLowerCase();
  return isTruthyEnv(env.CLOUDSTUDIO_REQUIRE_UPLOAD_PASSWORD_ENV)
    || ['production', 'staging'].includes(nodeEnv)
    || ['production', 'staging'].includes(cloudstudioEnv);
}

function resolveUploadPasswordHash(env = process.env) {
  const configured = String(env.UPLOAD_REVIEW_PASSWORD_SHA256 || '').trim().toLowerCase();
  if (configured) return configured;
  return requiresExplicitUploadPasswordEnv(env) ? '' : DEFAULT_UPLOAD_PASSWORD_SHA256;
}

function verifyUploadPassword(rawPassword, passwordHash = UPLOAD_PASSWORD_SHA256) {
  const normalizedPasswordHash = String(passwordHash || '').trim().toLowerCase();
  if (!normalizedPasswordHash) {
    const error = new Error('Upload password not configured on server');
    error.code = 'UPLOAD_PASSWORD_NOT_CONFIGURED';
    throw error;
  }

  if (!String(rawPassword || '').trim()) {
    const error = new Error('Upload password required');
    error.code = 'UPLOAD_PASSWORD_REQUIRED';
    throw error;
  }

  if (sha256Hex(rawPassword).toLowerCase() !== normalizedPasswordHash) {
    const error = new Error('Wrong password');
    error.code = 'WRONG_PASSWORD';
    throw error;
  }
}

function firstNonEmptyValue(values = []) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstNonEmptyValue(value);
      if (nested) return nested;
      continue;
    }
    const normalized = String(value || '').trim();
    if (normalized) return normalized;
  }
  return '';
}

function getUploadPasswordCandidate(req, { includeBody = true } = {}) {
  const headerPassword = firstNonEmptyValue([
    req?.headers?.['x-cloudstudio-upload-password'],
    req?.headers?.['x-upload-password'],
    req?.headers?.['x-upload-token'],
  ]);
  if (headerPassword) {
    return { source: 'header', value: headerPassword };
  }

  const queryPassword = firstNonEmptyValue([
    req?.query?.uploadPassword,
    req?.query?.password,
  ]);
  if (queryPassword) {
    return { source: 'query', value: queryPassword };
  }

  if (includeBody) {
    const bodyPassword = firstNonEmptyValue([
      req?.body?.uploadPassword,
      req?.body?.password,
    ]);
    if (bodyPassword) {
      return { source: 'body', value: bodyPassword };
    }
  }

  return null;
}

function verifyUploadCredentialFromRequest(req, { includeBody = true } = {}) {
  const candidate = getUploadPasswordCandidate(req, { includeBody });
  verifyUploadPassword(candidate?.value);
  return candidate;
}

function verifyPreMulterUploadCredential(req) {
  const candidate = getUploadPasswordCandidate(req, { includeBody: false });
  verifyUploadPassword(candidate?.value);
  return candidate;
}

function uploadCredentialPrecheck(req, res, next) {
  try {
    verifyPreMulterUploadCredential(req);
    return next();
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }
}

function uploadCredentialJsonPrecheck(req, res, next) {
  try {
    verifyUploadCredentialFromRequest(req);
    return next();
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }
}

function canRunCommand(command, args = ['--version']) {
  if (!command) return false;
  try {
    const result = spawnSync(command, args, {
      cwd: __dirname,
      env: buildPythonEnv(),
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function canRunPythonModules(command, modules = []) {
  if (!command) return false;
  const quotedModules = JSON.stringify(modules);
  const probe = [
    '-c',
    `import importlib.util, sys; modules = ${quotedModules}; missing = [m for m in modules if importlib.util.find_spec(m) is None]; sys.exit(0 if not missing else 1)`,
  ];
  return canRunCommand(command, probe);
}

function runCommandSync(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: __dirname,
    encoding: 'utf8',
    env: buildPythonEnv(options.env),
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

function resolveFirstExistingPath(candidates = []) {
  const filtered = candidates.filter(Boolean);
  return filtered.find(pathExists) || filtered[0] || null;
}

function resolveFirstRunnableCommand(candidates = [], args = ['--version']) {
  const filtered = candidates.filter(Boolean);
  return filtered.find(candidate => {
    if (pathExists(candidate)) {
      return canRunCommand(candidate, args);
    }
    if (!candidate.includes(path.sep) && !candidate.includes('/')) {
      return canRunCommand(candidate, args);
    }
    return false;
  }) || filtered[0] || null;
}

function getDefaultScanRootCandidates() {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return IS_WINDOWS
    ? [
        path.join(homeDir, 'Desktop', 'AI', 'MVPS1'),
        path.join(homeDir, 'Desktop', 'AI'),
      ]
    : [
        path.join(homeDir || '/Users/yangqi', 'Desktop', 'AI', 'MVPS1'),
        path.join(homeDir || '/Users/yangqi', 'Desktop', 'AI'),
      ];
}

function getDefaultScanRoots() {
  return getDefaultScanRootCandidates().filter(p => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

function resolvePythonBin() {
  const moduleProbe = ['numpy', 'laspy', 'pyproj', 'lazrs'];
  const candidates = [
    process.env.PYTHON_BIN,
    path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
    path.join(__dirname, '.venv', 'bin', 'python'),
    'python',
  ].filter(Boolean);

  return candidates.find(candidate => {
    if (pathExists(candidate) || (!candidate.includes(path.sep) && !candidate.includes('/'))) {
      return canRunPythonModules(candidate, moduleProbe);
    }
    return false;
  }) || resolveFirstRunnableCommand(candidates);
}

function resolveSystemPythonBin() {
  return resolveFirstRunnableCommand([
    process.env.PYTHON3_BIN,
    IS_WINDOWS ? 'python' : 'python3',
    'python',
  ]);
}

function resolveConverterPath() {
  const candidates = IS_WINDOWS
    ? [
        process.env.CONVERTER_PATH,
        path.join(ROOT, 'PotreeConverter', 'build-gcc', 'PotreeConverter.exe'),
        path.join(ROOT, 'PotreeConverter', 'PotreeConverter.exe'),
        path.resolve(ROOT, '..', 'PotreeConverter', 'build-gcc', 'PotreeConverter.exe'),
        path.resolve(ROOT, '..', 'PotreeConverter', 'PotreeConverter.exe'),
        path.resolve(ROOT, '..', '..', 'PotreeConverter', 'build-gcc', 'PotreeConverter.exe'),
      ]
    : [
        process.env.CONVERTER_PATH,
        path.join(ROOT, 'PotreeConverter', 'build-gcc', 'PotreeConverter'),
        path.resolve(ROOT, '..', 'PotreeConverter', 'build-gcc', 'PotreeConverter'),
        path.resolve(ROOT, '..', '..', 'PotreeConverter', 'build-gcc', 'PotreeConverter'),
        '/Users/yangqi/.openclaw/workspace/potree-local/PotreeConverter/build-gcc/PotreeConverter',
      ];

  return resolveFirstExistingPath(candidates);
}

function resolvePowerShellCommand() {
  if (!IS_WINDOWS) return null;
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell',
  ];
  return resolveFirstRunnableCommand(candidates, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
}

const CONVERTER = resolveConverterPath();
const STORAGE_ROOT = RUNTIME_STORAGE.storageRoot;
const UPLOADS_DIR = RUNTIME_STORAGE.uploads.primary;
const POINTCLOUDS_DIR = RUNTIME_STORAGE.pointclouds.primary;
const GAUSSIANS_DIR = RUNTIME_STORAGE.gaussians.primary;
const PROJECTS_DIR = RUNTIME_STORAGE.projects.primary;   // Uploaded scanner project folders
const EXPORTS_DIR = RUNTIME_STORAGE.exports.primary;
const ASSETS_DIR = path.join(__dirname, 'assets');
const CACHE_DIR = RUNTIME_STORAGE.cache.primary;
const GRID_STORAGE_DIR = RUNTIME_STORAGE.gridStorage.primary;
const CRS_BOOTSTRAP_FILE = path.join(ASSETS_DIR, 'crs', 'bootstrap.json');
const CRS_CACHE_FILE = path.join(CACHE_DIR, 'crs-cache.json');
const GRID_REGISTRY_FILE = path.join(CACHE_DIR, 'grid-registry.json');
const GRID_CATALOG_FILE = path.join(ASSETS_DIR, 'grids', 'catalog.json');
const GAUSSIAN_EDITOR_VERSION = 'cloudstudio-browse-20260505-4';
const EXPORT_POINTCLOUD_SCRIPT = path.join(__dirname, 'scripts', 'export_pointcloud.py');
const FLOORPLAN_EXTRACT_SCRIPT = path.join(__dirname, 'scripts', 'extract_floorplan.py');
const GRID_PROBE_SCRIPT = path.join(__dirname, 'scripts', 'grid_probe.py');
const CRS_TRANSFORM_SCRIPT = path.join(__dirname, 'scripts', 'transform_coords.py');
const LOCAL_IMPORTS_FILE = path.join(CACHE_DIR, 'desktop-local-imports.json');
const PYTHON_BIN = process.env.PYTHON_BIN || (IS_WINDOWS ? path.join(__dirname, '.venv', 'Scripts', 'python.exe') : path.join(__dirname, '.venv', 'bin', 'python'));
const SYSTEM_PYTHON_BIN = process.env.PYTHON3_BIN || (IS_WINDOWS ? 'python' : 'python3');
const EFFECTIVE_TERRAIN_PYTHON_BIN = PYTHON_BIN;
const POWERSHELL_BIN = null;

ensureRuntimeStorageLayout(RUNTIME_STORAGE);

for (const d of [PYTHON_VENDOR_SITE].filter(Boolean)) {
  fs.mkdirSync(d, { recursive: true });
}

function splitPathListEnv(value) {
  return String(value || '')
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
}

function uniqResolvedPaths(paths = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const key = IS_WINDOWS ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function resolveRealPathForBoundary(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isPathWithinRoot(candidatePath, rootPath) {
  if (!candidatePath || !rootPath) return false;
  const candidate = resolveRealPathForBoundary(candidatePath);
  const root = resolveRealPathForBoundary(rootPath);
  const normalizedCandidate = IS_WINDOWS ? candidate.toLowerCase() : candidate;
  const normalizedRoot = IS_WINDOWS ? root.toLowerCase() : root;
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getConfiguredProjectBoundaryRoots() {
  return [
    ...splitPathListEnv(process.env.CLOUDSTUDIO_ALLOWED_PROJECT_ROOTS),
    ...splitPathListEnv(process.env.CLOUDSTUDIO_ALLOWED_LOCAL_ROOTS),
  ];
}

function getRuntimeBoundaryRoots() {
  return uniqResolvedPaths([
    ...RUNTIME_STORAGE.uploads.candidates,
    ...RUNTIME_STORAGE.pointclouds.candidates,
    ...RUNTIME_STORAGE.gaussians.candidates,
    ...RUNTIME_STORAGE.projects.candidates,
    ...RUNTIME_STORAGE.exports.candidates,
    ...RUNTIME_STORAGE.cache.candidates,
    ...RUNTIME_STORAGE.gridStorage.candidates,
    path.join(ASSETS_DIR, 'grids', 'builtin'),
    path.join(__dirname, 'dtm_jobs'),
    path.join(__dirname, 'floorplan_jobs'),
    path.join(__dirname, 'surface_jobs'),
    path.join(__dirname, 'volume_surface_jobs'),
    path.join(__dirname, 'volume_jobs'),
    path.join(__dirname, 'contour_jobs'),
  ]);
}

function getProjectBoundaryRoots({ includeScanRoots = true } = {}) {
  const localImportRoots = [];
  try {
    for (const entry of listLocalImportEntries()) {
      if (entry?.dirPath) localImportRoots.push(entry.dirPath);
      if (entry?.originalPath) localImportRoots.push(path.dirname(entry.originalPath));
      if (entry?.metadataPath) localImportRoots.push(path.dirname(entry.metadataPath));
    }
  } catch { }

  return uniqResolvedPaths([
    ...RUNTIME_STORAGE.projects.candidates,
    ...getDefaultScanRootCandidates(),
    ...getConfiguredProjectBoundaryRoots(),
    ...(includeScanRoots && Array.isArray(SCAN_PROJECT_ROOTS) ? SCAN_PROJECT_ROOTS : []),
    ...localImportRoots,
  ]);
}

function getCloudStudioBoundaryRoots({ includeScanRoots = true } = {}) {
  return uniqResolvedPaths([
    ...getRuntimeBoundaryRoots(),
    ...getProjectBoundaryRoots({ includeScanRoots }),
  ]);
}

function isPathWithinCloudStudioBounds(candidatePath, options = {}) {
  const roots = options.roots || getCloudStudioBoundaryRoots(options);
  return roots.some(root => isPathWithinRoot(candidatePath, root));
}

function assertPathWithinCloudStudioBounds(candidatePath, {
  fieldName = 'path',
  roots = null,
  includeScanRoots = true,
} = {}) {
  const allowedRoots = roots || getCloudStudioBoundaryRoots({ includeScanRoots });
  if (isPathWithinCloudStudioBounds(candidatePath, { roots: allowedRoots })) {
    return path.resolve(candidatePath);
  }
  const error = new Error(`${fieldName} is outside configured CloudStudio storage/project roots`);
  error.code = 'STORAGE_BOUNDARY_VIOLATION';
  throw error;
}

function ensureExistingBoundedPath(filePath, {
  fieldName = 'path',
  missingCode = 'FILE_NOT_FOUND',
  missingMessage = null,
  type = null,
  roots = null,
  includeScanRoots = true,
} = {}) {
  const normalizedPath = requireNonEmptyString(filePath, fieldName, { code: 'BAD_REQUEST' });
  const absPath = path.resolve(normalizedPath);
  if (!fs.existsSync(absPath)) {
    const error = new Error(missingMessage || `Path not found: ${absPath}`);
    error.code = missingCode;
    throw error;
  }
  const realPath = resolveRealPathForBoundary(absPath);
  assertPathWithinCloudStudioBounds(realPath, { fieldName, roots, includeScanRoots });
  const stats = fs.statSync(realPath);
  if (type === 'file' && !stats.isFile()) {
    const error = new Error(`${fieldName} must be a file`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (type === 'directory' && !stats.isDirectory()) {
    const error = new Error(`${fieldName} must be a directory`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return realPath;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const POINTCLOUD_UPLOAD_EXTENSIONS = new Set(['.las', '.laz']);
const GAUSSIAN_UPLOAD_EXTENSIONS = new Set(['.ply', '.splat', '.ksplat']);
const ZIP_UPLOAD_EXTENSIONS = new Set(['.zip']);
const GRID_UPLOAD_EXTENSIONS = new Set(['.gsb', '.gtx', '.ggf', '.grd', '.tif', '.tiff', '.json', '.csv', '.txt', '.prj', '.wkt']);
const UPLOAD_LIMITS = Object.freeze({
  fileSize: UPLOAD_MAX_BYTES,
  files: 1,
  fields: 20,
  parts: 25,
});
const GRID_UPLOAD_LIMITS = Object.freeze({
  ...UPLOAD_LIMITS,
  fileSize: GRID_UPLOAD_MAX_BYTES,
});

function createUploadFileFilter(allowedByField) {
  return (_req, file, cb) => {
    const allowed = allowedByField[file.fieldname];
    if (!allowed) return cb(null, true);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowed.has(ext)) return cb(null, true);
    const error = new Error(`Unsupported upload file type: ${ext || 'unknown'}`);
    error.code = 'INVALID_UPLOAD_FILE_TYPE';
    return cb(error);
  };
}

const uploadFileFilter = createUploadFileFilter({
  pointcloud: POINTCLOUD_UPLOAD_EXTENSIONS,
  gaussianFile: GAUSSIAN_UPLOAD_EXTENSIONS,
});
const gridFileFilter = createUploadFileFilter({
  gridFile: GRID_UPLOAD_EXTENSIONS,
});
const zipFileFilter = createUploadFileFilter({
  projectzip: ZIP_UPLOAD_EXTENSIONS,
  potreezip: ZIP_UPLOAD_EXTENSIONS,
});

const upload = multer({ storage, limits: UPLOAD_LIMITS, fileFilter: uploadFileFilter });

const gridStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, GRID_STORAGE_DIR),
  filename: (_req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const gridUpload = multer({ storage: gridStorage, limits: GRID_UPLOAD_LIMITS, fileFilter: gridFileFilter });

// Multer config for ZIP project uploads (stored in uploads/ with timestamp prefix)
const zipStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const stamp = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${stamp}_${safe}`);
  }
});
const zipUpload = multer({ storage: zipStorage, limits: UPLOAD_LIMITS, fileFilter: zipFileFilter });

app.use(express.json({ limit: '50mb' }));
function createGuardedStaticFallback(candidates) {
  return createStaticFallbackMiddleware(express, candidates, {
    allowRequest: isSafePublicStaticRequest,
  });
}

function createGuardedStaticDirectory(dirPath) {
  return createGuardedStaticFallback([dirPath]);
}

app.use('/potree', express.static(POTREE_ROOT));
app.use('/pointclouds', createGuardedStaticFallback(RUNTIME_STORAGE.pointclouds.candidates));
app.use('/gaussians', createGuardedStaticFallback(RUNTIME_STORAGE.gaussians.candidates));
app.use('/projects', createGuardedStaticFallback(RUNTIME_STORAGE.projects.candidates));    // serve uploaded project files (photos etc.)
app.use('/exports', createGuardedStaticFallback(RUNTIME_STORAGE.exports.candidates));
app.use('/assets', express.static(ASSETS_DIR));

// ═══════════════════════════════════════════════════════════
// Scanner Project Registry
// ═══════════════════════════════════════════════════════════

// Scanner project directories to scan (user can add more at runtime)
// Read from config file if it exists, otherwise use defaults
const SCAN_ROOTS_CONFIG = path.join(__dirname, 'scan_roots.json');
function loadScanRoots() {
  const defaults = getDefaultScanRoots();

  try {
    if (fs.existsSync(SCAN_ROOTS_CONFIG)) {
      const saved = JSON.parse(fs.readFileSync(SCAN_ROOTS_CONFIG, 'utf-8'));
      if (Array.isArray(saved) && saved.length) {
        // Merge saved roots with defaults, deduplicate
        const merged = [...new Set([...saved, ...defaults])];
        return merged.filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      }
    }
  } catch (e) {
    console.warn('[Scanner] Could not load scan_roots.json:', e.message);
  }
  return defaults;
}

const SCAN_PROJECT_ROOTS = loadScanRoots();
// Always include the runtime project directories in scan roots.
for (const projectDir of RUNTIME_STORAGE.projects.candidates) {
  if (!SCAN_PROJECT_ROOTS.includes(projectDir)) {
    SCAN_PROJECT_ROOTS.push(projectDir);
  }
}
console.log('[Scanner] Scan roots:', SCAN_PROJECT_ROOTS);

// Registry: projectId → absolute path
const scanProjectRegistry = new Map();
const localImportRegistry = new Map();

// Files that indicate a scanner project
const SCANNER_MARKERS = ['odom.csv', 'ImgPose.txt', 'geo_info.csv', 'params.json', 'transforms.json'];
const SCANNER_DIRS = ['converted', 'undistort'];
const SCANNER_LAS_PREFERRED = [
  'colorized.las',
  'colorized.laz',
  'uncolorized.las',
  'uncolorized.laz',
  'scan_resumer.las',
  'scan_resumer.laz',
  'pointcloud.las',
  'pointcloud.laz',
];

function sanitizeNameSegment(value, fallback = 'item') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

function hashStringToBase36(value = '') {
  let hash = 2166136261;
  const input = String(value || '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildStableLocalId(prefix, baseName, sourcePath) {
  return `${sanitizeNameSegment(prefix, prefix)}-${sanitizeNameSegment(baseName, 'item')}-${hashStringToBase36(sourcePath)}`;
}

function loadLocalImportRegistry() {
  localImportRegistry.clear();
  try {
    if (!fs.existsSync(LOCAL_IMPORTS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(LOCAL_IMPORTS_FILE, 'utf-8'));
    if (!Array.isArray(raw)) return;
    raw.forEach((entry) => {
      if (!entry || !entry.cloudName || !entry.metadataPath) return;
      if (!fs.existsSync(entry.metadataPath)) return;
      localImportRegistry.set(String(entry.cloudName), entry);
    });
  } catch (error) {
    console.warn('[DesktopImport] Failed to load local import registry:', error.message);
  }
}

function saveLocalImportRegistry() {
  try {
    fs.writeFileSync(LOCAL_IMPORTS_FILE, JSON.stringify(Array.from(localImportRegistry.values()), null, 2));
  } catch (error) {
    console.warn('[DesktopImport] Failed to save local import registry:', error.message);
  }
}

function listLocalImportEntries() {
  return Array.from(localImportRegistry.values());
}

function getLocalImportEntry(cloudName) {
  if (!localImportRegistry.size && fs.existsSync(LOCAL_IMPORTS_FILE)) {
    loadLocalImportRegistry();
  }
  return localImportRegistry.get(String(cloudName || '')) || null;
}

function upsertLocalImportEntry(entry) {
  localImportRegistry.set(entry.cloudName, entry);
  saveLocalImportRegistry();
  return entry;
}

function removeLocalImportEntry(cloudName) {
  const removed = localImportRegistry.get(cloudName) || null;
  if (removed) {
    localImportRegistry.delete(cloudName);
    saveLocalImportRegistry();
  }
  return removed;
}

function buildLocalPointcloudMetadataUrl(cloudName) {
  return `/local-pointclouds/${encodeURIComponent(cloudName)}/metadata.json`;
}

function isLikelyScannerProject(features = {}) {
  return Boolean(
    features.hasOdom ||
    features.hasCameras ||
    features.hasGeo ||
    features.hasPhotos ||
    features.hasParams ||
    features.hasTransforms ||
    features.hasPotree ||
    features.hasColorizedLas ||
    features.hasUncolorizedLas ||
    features.hasScanLas
  );
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

loadLocalImportRegistry();

let bootstrapCrsRegistry = null;
let diskCrsCacheLoaded = false;
let diskCrsCache = {};
const memoryCrsCache = new Map();
let gridCatalog = null;
let gridRegistryLoaded = false;
let gridRegistry = {};

function readJsonFileSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.warn(`[CRS] Failed to read JSON file ${filePath}:`, error.message);
    return fallback;
  }
}

function normalizeAuthorityCode(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    const error = new Error('CRS code is required.');
    error.code = 'CRS_BAD_CODE';
    throw error;
  }

  if (/^\d+$/.test(raw)) {
    const code = Number(raw);
    return { normalizedCode: `EPSG:${code}`, authority: 'EPSG', code };
  }

  const match = /^([A-Za-z]+)\s*:\s*(\d+)$/.exec(raw);
  if (!match) {
    const error = new Error(`Invalid CRS code: ${raw}`);
    error.code = 'CRS_BAD_CODE';
    throw error;
  }

  const authority = match[1].toUpperCase();
  if (!['EPSG', 'ESRI'].includes(authority)) {
    const error = new Error(`Unsupported CRS authority: ${authority}`);
    error.code = 'CRS_UNSUPPORTED_AUTHORITY';
    throw error;
  }

  const code = Number(match[2]);
  return { normalizedCode: `${authority}:${code}`, authority, code };
}

function loadBootstrapCrsRegistry() {
  if (bootstrapCrsRegistry) return bootstrapCrsRegistry;
  bootstrapCrsRegistry = readJsonFileSafe(CRS_BOOTSTRAP_FILE, {}) || {};
  return bootstrapCrsRegistry;
}

function loadDiskCrsCache() {
  if (diskCrsCacheLoaded) return diskCrsCache;
  diskCrsCacheLoaded = true;
  diskCrsCache = readJsonFileSafe(CRS_CACHE_FILE, {}) || {};
  return diskCrsCache;
}

function saveDiskCrsCache() {
  try {
    fs.writeFileSync(CRS_CACHE_FILE, JSON.stringify(diskCrsCache, null, 2));
  } catch (error) {
    console.warn('[CRS] Failed to save CRS cache:', error.message);
  }
}

function loadGridCatalog() {
  if (gridCatalog) return gridCatalog;
  const raw = readJsonFileSafe(GRID_CATALOG_FILE, []);
  gridCatalog = Array.isArray(raw) ? raw : [];
  return gridCatalog;
}

function loadGridRegistry() {
  if (gridRegistryLoaded) return gridRegistry;
  gridRegistryLoaded = true;
  gridRegistry = readJsonFileSafe(GRID_REGISTRY_FILE, {}) || {};
  return gridRegistry;
}

function saveGridRegistry() {
  try {
    fs.writeFileSync(GRID_REGISTRY_FILE, JSON.stringify(gridRegistry, null, 2));
  } catch (error) {
    console.warn('[Grid] Failed to save grid registry:', error.message);
  }
}

function sanitizeGridRecordForClient(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    originalName: record.originalName || record.name,
    ext: record.ext,
    sizeBytes: record.sizeBytes,
    sizeLabel: formatBytes(record.sizeBytes || 0),
    storedFileName: record.storedFileName || null,
    usageHint: record.usageHint || null,
    capabilities: Array.isArray(record.capabilities) ? record.capabilities : [],
    primaryCapability: record.primaryCapability || null,
    browserCompatible: Boolean(record.browserCompatible),
    sourceType: record.sourceType || 'upload',
    scope: record.scope || null,
    regions: Array.isArray(record.regions) ? record.regions : [],
    note: record.note || '',
    validationNote: record.validationNote || '',
    catalogId: record.catalogId || null,
    installedAt: record.installedAt || null,
  };
}

function buildGridRecordId(baseName = 'grid') {
  const safe = String(baseName || 'grid')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${safe || 'grid'}-${Date.now()}`;
}

function buildGridStoredFileName(originalName = 'grid') {
  const stamp = Date.now();
  const safe = String(originalName || 'grid').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${stamp}_${safe}`;
}

function runPythonJson(scriptPath, args = [], options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [scriptPath, ...args], { cwd: __dirname, env: buildPythonEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      fn(value);
    };

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { }
        const error = new Error(`Python script timed out after ${timeoutMs}ms`);
        error.code = 'PYTHON_TIMEOUT';
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
      }, timeoutMs);
    }

    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => finish(reject, error));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        const combined = [stderr, stdout].filter(Boolean).join('\n');
        let message = combined.trim() || `Python script failed (${code})`;
        const lines = combined.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const lastJson = [...lines].reverse().find(line => line.startsWith('{') && line.endsWith('}'));
        if (lastJson) {
          try {
            const parsed = JSON.parse(lastJson);
            if (parsed?.error) message = parsed.error;
          } catch { }
        }
        const error = new Error(message);
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
        return;
      }
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      const lastJson = [...lines].reverse().find(line => line.startsWith('{') && line.endsWith('}'));
      if (!lastJson) {
        const error = new Error('Python script did not return JSON output.');
        error.stdout = stdout;
        error.stderr = stderr;
        finish(reject, error);
        return;
      }
      try {
        finish(resolve, JSON.parse(lastJson));
      } catch (parseError) {
        parseError.stdout = stdout;
        parseError.stderr = stderr;
        finish(reject, parseError);
      }
    });
  });
}

async function probeGridFile(filePath) {
  const result = await runPythonJson(GRID_PROBE_SCRIPT, ['--path', filePath], { timeoutMs: 15000 });
  if (!result?.ok) {
    const error = new Error(result?.error || 'Grid validation failed.');
    error.code = 'GRID_VALIDATION_FAILED';
    throw error;
  }
  return result;
}

function createGridRecordFromProbe({
  probe,
  absPath,
  originalName,
  storedFileName,
  sourceType = 'upload',
  scope = 'custom',
  note = 'Imported by user.',
}) {
  const resolvedOriginalName = originalName || storedFileName || path.basename(absPath);
  return {
    id: buildGridRecordId(path.parse(resolvedOriginalName).name),
    name: resolvedOriginalName,
    originalName: resolvedOriginalName,
    storedFileName: storedFileName || path.basename(absPath),
    absPath,
    ext: probe.ext || path.extname(resolvedOriginalName).slice(1).toLowerCase(),
    sizeBytes: probe.sizeBytes || safeStat(absPath)?.size || 0,
    usageHint: probe.usageHint || null,
    capabilities: probe.capabilities || [],
    primaryCapability: probe.primaryCapability || null,
    browserCompatible: Boolean(probe.browserCompatible),
    sourceType,
    scope,
    regions: [],
    note,
    validationNote: probe.note || '',
    catalogId: null,
    installedAt: new Date().toISOString(),
  };
}

async function registerGridFilePath({
  absPath,
  originalName,
  storedFileName,
  sourceType = 'upload',
  scope = 'custom',
  note = 'Imported by user.',
}) {
  const probe = await probeGridFile(absPath);
  loadGridRegistry();
  const record = createGridRecordFromProbe({
    probe,
    absPath,
    originalName,
    storedFileName,
    sourceType,
    scope,
    note,
  });
  gridRegistry[record.id] = record;
  saveGridRegistry();
  return record;
}

function copyGridFileToStorage(sourcePath, originalName = path.basename(sourcePath)) {
  const storedFileName = buildGridStoredFileName(originalName);
  const storedPath = path.join(GRID_STORAGE_DIR, storedFileName);
  fs.copyFileSync(sourcePath, storedPath);
  return { storedPath, storedFileName };
}

async function ensureBuiltinGridsRegistered() {
  loadGridRegistry();
  const catalog = loadGridCatalog();
  let changed = false;
  for (const entry of catalog) {
    const localFile = entry?.localFile ? path.join(ASSETS_DIR, 'grids', entry.localFile) : null;
    if (!localFile || !fs.existsSync(localFile)) continue;
    if (gridRegistry[entry.id]) continue;
    // macOS local validation of the bundled Germany GTX grid is unreliable in this environment.
    // Skip eager registration here so the rest of the built-in catalog remains responsive.
    if (process.platform === 'darwin' && entry?.id === 'builtin-de-gcg2016v2023') continue;
    try {
      const probe = await probeGridFile(localFile);
      gridRegistry[entry.id] = {
        id: entry.id,
        name: entry.name || path.basename(localFile),
        originalName: path.basename(localFile),
        storedFileName: path.basename(localFile),
        absPath: localFile,
        ext: probe.ext || path.extname(localFile).slice(1).toLowerCase(),
        sizeBytes: probe.sizeBytes || (safeStat(localFile)?.size ?? 0),
        usageHint: entry.usageHint || probe.usageHint || null,
        capabilities: probe.capabilities || [],
        primaryCapability: probe.primaryCapability || null,
        browserCompatible: Boolean(probe.browserCompatible),
        sourceType: 'builtin-local',
        scope: entry.scope || null,
        regions: Array.isArray(entry.regions) ? entry.regions : [],
        note: entry.description || probe.note || '',
        validationNote: probe.note || '',
        catalogId: entry.id,
        installedAt: new Date().toISOString(),
      };
      changed = true;
    } catch (error) {
      console.warn(`[Grid] Failed to register built-in grid ${entry.id}:`, error.message);
    }
  }
  if (changed) saveGridRegistry();
}

function parseProjParam(proj4Text, key) {
  const match = String(proj4Text || '').match(new RegExp(`\\+${key}=([^\\s]+)`, 'i'));
  return match ? match[1] : null;
}

function parseProjNumber(proj4Text, key) {
  const value = parseProjParam(proj4Text, key);
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

const ELLIPSOID_PARAMS = Object.freeze({
  WGS84: { name: 'WGS 84', semiMajorAxis: 6378137, inverseFlattening: 298.257223563 },
  GRS80: { name: 'GRS 1980', semiMajorAxis: 6378137, inverseFlattening: 298.257222101 },
  intl: { name: 'International 1924', semiMajorAxis: 6378388, inverseFlattening: 297 },
  bessel: { name: 'Bessel 1841', semiMajorAxis: 6377397.155, inverseFlattening: 299.1528128 },
  clrk66: { name: 'Clarke 1866', semiMajorAxis: 6378206.4, inverseFlattening: 294.9786982 },
  airy: { name: 'Airy 1830', semiMajorAxis: 6377563.396, inverseFlattening: 299.3249646 },
  sphere: { name: 'Sphere', semiMajorAxis: 6370997, inverseFlattening: 0 },
});

function deriveSemiMinorAxis(semiMajorAxis, inverseFlattening) {
  if (!Number.isFinite(semiMajorAxis) || !Number.isFinite(inverseFlattening) || inverseFlattening === 0) return null;
  return semiMajorAxis * (1 - 1 / inverseFlattening);
}

function summarizeUnitName(unit) {
  if (!unit) return null;
  if (typeof unit === 'string') {
    const normalized = unit.toLowerCase();
    if (normalized === 'metre' || normalized === 'meter') return 'm';
    if (normalized === 'degree') return 'deg';
    return unit;
  }
  const name = String(unit.name || '').toLowerCase();
  if (name === 'metre' || name === 'meter') return 'm';
  if (name === 'degree') return 'deg';
  if (name === 'us survey foot') return 'us-ft';
  if (name === 'foot') return 'ft';
  return unit.name || null;
}

function getParameterValue(parameters, names = []) {
  if (!Array.isArray(parameters)) return null;
  const match = parameters.find((entry) => names.includes(entry?.name));
  return match?.value ?? null;
}

function extractCrsSummary(projJson, proj4Text = '') {
  const base = projJson?.base_crs || null;
  const datum = base?.datum?.name || base?.datum_ensemble?.name || base?.name || null;
  const ellipsoid = base?.datum?.ellipsoid || base?.datum_ensemble?.ellipsoid || null;
  const parameters = projJson?.conversion?.parameters || [];
  const axisUnit = projJson?.coordinate_system?.axis?.[0]?.unit || null;
  const projKind = String(projJson?.type || '').toLowerCase();
  const kind = projKind.includes('projected') ? 'projected' : (projKind.includes('geographic') ? 'geographic' : null);
  const summary = {
    kind,
    projectionMethod: projJson?.conversion?.method?.name || null,
    units: summarizeUnitName(axisUnit) || parseProjParam(proj4Text, 'units') || null,
    datum,
    ellipsoid: ellipsoid?.name || null,
    semiMajorAxis: ellipsoid?.semi_major_axis ?? parseProjNumber(proj4Text, 'a'),
    inverseFlattening: ellipsoid?.inverse_flattening ?? parseProjNumber(proj4Text, 'rf'),
    semiMinorAxis: ellipsoid?.semi_minor_axis
      ?? parseProjNumber(proj4Text, 'b')
      ?? deriveSemiMinorAxis(ellipsoid?.semi_major_axis ?? parseProjNumber(proj4Text, 'a'), ellipsoid?.inverse_flattening ?? parseProjNumber(proj4Text, 'rf')),
    centralMeridian: getParameterValue(parameters, ['Longitude of false origin', 'Longitude of natural origin', 'Central meridian', 'Longitude of origin'])
      ?? parseProjNumber(proj4Text, 'lon_0'),
    latitudeOfOrigin: getParameterValue(parameters, ['Latitude of false origin', 'Latitude of natural origin', 'Latitude of origin'])
      ?? parseProjNumber(proj4Text, 'lat_0'),
    scaleFactor: getParameterValue(parameters, ['Scale factor at natural origin', 'Scale factor on initial line', 'Scale factor at central meridian'])
      ?? parseProjNumber(proj4Text, 'k_0')
      ?? parseProjNumber(proj4Text, 'k'),
    falseEasting: getParameterValue(parameters, ['Easting at false origin', 'False easting', 'Easting at projection centre'])
      ?? parseProjNumber(proj4Text, 'x_0'),
    falseNorthing: getParameterValue(parameters, ['Northing at false origin', 'False northing', 'Northing at projection centre'])
      ?? parseProjNumber(proj4Text, 'y_0'),
    standardParallel1: getParameterValue(parameters, ['Latitude of 1st standard parallel', 'Latitude of standard parallel'])
      ?? parseProjNumber(proj4Text, 'lat_1'),
    standardParallel2: getParameterValue(parameters, ['Latitude of 2nd standard parallel'])
      ?? parseProjNumber(proj4Text, 'lat_2'),
    grid: parseProjParam(proj4Text, 'nadgrids'),
    towgs84: parseProjParam(proj4Text, 'towgs84'),
  };
  return summary;
}

function extractSummaryFromProj4(proj4Text = '') {
  const projName = parseProjParam(proj4Text, 'proj');
  const ellpsCode = parseProjParam(proj4Text, 'ellps');
  const datumCode = parseProjParam(proj4Text, 'datum');
  const ellpsFromDatum = datumCode ? ({
    wgs84: ELLIPSOID_PARAMS.WGS84,
    nad83: ELLIPSOID_PARAMS.GRS80,
    etrs89: ELLIPSOID_PARAMS.GRS80,
  }[String(datumCode).toLowerCase()] || null) : null;
  const ellps = ellpsCode ? ELLIPSOID_PARAMS[ellpsCode] || null : ellpsFromDatum;
  const zone = parseProjNumber(proj4Text, 'zone');
  const isUtmSouth = /\+south(?:\s|$)/i.test(proj4Text);
  const projectionMethod = {
    lcc: 'Lambert Conic Conformal (2SP)',
    utm: 'Universal Transverse Mercator',
    tmerc: 'Transverse Mercator',
    merc: 'Mercator',
    stere: 'Polar Stereographic',
    omerc: 'Hotine Oblique Mercator',
    somerc: 'Swiss Oblique Mercator',
    laea: 'Lambert Azimuthal Equal Area',
    }[projName] || null;
    const semiMajorAxis = parseProjNumber(proj4Text, 'a') ?? ellps?.semiMajorAxis ?? null;
    const inverseFlattening = parseProjNumber(proj4Text, 'rf') ?? ellps?.inverseFlattening ?? null;
    return {
      kind: projName === 'longlat' ? 'geographic' : 'projected',
      projectionMethod,
      units: parseProjParam(proj4Text, 'units') || (projName === 'longlat' ? 'deg' : null),
      datum: datumCode || null,
      ellipsoid: ellps?.name || ellpsCode || null,
    semiMajorAxis,
    inverseFlattening,
    semiMinorAxis: parseProjNumber(proj4Text, 'b') ?? deriveSemiMinorAxis(semiMajorAxis, inverseFlattening),
    centralMeridian: parseProjNumber(proj4Text, 'lon_0') ?? (projName === 'utm' && Number.isFinite(zone) ? zone * 6 - 183 : null),
    latitudeOfOrigin: parseProjNumber(proj4Text, 'lat_0') ?? (projName === 'utm' ? 0 : null),
    scaleFactor: parseProjNumber(proj4Text, 'k_0') ?? parseProjNumber(proj4Text, 'k') ?? (projName === 'utm' ? 0.9996 : null),
    falseEasting: parseProjNumber(proj4Text, 'x_0') ?? (projName === 'utm' ? 500000 : null),
    falseNorthing: parseProjNumber(proj4Text, 'y_0') ?? (projName === 'utm' ? (isUtmSouth ? 10000000 : 0) : null),
    standardParallel1: parseProjNumber(proj4Text, 'lat_1'),
    standardParallel2: parseProjNumber(proj4Text, 'lat_2'),
    grid: parseProjParam(proj4Text, 'nadgrids'),
    towgs84: parseProjParam(proj4Text, 'towgs84'),
  };
}

function mergeCrsSummary(summary = null, proj4Text = '') {
  const extracted = extractSummaryFromProj4(proj4Text);
  if (!summary || typeof summary !== 'object') return extracted;
  const merged = { ...extracted };
  Object.entries(summary).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      merged[key] = value;
    }
  });
  return merged;
}

function normalizeResolvedCrsRecord(record, normalizedCode, fallbackSource = { type: 'unknown', provider: 'local' }) {
  const normalized = normalizeAuthorityCode(normalizedCode);
  const summary = mergeCrsSummary(record?.summary || null, record?.proj4 || '');
  if (!summary.units && summary.kind === 'geographic') summary.units = 'deg';
  if (!summary.datum && summary.kind === 'geographic' && record?.name) summary.datum = record.name;
  return {
    normalizedCode: normalized.normalizedCode,
    authority: normalized.authority,
    code: normalized.code,
    name: record?.name || normalized.normalizedCode,
    proj4: String(record?.proj4 || '').trim(),
    projJson: record?.projJson || null,
    summary,
    source: record?.source || fallbackSource,
  };
}

const DEFAULT_SOURCE_GEODETIC_CODE = 'EPSG:4326';
const SOURCE_GEODETIC_ALIASES = Object.freeze({
  'wgs84': DEFAULT_SOURCE_GEODETIC_CODE,
  'wgs 84': DEFAULT_SOURCE_GEODETIC_CODE,
  'epsg 4326': DEFAULT_SOURCE_GEODETIC_CODE,
  'epsg4326': DEFAULT_SOURCE_GEODETIC_CODE,
  '4326': DEFAULT_SOURCE_GEODETIC_CODE,
  'etrs89': 'EPSG:4258',
  'epsg 4258': 'EPSG:4258',
  'epsg4258': 'EPSG:4258',
  '4258': 'EPSG:4258',
  'nad83': 'EPSG:4269',
  'epsg 4269': 'EPSG:4269',
  'epsg4269': 'EPSG:4269',
  '4269': 'EPSG:4269',
  'grs80': 'EPSG:4258',
});
const SOURCE_GEODETIC_3D_HINTS = Object.freeze({
  'EPSG:4326': 'EPSG:4979',
  'EPSG:4258': 'EPSG:4937',
});

function normalizeSourceGeodeticQuery(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_:]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isGeographicCrsRecord(record) {
  return String(record?.summary?.kind || '').toLowerCase() === 'geographic';
}

function getEllipsoidParamsFromSummary(summary = {}) {
  const a = Number(summary?.semiMajorAxis);
  const rf = Number(summary?.inverseFlattening);
  const b = Number(summary?.semiMinorAxis);
  return {
    semiMajorAxis: Number.isFinite(a) ? a : null,
    inverseFlattening: Number.isFinite(rf) ? rf : null,
    semiMinorAxis: Number.isFinite(b) ? b : null,
  };
}

function buildGeocentricProj4FromSummary(summary = {}) {
  const params = getEllipsoidParamsFromSummary(summary);
  if (!params.semiMajorAxis) return null;
  const parts = ['+proj=geocent', `+a=${params.semiMajorAxis}`];
  if (params.inverseFlattening) parts.push(`+rf=${params.inverseFlattening}`);
  else if (params.semiMinorAxis) parts.push(`+b=${params.semiMinorAxis}`);
  parts.push('+units=m', '+no_defs', '+type=crs');
  return parts.join(' ');
}

function buildSourceGeodeticContext(record, query = '') {
  const normalizedCode = record?.normalizedCode || DEFAULT_SOURCE_GEODETIC_CODE;
  return {
    query: String(query || normalizedCode || DEFAULT_SOURCE_GEODETIC_CODE).trim() || 'WGS84',
    code: normalizedCode,
    name: record?.name || normalizedCode,
    kind: 'geographic',
    proj4: record?.proj4 || normalizedCode,
    summary: record?.summary || null,
    source: record?.source || { type: 'unknown', provider: 'local' },
    geographic3D: {
      code: SOURCE_GEODETIC_3D_HINTS[normalizedCode] || null,
      name: SOURCE_GEODETIC_3D_HINTS[normalizedCode] || null,
    },
    geocentric: {
      proj4: buildGeocentricProj4FromSummary(record?.summary || {}),
    },
  };
}

async function resolveSourceGeodeticDefinition(inputValue, { query = '', allowDefault = true } = {}) {
  const raw = String(inputValue || '').trim();
  const normalizedQuery = normalizeSourceGeodeticQuery(raw);
  let authority = normalizeAuthorityCode(raw);
  if (!authority && normalizedQuery) {
    const aliasCode = SOURCE_GEODETIC_ALIASES[normalizedQuery] || null;
    if (aliasCode) authority = normalizeAuthorityCode(aliasCode);
  }
  if (!authority) {
    if (!normalizedQuery && allowDefault) authority = normalizeAuthorityCode(DEFAULT_SOURCE_GEODETIC_CODE);
    else {
      const error = new Error('Source CRS must be a geographic authority code or supported alias.');
      error.code = 'SOURCE_CRS_BAD_QUERY';
      throw error;
    }
  }
  const record = await resolveCrsDefinition(authority.normalizedCode);
  if (!isGeographicCrsRecord(record)) {
    const error = new Error(`Source CRS must be geographic. ${record.normalizedCode} is ${record?.summary?.kind || 'unsupported'}.`);
    error.code = 'SOURCE_CRS_MUST_BE_GEOGRAPHIC';
    throw error;
  }
  return buildSourceGeodeticContext(record, query || raw || 'WGS84');
}

function listLocalGeographicSearchRecords() {
  const seen = new Map();
  const addRecord = (recordLike, normalizedCode, fallbackSource) => {
    if (!normalizedCode || seen.has(normalizedCode)) return;
    try {
      const record = normalizeResolvedCrsRecord(recordLike, normalizedCode, fallbackSource);
      if (isGeographicCrsRecord(record)) {
        seen.set(normalizedCode, record);
      }
    } catch {
      // Ignore malformed local CRS definitions in search.
    }
  };

  Object.entries(loadBootstrapCrsRegistry() || {}).forEach(([code, record]) => {
    addRecord(record, code, { type: 'bootstrap', provider: 'local' });
  });
  Object.entries(loadDiskCrsCache() || {}).forEach(([code, record]) => {
    addRecord(record, code, { type: 'cache', provider: 'disk' });
  });
  memoryCrsCache.forEach((record, code) => {
    addRecord(record, code, { type: 'cache', provider: 'memory' });
  });
  return Array.from(seen.values());
}

function searchLocalGeographicCrs(query, limit = 8) {
  const normalizedQuery = normalizeSourceGeodeticQuery(query);
  const numericQuery = /^\d+$/.test(String(query || '').trim()) ? `EPSG:${String(query || '').trim()}` : null;
  const aliasCode = SOURCE_GEODETIC_ALIASES[normalizedQuery] || null;
  const candidates = [];
  const pushCandidate = (record, score) => {
    if (!record?.normalizedCode) return;
    const existing = candidates.find(item => item.record.normalizedCode === record.normalizedCode);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      return;
    }
    candidates.push({ record, score });
  };

  listLocalGeographicSearchRecords().forEach(record => {
    const name = String(record.name || '').toLowerCase();
    const code = String(record.normalizedCode || '').toLowerCase();
    let score = 0;
    if (!normalizedQuery) score = 1;
    else if (record.normalizedCode === aliasCode || record.normalizedCode === numericQuery) score = 300;
    else if (code === normalizedQuery.toLowerCase()) score = 280;
    else if (name === normalizedQuery) score = 260;
    else if (code.includes(normalizedQuery)) score = 170;
    else if (name.includes(normalizedQuery)) score = 140;
    if (score > 0) pushCandidate(record, score);
  });

  if (aliasCode && !candidates.find(item => item.record.normalizedCode === aliasCode)) {
    const bootstrap = loadBootstrapCrsRegistry();
    if (bootstrap?.[aliasCode]) {
      pushCandidate(normalizeResolvedCrsRecord(bootstrap[aliasCode], aliasCode, { type: 'bootstrap', provider: 'local' }), 320);
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || String(a.record.name || '').localeCompare(String(b.record.name || '')))
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map(({ record }) => buildSourceGeodeticContext(record, query));
}

function getGeneratedCrsRecord(normalizedCode) {
  const normalized = normalizeAuthorityCode(normalizedCode);
  const match = /^EPSG:(326|327)(\d{2})$/.exec(normalized.normalizedCode);
  if (!match) return null;
  const zone = Number(match[2]);
  if (zone < 1 || zone > 60) return null;
  const south = match[1] === '327';
  const proj4 = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs +type=crs`;
  return normalizeResolvedCrsRecord({
    name: `WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}`,
    proj4,
    summary: {
      kind: 'projected',
      projectionMethod: 'Universal Transverse Mercator',
      units: 'm',
      datum: 'WGS84',
      ellipsoid: 'WGS 84',
      semiMajorAxis: 6378137,
      inverseFlattening: 298.257223563,
      semiMinorAxis: 6356752.314245179,
      centralMeridian: zone * 6 - 183,
      latitudeOfOrigin: 0,
      scaleFactor: 0.9996,
      falseEasting: 500000,
      falseNorthing: south ? 10000000 : 0,
      standardParallel1: null,
      standardParallel2: null,
      grid: null,
      towgs84: null,
    },
    source: { type: 'runtime', provider: 'generated' },
  }, normalized.normalizedCode, { type: 'runtime', provider: 'generated' });
}

async function fetchRemoteText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`Remote CRS lookup failed (${response.status})`);
    error.code = 'CRS_REMOTE_LOOKUP_FAILED';
    throw error;
  }
  return response.text();
}

async function fetchRemoteJson(url) {
  const text = await fetchRemoteText(url);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error(`Remote CRS metadata is not valid JSON for ${url}`);
    parseError.code = 'CRS_INVALID_REMOTE_DEFINITION';
    throw parseError;
  }
}

async function fetchRemoteCrsDefinition(normalizedCode) {
  const normalized = normalizeAuthorityCode(normalizedCode);
  const proj4Text = (await fetchRemoteText(`https://epsg.io/${normalized.code}.proj4`))?.trim();
  if (!proj4Text) {
    const error = new Error(`CRS code ${normalized.normalizedCode} could not be resolved.`);
    error.code = 'CRS_NOT_FOUND';
    throw error;
  }

  const projJson = await fetchRemoteJson(`https://epsg.io/${normalized.code}.json`);
  if (projJson?.id) {
    const remoteAuthority = String(projJson.id.authority || '').toUpperCase();
    const remoteCode = Number(projJson.id.code);
    if (remoteAuthority && (remoteAuthority !== normalized.authority || remoteCode !== normalized.code)) {
      const error = new Error(`Remote CRS metadata for ${normalized.normalizedCode} failed validation.`);
      error.code = 'CRS_INVALID_REMOTE_DEFINITION';
      throw error;
    }
  }

  const summary = projJson ? extractCrsSummary(projJson, proj4Text) : extractSummaryFromProj4(proj4Text);
  return normalizeResolvedCrsRecord({
    name: projJson?.name || normalized.normalizedCode,
    proj4: proj4Text,
    projJson,
    summary,
    source: { type: 'remote', provider: 'epsg.io' },
  }, normalized.normalizedCode, { type: 'remote', provider: 'epsg.io' });
}

async function resolveCrsDefinition(inputCode) {
  const normalized = normalizeAuthorityCode(inputCode);
  if (memoryCrsCache.has(normalized.normalizedCode)) {
    return normalizeResolvedCrsRecord(memoryCrsCache.get(normalized.normalizedCode), normalized.normalizedCode);
  }

  const diskCache = loadDiskCrsCache();
  if (diskCache[normalized.normalizedCode]) {
    const record = normalizeResolvedCrsRecord(diskCache[normalized.normalizedCode], normalized.normalizedCode, { type: 'cache', provider: 'disk' });
    memoryCrsCache.set(normalized.normalizedCode, record);
    return record;
  }

  const bootstrap = loadBootstrapCrsRegistry();
  if (bootstrap[normalized.normalizedCode]) {
    const record = normalizeResolvedCrsRecord(bootstrap[normalized.normalizedCode], normalized.normalizedCode, { type: 'bootstrap', provider: 'local' });
    memoryCrsCache.set(normalized.normalizedCode, record);
    return record;
  }

  const generated = getGeneratedCrsRecord(normalized.normalizedCode);
  if (generated) {
    memoryCrsCache.set(normalized.normalizedCode, generated);
    return generated;
  }

  const remote = await fetchRemoteCrsDefinition(normalized.normalizedCode);
  memoryCrsCache.set(normalized.normalizedCode, remote);
  diskCrsCache[normalized.normalizedCode] = remote;
  saveDiskCrsCache();
  return remote;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function sanitizeDownloadName(name, fallback = 'exported_pointcloud') {
  const base = String(name || fallback).trim().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return (base || fallback).replace(/\.(las|laz|ply|xyz|pts|csv|e57)$/i, '');
}

function summarizeExportProcessError(stdout = '', stderr = '') {
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  if (!combined.trim()) return 'LAS 导出失败';

  const lines = combined.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.error) return parsed.error;
      } catch { }
    }
  }

  const traceLine = lines.find(line => /Traceback|AttributeError|ValueError|RuntimeError|ModuleNotFoundError|TypeError|Error:/i.test(line));
  if (traceLine) return traceLine.replace(/^.*?(AttributeError|ValueError|RuntimeError|ModuleNotFoundError|TypeError|Error:)\s*/i, '$1 ');

  return lines[lines.length - 1];
}

function fileInfoFromAbsolutePath(absPath, rootDir) {
  const stat = safeStat(absPath);
  if (!stat?.isFile()) return null;
  return {
    name: path.basename(absPath),
    relPath: path.relative(rootDir, absPath).split(path.sep).join('/'),
    sizeBytes: stat.size,
    sizeLabel: formatBytes(stat.size),
    ext: path.extname(absPath).toLowerCase(),
  };
}

function getScannerProjectById(projectId) {
  if (!scanProjectRegistry.has(projectId)) discoverScanProjects();
  return scanProjectRegistry.get(projectId) || null;
}

function listScannerSourceFiles(project) {
  if (!project?.dirPath || !fs.existsSync(project.dirPath)) return [];

  const preferred = [
    'colorized.las',
    'colorized.laz',
    'uncolorized.las',
    'uncolorized.laz',
    'scan_resumer.las',
    'scan_resumer.laz',
  ];

  const directFiles = fs.readdirSync(project.dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(las|laz)$/i.test(entry.name))
    .map(entry => path.join(project.dirPath, entry.name));

  const ranked = directFiles.sort((a, b) => {
    const aName = path.basename(a).toLowerCase();
    const bName = path.basename(b).toLowerCase();
    const aIndex = preferred.indexOf(aName);
    const bIndex = preferred.indexOf(bName);
    const aRank = aIndex === -1 ? preferred.length + 1 : aIndex;
    const bRank = bIndex === -1 ? preferred.length + 1 : bIndex;
    if (aRank !== bRank) return aRank - bRank;
    return aName.localeCompare(bName);
  });

  return ranked.map(absPath => fileInfoFromAbsolutePath(absPath, project.dirPath)).filter(Boolean);
}

function readUploadSourceManifest(cloudName) {
  const manifestPath = resolveRuntimePath(RUNTIME_STORAGE.pointclouds.candidates, cloudName, 'source.json');
  if (!manifestPath || !fs.existsSync(manifestPath)) return getLocalImportEntry(cloudName);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return getLocalImportEntry(cloudName);
  }
}

function inferUploadSourceFromLog(cloudName) {
  const logPath = resolveRuntimePath(RUNTIME_STORAGE.pointclouds.candidates, cloudName, 'log.txt');
  if (!logPath || !fs.existsSync(logPath)) return null;
  try {
    const line = fs.readFileSync(logPath, 'utf-8').split(/\r?\n/).find(Boolean) || '';
    const match = line.match(/counting\s+([^,]+),/i);
    if (!match) return null;
    const uploadFilename = path.basename(match[1].trim());
    const uploadPath = resolveRuntimePath(RUNTIME_STORAGE.uploads.candidates, uploadFilename);
    if (!uploadPath || !fs.existsSync(uploadPath)) return null;
    return {
      type: 'upload',
      uploadFilename,
      originalName: uploadFilename.replace(/^\d+_/, ''),
    };
  } catch {
    return null;
  }
}

function getCloudSourceFiles(cloudName) {
  const manifest = readUploadSourceManifest(cloudName) || inferUploadSourceFromLog(cloudName);
  if (!manifest) return [];
  if (Array.isArray(manifest.sourceFiles) && manifest.sourceFiles.length) {
    return manifest.sourceFiles.filter(item =>
      item?.absPath
      && fs.existsSync(item.absPath)
      && isPathWithinCloudStudioBounds(item.absPath)
    );
  }
  if (manifest.originalPath && fs.existsSync(manifest.originalPath) && isPathWithinCloudStudioBounds(manifest.originalPath)) {
    return [buildLocalSourceFileInfo(manifest.originalPath)].filter(Boolean);
  }
  if (!manifest.uploadFilename) return [];
  const uploadPath = resolveRuntimePath(RUNTIME_STORAGE.uploads.candidates, manifest.uploadFilename);
  const info = fileInfoFromAbsolutePath(uploadPath, path.dirname(uploadPath || manifest.uploadFilename));
  if (!info) return [];
  return [{
    ...info,
    absPath: uploadPath,
    originalName: manifest.originalName || info.name,
  }];
}

const API_ERROR_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  CRS_BAD_CODE: 400,
  CRS_INTERNAL_ERROR: 500,
  CRS_UNSUPPORTED_AUTHORITY: 400,
  DELETE_PASSWORD_NOT_CONFIGURED: 500,
  DTM_BAD_JOB_ID: 400,
  DTM_FILE_NOT_FOUND: 404,
  DTM_GRID_NOT_FOUND: 400,
  DTM_INPUT_NOT_FOUND: 400,
  DTM_INVALID_INPUT: 400,
  DTM_JOB_FAILED: 500,
  EXTRACT_FAILED: 500,
  EXTRACT_PARSE_FAILED: 500,
  EXPORT_BAD_REQUEST: 400,
  EXPORT_FAILED: 500,
  FILE_NOT_FOUND: 400,
  GRID_BAD_REQUEST: 400,
  GRID_INTERNAL_ERROR: 500,
  INVALID_FORMAT: 400,
  INVALID_UPLOAD_FILE_TYPE: 400,
  INVALID_POTREE_ZIP: 400,
  LIMIT_FIELD_COUNT: 400,
  LIMIT_FILE_COUNT: 400,
  LIMIT_FILE_SIZE: 413,
  LIMIT_PART_COUNT: 400,
  LAS_NOT_FOUND: 500,
  MISSING_DATASET_CONTEXT: 400,
  MISSING_FILE_PATH: 400,
  MISSING_POINTCLOUD_FILE: 400,
  MISSING_ZIP_FILE: 400,
  NO_SPACE_LEFT: 507,
  NO_EXPORT_SOURCES: 400,
  NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  CRS_NOT_FOUND: 404,
  STORAGE_BOUNDARY_VIOLATION: 403,
  TERRAIN_JOB_FAILED: 500,
  VOLUME_JOB_BUSY: 429,
  VOLUME_SOURCE_TOO_LARGE: 413,
  UPLOAD_PASSWORD_NOT_CONFIGURED: 500,
  UPLOAD_PASSWORD_REQUIRED: 403,
  UNSAFE_ZIP_ENTRY: 400,
  EXPORT_ENV_MISSING: 500,
  EXPORT_SCRIPT_MISSING: 500,
  CONVERTER_NOT_FOUND: 500,
  CONVERSION_FAILED: 500,
  WRONG_PASSWORD: 403,
  ZIP_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
});

function isNoSpaceLeftError(error) {
  const message = String(error?.message || '');
  return error?.code === 'ENOSPC' || /no space left on device/i.test(message);
}

function normalizeApiError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (isNoSpaceLeftError(error)) {
    const wrapped = new Error('磁盘空间不足，无法继续写入上传文件或转换产物。请先清理磁盘空间后重试。');
    wrapped.code = 'NO_SPACE_LEFT';
    wrapped.cause = error;
    return wrapped;
  }
  if (error instanceof Error) return error;
  const wrapped = new Error(String(error || fallbackCode));
  wrapped.code = fallbackCode;
  return wrapped;
}

function sendApiSuccess(res, payload = {}, status = 200) {
  return res.status(status).json({
    ok: true,
    ...payload,
  });
}

function sendApiError(res, error, {
  fallbackCode = 'INTERNAL_ERROR',
  fallbackStatus = 500,
  extra = {},
} = {}) {
  const normalizedError = normalizeApiError(error, fallbackCode);
  const errorCode = normalizedError?.code || fallbackCode;
  const status = API_ERROR_STATUS[errorCode] || fallbackStatus;
  return res.status(status).json({
    ok: false,
    errorCode,
    error: normalizedError?.message || String(normalizedError),
    ...extra,
  });
}

function requireNonEmptyString(value, fieldName, { code = 'BAD_REQUEST' } = {}) {
  const normalized = String(value || '').trim();
  if (normalized) return normalized;
  const error = new Error(`Missing ${fieldName}`);
  error.code = code;
  throw error;
}

function assertDesktopDialogAvailable() {
  if (!IS_DESKTOP_BUILD || !IS_WINDOWS) {
    const error = new Error('Desktop system dialogs are only available in the Windows desktop build.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (!POWERSHELL_BIN) {
    const error = new Error('Windows PowerShell is not available, so the desktop file picker cannot be opened.');
    error.code = 'INTERNAL_ERROR';
    throw error;
  }
}

function normalizeDesktopDialogTarget(target) {
  const normalized = requireNonEmptyString(target, 'target', { code: 'BAD_REQUEST' });
  if (['scan-folder', 'potree-folder', 'las-file', 'mesh-file', 'grid-file'].includes(normalized)) {
    return normalized;
  }
  const error = new Error('Unsupported desktop dialog target.');
  error.code = 'BAD_REQUEST';
  throw error;
}

function buildDesktopDialogScript(target) {
  const commonPrefix = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [Console]::OutputEncoding',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
  ];

  if (target === 'las-file') {
    return [
      ...commonPrefix,
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Title = "Open LAS / LAZ"',
      '$dialog.Filter = "LAS/LAZ Files (*.las;*.laz)|*.las;*.laz"',
      '$dialog.Multiselect = $false',
      '$dialog.RestoreDirectory = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
    ].join('; ');
  }

  if (target === 'mesh-file') {
    return [
      ...commonPrefix,
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Title = "Open Mesh (OBJ)"',
      '$dialog.Filter = "OBJ Files (*.obj)|*.obj"',
      '$dialog.Multiselect = $false',
      '$dialog.RestoreDirectory = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
    ].join('; ');
  }

  if (target === 'grid-file') {
    return [
      ...commonPrefix,
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Title = "Open Grid / Parameter File"',
      '$dialog.Filter = "Grid / Parameter Files (*.gsb;*.gtx;*.ggf;*.grd;*.tif;*.tiff;*.json;*.csv;*.txt;*.prj;*.wkt)|*.gsb;*.gtx;*.ggf;*.grd;*.tif;*.tiff;*.json;*.csv;*.txt;*.prj;*.wkt|All Files (*.*)|*.*"',
      '$dialog.Multiselect = $false',
      '$dialog.RestoreDirectory = $true',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
    ].join('; ');
  }

  const title = target === 'potree-folder' ? 'Open Potree Folder' : 'Open Scanner Folder';
  return [
    ...commonPrefix,
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = "${title}"`,
    '$dialog.ShowNewFolderButton = $false',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
  ].join('; ');
}

function showDesktopOpenDialog(target) {
  assertDesktopDialogAvailable();
  const normalizedTarget = normalizeDesktopDialogTarget(target);
  const script = buildDesktopDialogScript(normalizedTarget);
  const result = runCommandSync(POWERSHELL_BIN, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (result.error) {
    const error = new Error(`Desktop file picker failed: ${result.error.message}`);
    error.code = 'INTERNAL_ERROR';
    throw error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    const error = new Error(`Desktop file picker failed${detail ? `: ${detail}` : '.'}`);
    error.code = 'INTERNAL_ERROR';
    throw error;
  }
  return String(result.stdout || '').trim();
}

function getProjectCrsConfigPath(projectId) {
  const normalizedProjectId = requireNonEmptyString(projectId, 'projectId', { code: 'BAD_REQUEST' });
  const project = getScannerProjectById(normalizedProjectId);
  if (!project?.dirPath) {
    const error = new Error('Project not found');
    error.code = 'PROJECT_NOT_FOUND';
    throw error;
  }
  return {
    project,
    crsFile: path.join(project.dirPath, 'crs_config.json'),
  };
}

function getDatasetContext(input = {}) {
  const projectId = String(input.projectId || '').trim();
  const cloudName = String(input.cloudName || '').trim();

  if (projectId) {
    const project = getScannerProjectById(projectId);
    if (!project) {
      const error = new Error('扫描项目不存在');
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    return {
      type: 'scanner',
      projectId: project.projectId,
      name: project.name,
      dirPath: project.dirPath,
      geoInfoPath: fs.existsSync(path.join(project.dirPath, 'geo_info.csv')) ? path.join(project.dirPath, 'geo_info.csv') : null,
      geoInfoAvailable: Boolean(project.features?.hasGeo),
      sourceFiles: listScannerSourceFiles(project),
    };
  }

  if (cloudName) {
    return {
      type: 'cloud',
      cloudName,
      name: cloudName,
      dirPath: null,
      geoInfoPath: null,
      geoInfoAvailable: false,
      sourceFiles: getCloudSourceFiles(cloudName),
    };
  }

  const error = new Error('缺少 projectId 或 cloudName');
  error.code = 'MISSING_DATASET_CONTEXT';
  throw error;
}

function resolveExportSource(body) {
  const { sourceRelPath } = body || {};
  const datasetContext = getDatasetContext(body);
  const candidates = Array.isArray(datasetContext.sourceFiles) ? datasetContext.sourceFiles : [];
  if (!candidates.length) {
    const error = new Error(datasetContext.type === 'scanner'
      ? '当前扫描项目下未找到可导出的 LAS/LAZ 源文件'
      : '当前普通点云没有可追溯的原始 LAS/LAZ 文件');
    error.code = 'NO_EXPORT_SOURCES';
    throw error;
  }

  const selected = candidates.find(item => item.relPath === sourceRelPath) || candidates[0];
  return {
    datasetContext: datasetContext.type === 'scanner'
      ? {
        type: 'scanner',
        projectId: datasetContext.projectId,
        projectName: datasetContext.name,
        geoInfoPath: datasetContext.geoInfoPath,
      }
      : {
        type: 'cloud',
        cloudName: datasetContext.cloudName,
        geoInfoPath: null,
      },
    sourceFile: {
      absPath: selected.absPath || (datasetContext.type === 'scanner'
        ? path.join(datasetContext.dirPath, selected.relPath)
        : path.join(UPLOADS_DIR, selected.relPath)),
      relPath: selected.relPath,
      name: selected.name,
    },
  };
}

function normalizeExportFormat(value, fallback = 'las') {
  const raw = String(value || '').trim().toLowerCase();
  return ['las', 'laz', 'ply', 'xyz', 'pts', 'csv', 'e57'].includes(raw) ? raw : fallback;
}

function buildExportScriptPayload(body, { outputPath, datasetContext, sourceFile }) {
  const exportOptions = body?.exportOptions || {};
  const format = normalizeExportFormat(exportOptions.format || 'las');
  return {
    inputPath: sourceFile.absPath,
    outputPath,
    datasetContext,
    coordConfig: body?.coordConfig || {},
    sourceGeodetic: body?.sourceGeodetic || body?.coordConfig?.sourceGeodetic || null,
    resolvedCoordinateSystem: body?.resolvedCoordinateSystem || { kind: 'local', label: '本地坐标' },
    deleteRegions: Array.isArray(body?.deleteRegions) ? body.deleteRegions : [],
    clipBoxes: Array.isArray(body?.clipBoxes) ? body.clipBoxes : [],
    gridRegistryPath: GRID_REGISTRY_FILE,
    exportOptions: {
      format,
      plyEncoding: exportOptions.plyEncoding || 'binary',
      transformMode: exportOptions.transformMode || 'current',
      outputLinearUnit: exportOptions.outputLinearUnit || 'm',
      includeCrsMetadata: exportOptions.includeCrsMetadata !== false,
      includeExportMetadataVlr: exportOptions.includeExportMetadataVlr !== false,
      clipMode: exportOptions.clipMode || 'inside',
    },
    chunkSize: Number(exportOptions.chunkSize) || 500000,
  };
}

async function handlePointcloudExport(req, res, { forceFormat = null, legacyLasResponse = false } = {}) {
  if (!fs.existsSync(PYTHON_BIN)) {
    return sendApiError(res, new Error(`导出环境未安装: ${PYTHON_BIN}`), { fallbackCode: 'EXPORT_ENV_MISSING' });
  }
  if (!fs.existsSync(EXPORT_POINTCLOUD_SCRIPT)) {
    return sendApiError(res, new Error(`导出脚本不存在: ${EXPORT_POINTCLOUD_SCRIPT}`), { fallbackCode: 'EXPORT_SCRIPT_MISSING' });
  }

  try {
    cleanupOldExports();
    const { datasetContext, sourceFile } = resolveExportSource(req.body);
    const exportOptions = req.body?.exportOptions || {};
    const format = normalizeExportFormat(forceFormat || exportOptions.format || 'las');
    if (format === 'e57') {
      const error = new Error('E57 导出将在第二阶段实现，当前尚不可用。');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const outputBase = sanitizeDownloadName(exportOptions.outputFilename || sourceFile.name);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const outputFilename = `${outputBase}_${stamp}.${format}`;
    const outputPath = path.join(EXPORTS_DIR, outputFilename);
    const payload = buildExportScriptPayload(
      {
        ...req.body,
        exportOptions: {
          ...exportOptions,
          format,
        },
      },
      { outputPath, datasetContext, sourceFile }
    );

    const { code, stdout, stderr } = await runPythonConfigJob(EXPORT_POINTCLOUD_SCRIPT, payload, {
      configDir: EXPORTS_DIR,
      configPrefix: outputBase,
    });

    if (code !== 0 || !fs.existsSync(outputPath)) {
      const detailedError = summarizeExportProcessError(stdout, stderr);
      return res.status(500).json({
        ok: false,
        error: detailedError || '点云导出失败',
        errorCode: 'EXPORT_FAILED',
        summary: detailedError || '点云导出失败',
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
    }

    let result = {};
    try {
      result = readLastJsonLine(stdout) || {};
    } catch { }

    const stat = safeStat(outputPath);
    return sendApiSuccess(res, {
      format,
      outputFilename,
      downloadUrl: `/exports/${encodeURIComponent(outputFilename)}`,
      sizeBytes: stat?.size ?? null,
      sizeLabel: stat ? formatBytes(stat.size) : '未知',
      standardCrsWritten: Boolean(result.standardCrsWritten),
      crsOmitReason: result.crsOmitReason || '',
      outputLinearUnit: result.outputLinearUnit || payload.exportOptions.outputLinearUnit,
      deletedPoints: Number.isFinite(result.deletedPoints) ? result.deletedPoints : null,
      clipFilteredPoints: Number.isFinite(result.clipFilteredPoints) ? result.clipFilteredPoints : null,
      keptPoints: Number.isFinite(result.keptPoints) ? result.keptPoints : null,
      writtenPoints: Number.isFinite(result.writtenPoints) ? result.writtenPoints : null,
      plyEncoding: result.plyEncoding || null,
      legacyType: legacyLasResponse ? 'las' : null,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'BAD_REQUEST', fallbackStatus: 400 });
  }
}

function cleanupOldExports(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const entry of fs.readdirSync(EXPORTS_DIR, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absPath = path.join(EXPORTS_DIR, entry.name);
    const stat = safeStat(absPath);
    if (!stat) continue;
    if (now - stat.mtimeMs > maxAgeMs) {
      try { fs.unlinkSync(absPath); } catch { }
    }
  }
}

function cleanupOldVolumeJobs(maxAgeMs = VOLUME_JOB_RETENTION_MS) {
  const now = Date.now();
  if (!fs.existsSync(VOLUME_JOB_DIR)) return;
  for (const entry of fs.readdirSync(VOLUME_JOB_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('vol_')) continue;
    const absPath = path.join(VOLUME_JOB_DIR, entry.name);
    const stat = safeStat(absPath);
    if (!stat || now - stat.mtimeMs <= maxAgeMs) continue;
    try {
      fs.rmSync(absPath, { recursive: true, force: true });
      console.log(`[Volume] Removed old job artifact directory: ${entry.name}`);
    } catch (error) {
      console.warn(`[Volume] Failed to remove old job artifact directory ${entry.name}:`, error.message);
    }
  }
}

function runPythonConfigJob(scriptPath, payload, {
  configDir = CACHE_DIR,
  configPrefix = 'job',
  pythonBin = PYTHON_BIN,
} = {}) {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const configPath = path.join(configDir, `${configPrefix}_${stamp}.json`);

    try {
      fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      reject(error);
      return;
    }

    const proc = spawn(pythonBin, [scriptPath, '--config', configPath], { cwd: __dirname, env: buildPythonEnv() });
    let stdout = '';
    let stderr = '';

    const cleanup = () => {
      try { fs.unlinkSync(configPath); } catch { }
    };

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', error => {
      cleanup();
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    proc.on('close', code => {
      cleanup();
      resolve({ code, stdout, stderr });
    });
  });
}

function createTimestampJobId(prefix) {
  return `${prefix}_${Date.now()}`;
}

const TERRAIN_ASYNC_JOBS = new Map();
const TERRAIN_ASYNC_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const FORESTRY_ASYNC_JOBS = new Map();
const FORESTRY_ASYNC_JOB_TTL_MS = 24 * 60 * 60 * 1000;

function pruneTerrainAsyncJobs(now = Date.now()) {
  for (const [jobId, job] of TERRAIN_ASYNC_JOBS.entries()) {
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || 0);
    if (Number.isFinite(updatedAt) && now - updatedAt > TERRAIN_ASYNC_JOB_TTL_MS) {
      TERRAIN_ASYNC_JOBS.delete(jobId);
    }
  }
}

function createTerrainAsyncJob(kind, payload = {}) {
  pruneTerrainAsyncJobs();
  const nowIso = new Date().toISOString();
  const jobId = createTimestampJobId(kind);
  const job = {
    jobId,
    kind,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Queued',
    error: null,
    result: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...payload,
  };
  TERRAIN_ASYNC_JOBS.set(jobId, job);
  return job;
}

function updateTerrainAsyncJob(jobId, patch = {}) {
  const job = TERRAIN_ASYNC_JOBS.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function pruneForestryAsyncJobs(now = Date.now()) {
  for (const [jobId, job] of FORESTRY_ASYNC_JOBS.entries()) {
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || 0);
    if (Number.isFinite(updatedAt) && now - updatedAt > FORESTRY_ASYNC_JOB_TTL_MS) {
      FORESTRY_ASYNC_JOBS.delete(jobId);
    }
  }
}

function createForestryAsyncJob(kind, payload = {}) {
  pruneForestryAsyncJobs();
  const nowIso = new Date().toISOString();
  const jobId = createTimestampJobId(kind);
  const job = {
    jobId,
    kind,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Queued',
    error: null,
    result: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...payload,
  };
  FORESTRY_ASYNC_JOBS.set(jobId, job);
  return job;
}

function updateForestryAsyncJob(jobId, patch = {}) {
  const job = FORESTRY_ASYNC_JOBS.get(jobId);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function getAnyAsyncJob(jobId) {
  return TERRAIN_ASYNC_JOBS.get(jobId) || FORESTRY_ASYNC_JOBS.get(jobId) || null;
}

function buildForestryRunId() {
  return `forestry_${Date.now()}`;
}

function resolveProjectDirectory(projectPath) {
  const absPath = ensureExistingBoundedPath(projectPath, {
    fieldName: 'projectPath',
    missingCode: 'FILE_NOT_FOUND',
    missingMessage: `Project path not found: ${path.resolve(String(projectPath || ''))}`,
  });
  const stats = fs.statSync(absPath);
  return stats.isDirectory() ? absPath : path.dirname(absPath);
}

function resolveForestryProjectContext(projectPath, projectId) {
  if (projectId) {
    const normalizedProjectId = requireNonEmptyString(projectId, 'projectId', { code: 'BAD_REQUEST' });
    const project = getScannerProjectById(normalizedProjectId);
    if (!project?.dirPath) {
      const error = new Error(`Scanner project not found: ${normalizedProjectId}`);
      error.code = 'PROJECT_NOT_FOUND';
      throw error;
    }
    return {
      projectId: normalizedProjectId,
      projectDir: resolveProjectDirectory(project.dirPath),
      project,
    };
  }

  const projectDir = resolveProjectDirectory(projectPath);
  return {
    projectId: null,
    projectDir,
    project: null,
  };
}

function resolveForestryInputLasPath(lasPath, projectContext) {
  if (lasPath) {
    return ensureExistingAbsoluteFile(lasPath, {
      fieldName: 'lasPath',
      missingCode: 'FILE_NOT_FOUND',
      missingMessage: lasPath ? `LAS file not found: ${path.resolve(lasPath)}` : 'lasPath is required',
      enforceStorageBounds: true,
    });
  }

  if (projectContext?.project) {
    const sourceFiles = listScannerSourceFiles(projectContext.project);
    const firstSource = sourceFiles[0];
    if (firstSource?.relPath) {
      const candidate = path.join(projectContext.projectDir, firstSource.relPath);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const error = new Error('lasPath is required unless a scanner project with source LAS/LAZ is selected');
  error.code = 'BAD_REQUEST';
  throw error;
}

function getForestryRunPaths(projectRef, runId) {
  const projectDir = typeof projectRef === 'string'
    ? resolveProjectDirectory(projectRef)
    : resolveProjectDirectory(projectRef?.projectDir || projectRef?.dirPath || projectRef?.projectPath);
  const projectName = path.basename(projectDir);
  const runDir = path.join(projectDir, 'forestry', runId);
  return {
    projectDir,
    projectName,
    runDir,
    preparedPath: path.join(runDir, 'prepared.las'),
    stemsPath: path.join(runDir, 'stems.json'),
    segmentedPath: path.join(runDir, 'segmented.las'),
    csvPath: path.join(runDir, 'trees.csv'),
    geojsonPath: path.join(runDir, 'trees.geojson'),
    treeReviewPath: path.join(runDir, 'tree_review.json'),
  };
}

function listForestryRuns(projectRef) {
  const projectDir = typeof projectRef === 'string'
    ? resolveProjectDirectory(projectRef)
    : resolveProjectDirectory(projectRef?.projectDir || projectRef?.dirPath || projectRef?.projectPath);
  const forestryDir = path.join(projectDir, 'forestry');
  if (!fs.existsSync(forestryDir)) return [];

  return fs.readdirSync(forestryDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^forestry_/i.test(entry.name))
    .map(entry => {
      const runPaths = getForestryRunPaths(projectDir, entry.name);
      const runDirStats = fs.statSync(runPaths.runDir);
      const stems = readJsonFileSafe(runPaths.stemsPath, { seeds: [] });
      const treeRows = fs.existsSync(runPaths.geojsonPath)
        ? ((readJsonFileSafe(runPaths.geojsonPath, { features: [] })?.features || []).map(feature => feature?.properties || {}))
        : parseSimpleCsv(runPaths.csvPath);
      return {
        runId: entry.name,
        runDir: runPaths.runDir,
        updatedAt: runDirStats.mtime.toISOString(),
        files: {
          preparedPath: fs.existsSync(runPaths.preparedPath) ? runPaths.preparedPath : null,
          stemsPath: fs.existsSync(runPaths.stemsPath) ? runPaths.stemsPath : null,
          segmentedPath: fs.existsSync(runPaths.segmentedPath) ? runPaths.segmentedPath : null,
          csvPath: fs.existsSync(runPaths.csvPath) ? runPaths.csvPath : null,
          geojsonPath: fs.existsSync(runPaths.geojsonPath) ? runPaths.geojsonPath : null,
          treeReviewPath: fs.existsSync(runPaths.treeReviewPath) ? runPaths.treeReviewPath : null,
        },
        summary: {
          seedCount: Array.isArray(stems?.seeds) ? stems.seeds.length : 0,
          treeCount: Array.isArray(treeRows) ? treeRows.length : 0,
        },
      };
    })
    .filter(run => Object.values(run.files || {}).some(Boolean))
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0));
}

function ensureForestryRunDir(paths) {
  fs.mkdirSync(paths.runDir, { recursive: true });
}

function normalizeForestrySeed(seed, index = 0) {
  const defaultDbh = Number(seed?.dbh || 0.25);
  return {
    id: Number(seed?.id || index + 1),
    x: Number(seed?.x || 0),
    y: Number(seed?.y || 0),
    z: Number(seed?.z || 0),
    dbh: defaultDbh,
    status: String(seed?.status || 'manual'),
    treeHeight: Number(seed?.treeHeight || 0),
    pointCount: Number(seed?.pointCount || 0),
    qualityScore: Number(seed?.qualityScore || 0),
    qualityFlag: String(seed?.qualityFlag || ''),
    qualityReason: String(seed?.qualityReason || ''),
    sourceSegmentId: Number(seed?.sourceSegmentId || 0),
    fitCenterX: Number(seed?.fitCenterX ?? seed?.x ?? 0),
    fitCenterY: Number(seed?.fitCenterY ?? seed?.y ?? 0),
    fitRadius: Number(seed?.fitRadius ?? (defaultDbh / 2)),
    fitDiameter: Number(seed?.fitDiameter ?? defaultDbh),
    fitResidual: Number(seed?.fitResidual || 0),
    fitInlierRatio: Number(seed?.fitInlierRatio || 0),
    fitCoverageDegrees: Number(seed?.fitCoverageDegrees || 0),
    fitSliceCount: Number(seed?.fitSliceCount || 0),
    fitConfidence: Number(seed?.fitConfidence || 0),
    fitStatus: String(seed?.fitStatus || ''),
    fitMethod: String(seed?.fitMethod || (String(seed?.status || '') === 'manual' ? 'manual_seed' : '')),
    fitFallbackReason: String(seed?.fitFallbackReason || ''),
  };
}

function persistForestrySeeds(runPaths, runId, projectPath, algorithm, seeds) {
  const existingPayload = readJsonFileSafe(runPaths.stemsPath, {});
  const payload = {
    ...existingPayload,
    runId: String(existingPayload?.runId || runId),
    projectPath: String(existingPayload?.projectPath || projectPath),
    algorithm: String(existingPayload?.algorithm || algorithm || 'treeiso'),
    inputPath: String(existingPayload?.inputPath || runPaths.preparedPath),
    seeds: Array.isArray(seeds) ? seeds.map((seed, index) => normalizeForestrySeed(seed, index)) : [],
  };
  fs.writeFileSync(runPaths.stemsPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function parseSimpleCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((header, index) => {
      const raw = cols[index] ?? '';
      const numeric = Number(raw);
      row[header] = raw !== '' && Number.isFinite(numeric) ? numeric : raw;
    });
    return row;
  });
}

function ensureExistingAbsoluteFile(filePath, {
  fieldName = 'filePath',
  missingCode = 'FILE_NOT_FOUND',
  missingMessage = null,
  enforceStorageBounds = false,
  roots = null,
  includeScanRoots = true,
} = {}) {
  const normalizedPath = requireNonEmptyString(filePath, fieldName, { code: 'BAD_REQUEST' });
  const absPath = path.resolve(normalizedPath);
  if (!fs.existsSync(absPath)) {
    const error = new Error(missingMessage || `File not found: ${absPath}`);
    error.code = missingCode;
    throw error;
  }
  if (enforceStorageBounds) {
    return ensureExistingBoundedPath(absPath, {
      fieldName,
      missingCode,
      missingMessage,
      roots,
      includeScanRoots,
    });
  }
  return absPath;
}

function parseObjMeshFile(filePath) {
  const absPath = ensureExistingAbsoluteFile(filePath, {
    fieldName: 'path',
    missingCode: 'FILE_NOT_FOUND',
    enforceStorageBounds: true,
  });
  if (!/\.obj$/i.test(absPath)) {
    const error = new Error('Only OBJ files are supported.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const content = fs.readFileSync(absPath, 'utf-8');
  const vertices = [];
  const colors = [];
  const faces = [];
  let zMin = Infinity;
  let zMax = -Infinity;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      vertices.push([x, y, z]);
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
      if (parts.length >= 7) {
        colors.push([
          Math.max(0, Math.min(1, Number(parts[4]) || 0)),
          Math.max(0, Math.min(1, Number(parts[5]) || 0)),
          Math.max(0, Math.min(1, Number(parts[6]) || 0)),
        ]);
      }
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const face = parts.slice(1, 4).map(token => Number(String(token).split('/')[0]) - 1);
      if (face.every(index => Number.isInteger(index) && index >= 0)) faces.push(face);
    }
  }

  if (!vertices.length || !faces.length) {
    const error = new Error('The OBJ file does not contain a readable triangle mesh.');
    error.code = 'BAD_REQUEST';
    throw error;
  }

  if (colors.length !== vertices.length) {
    const span = Math.max(1e-6, zMax - zMin);
    for (const vertex of vertices) {
      const t = (vertex[2] - zMin) / span;
      colors.push([
        0.20 + 0.55 * t,
        0.55 + 0.30 * (1 - Math.abs(t - 0.5) * 2),
        0.95 - 0.45 * t,
      ]);
    }
  }

  return {
    meta: {
      type: 'imported_obj_mesh',
      sourcePath: absPath,
      vertexCount: vertices.length,
      faceCount: faces.length,
      zMin: Number.isFinite(zMin) ? zMin : null,
      zMax: Number.isFinite(zMax) ? zMax : null,
      displayName: path.basename(absPath),
    },
    vertices,
    colors,
    faces,
  };
}

function requireJobId(jobId, prefix, {
  code = 'BAD_REQUEST',
  fieldName = 'jobId',
} = {}) {
  const normalized = requireNonEmptyString(jobId, fieldName, { code });
  const pattern = new RegExp(`^${prefix}_\\d+$`);
  if (!pattern.test(normalized)) {
    const error = new Error(`Invalid ${fieldName}`);
    error.code = code;
    throw error;
  }
  return normalized;
}

function requireSafeCloudName(cloudName) {
  const normalized = requireNonEmptyString(cloudName, 'cloudName', { code: 'BAD_REQUEST' });
  if (/[/\\]/.test(normalized) || normalized === '.' || normalized === '..') {
    const error = new Error('Invalid cloud name');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return normalized;
}

function sanitizeGaussianAssetName(value, fallback = 'gaussian_scene') {
  const normalized = String(value || fallback)
    .trim()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function getUniqueGaussianAssetDir(baseName) {
  const safeBase = sanitizeGaussianAssetName(baseName);
  let assetName = safeBase;
  let assetDir = path.join(GAUSSIANS_DIR, assetName);
  if (!fs.existsSync(assetDir)) return { assetName, assetDir };

  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  assetName = `${safeBase}_${stamp}`;
  assetDir = path.join(GAUSSIANS_DIR, assetName);
  let suffix = 2;
  while (fs.existsSync(assetDir)) {
    assetName = `${safeBase}_${stamp}_${suffix++}`;
    assetDir = path.join(GAUSSIANS_DIR, assetName);
  }
  return { assetName, assetDir };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeGaussianViewerRotation(value, fallback = DEFAULT_GAUSSIAN_VIEWER_ROTATION) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {
    rx: Number(source.rx),
    ry: Number(source.ry),
    rz: Number(source.rz),
  };
  const fallbackRotation = fallback && typeof fallback === 'object' ? fallback : DEFAULT_GAUSSIAN_VIEWER_ROTATION;
  for (const axis of ['rx', 'ry', 'rz']) {
    if (!Number.isFinite(normalized[axis])) normalized[axis] = fallbackRotation[axis] ?? 0;
  }
  return normalized;
}

function gaussianViewerRotationEquals(a, b) {
  const left = normalizeGaussianViewerRotation(a);
  const right = normalizeGaussianViewerRotation(b);
  return left.rx === right.rx && left.ry === right.ry && left.rz === right.rz;
}

function resolveGaussianViewerRotation(manifest = {}, publishInfo = {}, fallback = DEFAULT_GAUSSIAN_VIEWER_ROTATION) {
  const topLevelRotation = manifest.viewerRotation
    ? normalizeGaussianViewerRotation(manifest.viewerRotation, fallback)
    : null;
  const publishRotation = (manifest.publish?.viewerRotation || publishInfo.viewerRotation)
    ? normalizeGaussianViewerRotation(manifest.publish?.viewerRotation || publishInfo.viewerRotation, fallback)
    : null;

  if (topLevelRotation && publishRotation && !gaussianViewerRotationEquals(topLevelRotation, publishRotation)) {
    if (!gaussianViewerRotationEquals(publishRotation, DEFAULT_GAUSSIAN_VIEWER_ROTATION)) {
      return publishRotation;
    }
  }

  return topLevelRotation || publishRotation || normalizeGaussianViewerRotation(null, fallback);
}

function buildGaussianEditorUrl(assetName, manifest = {}, publishInfo = {}) {
  const fileName = manifest.fileName || manifest.originalName || 'scene.ply';
  const rotation = resolveGaussianViewerRotation(
    manifest,
    publishInfo,
    publishInfo.rotationBaked ? BAKED_GAUSSIAN_VIEWER_ROTATION : DEFAULT_GAUSSIAN_VIEWER_ROTATION,
  );
  const params = new URLSearchParams({
    load: `/gaussians/${assetName}/${fileName}`,
    filename: fileName,
    lng: 'en',
    rx: String(rotation.rx),
    ry: String(rotation.ry),
    rz: String(rotation.rz),
    'show.grid': 'false',
    'show.bound': 'false',
    v: GAUSSIAN_EDITOR_VERSION,
  });
  return `/assets/supersplat-editor/index.html?${params.toString()}`;
}

function getGaussianViewerUrl(assetName, publishInfo = null, fallbackFileName = 'scene.ply') {
  return `/3dgs/${encodeURIComponent(assetName)}`;
}

function buildGaussianCloudListEntry(name, manifest = {}) {
  const publish = manifest.publish || {};
  const optimizationStatus = publish.optimizationStatus
    || manifest.optimizationStatus
    || (publish.sourceFormat === 'ply' || manifest.format === 'ply' ? 'unknown' : 'not-applicable');
  const directBrowseStatus = publish.directBrowseStatus || manifest.directBrowseStatus || (
    ['ready', 'direct-ready', 'optimized-ready'].includes(publish.status) ? 'ready' : 'unknown'
  );
  const viewerRotation = resolveGaussianViewerRotation(
    manifest,
    publish,
    publish.rotationBaked ? BAKED_GAUSSIAN_VIEWER_ROTATION : DEFAULT_GAUSSIAN_VIEWER_ROTATION,
  );

  return {
    name,
    cloudName: name,
    resourceType: 'gaussian',
    sourceType: manifest.type || 'gaussian-upload',
    gaussianFormat: manifest.format || null,
    gaussianPipeline: publish.pipeline || null,
    gaussianPublishStatus: publish.status || 'raw',
    gaussianDirectBrowseStatus: directBrowseStatus,
    gaussianOptimizationStatus: optimizationStatus,
    gaussianOptimizationEligible: Boolean(publish.optimizationEligible || optimizationStatus !== 'not-applicable'),
    gaussianOptimizationPipeline: publish.optimizationPipeline || null,
    gaussianPublishBytes: publish.bytes || manifest.runtimeBytes || null,
    originalBytes: manifest.originalBytes || null,
    fileUrl: manifest.fileUrl || null,
    sourceFileUrl: manifest.sourceFileUrl || null,
    points: null,
    metadataUrl: null,
    scanDataUrl: null,
    viewerRotation,
    editorViewerUrl: buildGaussianEditorUrl(name, manifest, publish),
    viewerUrl: manifest.viewerUrl || getGaussianViewerUrl(name, publish, manifest.fileName || 'scene.ply'),
  };
}

function readGaussianManifest(assetName) {
  const manifestPath = path.join(GAUSSIANS_DIR, assetName, 'source.json');
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}

function writeGaussianManifest(assetDir, manifest) {
  fs.writeFileSync(path.join(assetDir, 'source.json'), JSON.stringify(manifest, null, 2));
}

function resolveSplatTransformCommand() {
  const localBin = path.join(__dirname, 'node_modules', '.bin', IS_WINDOWS ? 'splat-transform.cmd' : 'splat-transform');
  if (pathExists(localBin)) {
    return { command: localBin, prefixArgs: [] };
  }
  return { command: IS_WINDOWS ? 'npx.cmd' : 'npx', prefixArgs: ['--yes', `@playcanvas/splat-transform@${SPLAT_TRANSFORM_VERSION}`] };
}

function runGaussianSogConversion(inputPath, outputPath, { rotation = GAUSSIAN_CONVERT_ROTATION } = {}) {
  return new Promise((resolve) => {
    const { command, prefixArgs } = resolveSplatTransformCommand();
    const args = [
      ...prefixArgs,
      '--mem',
      '--overwrite',
      '-g',
      'cpu',
      inputPath,
      '-r',
      rotation,
      outputPath,
    ];
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: __dirname,
      env: buildPythonEnv({ npm_config_yes: 'true' }),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      resolve({
        ok: false,
        error,
        command,
        args,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on('close', code => {
      resolve({
        ok: code === 0 && fs.existsSync(outputPath),
        code,
        command,
        args,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function summarizeSplatTransformOutput(output = '') {
  return String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-20)
    .join('\n');
}

function enqueueGaussianConversion(task) {
  gaussianConversionQueue = gaussianConversionQueue
    .catch(() => {})
    .then(task);
  return gaussianConversionQueue;
}

function finalizeGaussianManifestForEditor(assetName, manifest, publishOverrides = {}) {
  const publish = {
    ...(manifest.publish || {}),
    ...publishOverrides,
  };
  const rotationFallback = publish.rotationBaked
    ? BAKED_GAUSSIAN_VIEWER_ROTATION
    : DEFAULT_GAUSSIAN_VIEWER_ROTATION;
  const viewerRotation = resolveGaussianViewerRotation(manifest, publish, rotationFallback);

  manifest.viewerUrl = `/3dgs/${encodeURIComponent(assetName)}`;
  manifest.viewerRotation = viewerRotation;
  manifest.directBrowseStatus = publish.directBrowseStatus || 'ready';
  manifest.optimizationStatus = publish.optimizationStatus || manifest.optimizationStatus || 'not-applicable';
  manifest.publish = {
    status: 'direct-ready',
    directBrowseStatus: manifest.directBrowseStatus,
    pipeline: 'supersplat-editor-direct',
    engine: 'playcanvas-supersplat-editor',
    sourceFormat: manifest.format,
    editorViewerUrl: '',
    directViewerUrl: '',
    viewerUrl: manifest.viewerUrl,
    viewerRotation,
    optimizationStatus: manifest.optimizationStatus,
    publishedAt: new Date().toISOString(),
    ...publish,
  };
  manifest.publish.viewerRotation = viewerRotation;
  manifest.publish.directBrowseStatus = manifest.directBrowseStatus;
  manifest.publish.optimizationStatus = manifest.optimizationStatus;
  const editorViewerUrl = buildGaussianEditorUrl(assetName, manifest, manifest.publish);
  manifest.publish.editorViewerUrl = editorViewerUrl;
  manifest.publish.directViewerUrl = editorViewerUrl;
  manifest.note = 'Published with CloudStudio SuperSplat Editor browse mode. Source file is loaded directly by the viewer.';
  return manifest;
}

function createGaussianDirectManifest(assetName, {
  assetDir = null,
  originalName,
  targetName = 'scene.ply',
  sourceBytes = null,
  uploadedAt = new Date().toISOString(),
} = {}) {
  const manifest = {
    type: 'gaussian-upload',
    resourceType: 'gaussian',
    assetName,
    originalName,
    fileName: targetName,
    format: path.extname(targetName).replace(/^\./, '').toLowerCase() || 'ply',
    originalBytes: sourceBytes,
    uploadedAt,
    fileUrl: `/gaussians/${encodeURIComponent(assetName)}/${encodeURIComponent(targetName)}`,
  };
  const isPlySource = manifest.format === 'ply';
  finalizeGaussianManifestForEditor(assetName, manifest, {
    status: 'direct-ready',
    directBrowseStatus: 'ready',
    pipeline: 'supersplat-editor-direct',
    engine: 'playcanvas-supersplat-editor',
    sourceFormat: manifest.format,
    runtimeFormat: manifest.format,
    fileName: targetName,
    bytes: sourceBytes,
    sourceBytes,
    rotationBaked: false,
    viewerRotation: DEFAULT_GAUSSIAN_VIEWER_ROTATION,
    optimizationEligible: isPlySource,
    optimizationStatus: isPlySource ? 'pending' : 'not-applicable',
    optimizationPipeline: isPlySource ? 'supersplat-editor-sog' : null,
  });
  manifest.note = isPlySource
    ? 'Direct 3DGS browsing is ready. SOG optimization is pending in the background.'
    : 'Direct 3DGS browsing is ready. SOG optimization is not applicable for this source format.';
  if (assetDir) {
    writeGaussianManifest(assetDir, manifest);
  }
  return manifest;
}

async function optimizeGaussianAssetToSog({
  assetName,
  assetDir,
  originalName,
  targetName = 'scene.ply',
  targetPath,
  runtimeName = 'scene.sog',
  runtimePath,
  sourceBytes,
}) {
  const conversion = await runGaussianSogConversion(targetPath, runtimePath);
  if (!conversion.ok) {
    const currentManifest = readGaussianManifest(assetName)
      || createGaussianDirectManifest(assetName, {
        originalName,
        targetName,
        sourceBytes,
      });
    currentManifest.publish = {
      ...(currentManifest.publish || {}),
      status: 'direct-ready',
      directBrowseStatus: 'ready',
      optimizationStatus: 'failed',
      optimizationEligible: true,
      optimizationPipeline: 'supersplat-editor-sog',
      sourceFormat: 'ply',
      attemptedRuntimeFormat: 'sog',
      conversionRotation: GAUSSIAN_CONVERT_ROTATION,
      durationMs: conversion.durationMs,
      error: conversion.error?.message || `splat-transform exited with code ${conversion.code}`,
      stderr: summarizeSplatTransformOutput(conversion.stderr),
      tool: `@playcanvas/splat-transform@${SPLAT_TRANSFORM_VERSION}`,
      failedAt: new Date().toISOString(),
    };
    const viewerRotation = resolveGaussianViewerRotation(currentManifest, currentManifest.publish, DEFAULT_GAUSSIAN_VIEWER_ROTATION);
    currentManifest.viewerRotation = viewerRotation;
    currentManifest.directBrowseStatus = 'ready';
    currentManifest.optimizationStatus = 'failed';
    currentManifest.publish.viewerRotation = viewerRotation;
    currentManifest.note = 'Direct PLY browsing is available. Background SOG optimization failed on the server.';
    writeGaussianManifest(assetDir, currentManifest);
    console.warn(`[Gaussian] Background SOG optimization failed for ${assetName}: ${currentManifest.publish.error}`);
    return { ok: false, conversion, manifest: currentManifest };
  }

  const runtimeBytes = fs.statSync(runtimePath).size;
  const previousManifest = readGaussianManifest(assetName) || {};
  const previousRotation = resolveGaussianViewerRotation(previousManifest, previousManifest.publish || {}, DEFAULT_GAUSSIAN_VIEWER_ROTATION);
  const viewerRotation = gaussianViewerRotationEquals(previousRotation, DEFAULT_GAUSSIAN_VIEWER_ROTATION)
    ? BAKED_GAUSSIAN_VIEWER_ROTATION
    : previousRotation;
  const manifest = {
    type: 'gaussian-upload',
    resourceType: 'gaussian',
    assetName,
    originalName,
    fileName: runtimeName,
    format: 'sog',
    originalPlyFileName: targetName,
    originalBytes: sourceBytes,
    runtimeBytes,
    fileUrl: `/gaussians/${encodeURIComponent(assetName)}/${encodeURIComponent(runtimeName)}`,
    sourceFileUrl: `/gaussians/${encodeURIComponent(assetName)}/${encodeURIComponent(targetName)}`,
    convertedFrom: targetName,
    uploadedAt: previousManifest.uploadedAt || new Date().toISOString(),
    viewerRotation,
  };
  finalizeGaussianManifestForEditor(assetName, manifest, {
    status: 'optimized-ready',
    directBrowseStatus: 'ready',
    pipeline: 'supersplat-editor-sog',
    engine: 'playcanvas-supersplat-editor',
    sourceFormat: 'ply',
    runtimeFormat: 'sog',
    fileName: runtimeName,
    bytes: runtimeBytes,
    sourceBytes,
    rotationBaked: true,
    viewerRotation,
    conversionRotation: GAUSSIAN_CONVERT_ROTATION,
    durationMs: conversion.durationMs,
    optimizationEligible: true,
    optimizationStatus: 'ready',
    optimizedAt: new Date().toISOString(),
    tool: `@playcanvas/splat-transform@${SPLAT_TRANSFORM_VERSION}`,
  });
  manifest.note = 'Published with CloudStudio SuperSplat Editor browse mode using official PlayCanvas SOG generated from the original PLY. Rotation is baked into the published file.';
  writeGaussianManifest(assetDir, manifest);
  console.log(`[Gaussian] Background SOG optimization finished for ${assetName} in ${conversion.durationMs}ms`);
  return { ok: true, conversion, manifest };
}

function buildConversionFailureMessage({ ok, code, metadataPath, stdout, stderr }) {
  if (ok) return null;
  const metadataExists = fs.existsSync(metadataPath);
  const errDetail = (stderr || stdout).slice(-400).trim();
  return !metadataExists && code === 0
    ? 'PotreeConverter 运行结束但未生成 metadata.json（LAS 格式可能不兼容）'
    : (errDetail
      ? `PotreeConverter 退出码 ${code}：${errDetail}`
      : `PotreeConverter 退出码 ${code}，无详细输出。请用 pm2 logs cloudstudio 查看服务端日志。`);
}

function runTerrainPythonJob(scriptPath, scriptArgs = [], {
  timeoutMs = 120000,
  errorCode = 'TERRAIN_JOB_FAILED',
  logLabel = 'Terrain',
} = {}) {
  return runPython(SYSTEM_PYTHON_BIN, [scriptPath, ...scriptArgs], timeoutMs).catch((error) => {
    console.error(`[${logLabel}] Error:`, error.message);
    error.code = error.code || errorCode;
    throw error;
  });
}

/**
 * Detect scanner data features in a directory
 */
function findFirstExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function detectScannerFeatures(dirPath) {
  const features = {
    hasOdom: false,
    hasCameras: false,
    hasGeo: false,
    hasPhotos: false,
    hasParams: false,
    hasPotree: false,
    hasTransforms: false,
    pointCount: null,
    dirPath,
  };

  try {
    const files = fs.readdirSync(dirPath);
    const odomPath = findFirstExistingPath([
      path.join(dirPath, 'odom.csv'),
      path.join(dirPath, '.cache', 'cache1', 'odom.csv'),
    ]);
    const imgPosePath = findFirstExistingPath([
      path.join(dirPath, 'ImgPose.txt'),
      path.join(dirPath, 'camera', 'ImgPose.txt'),
    ]);
    const geoInfoPath = findFirstExistingPath([
      path.join(dirPath, 'geo_info.csv'),
    ]);

    features.hasOdom = Boolean(odomPath);
    features.hasCameras = Boolean(imgPosePath);
    features.hasGeo = Boolean(geoInfoPath);
    features.hasParams = files.includes('params.json');
    features.hasTransforms = files.includes('transforms.json');
    features.hasPhotos = files.includes('undistort') &&
      fs.existsSync(path.join(dirPath, 'undistort', 'left'));
    features.odomPath = odomPath || null;
    features.imgPosePath = imgPosePath || null;
    features.geoInfoPath = geoInfoPath || null;

    // Check for Potree converted data
    const convertedDir = path.join(dirPath, 'converted');
    if (fs.existsSync(path.join(convertedDir, 'metadata.json'))) {
      features.hasPotree = true;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(convertedDir, 'metadata.json'), 'utf-8'));
        features.pointCount = meta.points ?? null;
      } catch { }
    }

    // Check for LAS files at root
    features.hasColorizedLas = files.includes('colorized.las') || files.includes('colorized.laz');
    features.hasUncolorizedLas = files.includes('uncolorized.las') || files.includes('uncolorized.laz');
    features.hasScanLas = files.includes('scan_resumer.las') || files.includes('scan_resumer.laz');
    // Any LAS/LAZ file at root level counts
    features.hasAnyLas = files.some(f => /\.(las|laz)$/i.test(f));
    // Collect all LAS filenames at root for name-matching
    features.lasFiles = files.filter(f => /\.(las|laz)$/i.test(f));
  } catch (e) {
    console.warn(`[Scanner] Could not scan ${dirPath}:`, e.message);
  }

  return features;
}

function readMetadataPointCount(metadataPath) {
  try {
    if (!fs.existsSync(metadataPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    return meta.points ?? null;
  } catch {
    return null;
  }
}

function pickPreferredLasPath(dirPath, features = detectScannerFeatures(dirPath)) {
  const files = Array.isArray(features?.lasFiles) ? features.lasFiles : [];
  if (!files.length) return null;
  const ranked = [...files].sort((a, b) => {
    const aName = String(a || '').toLowerCase();
    const bName = String(b || '').toLowerCase();
    const aIndex = SCANNER_LAS_PREFERRED.indexOf(aName);
    const bIndex = SCANNER_LAS_PREFERRED.indexOf(bName);
    const aRank = aIndex === -1 ? SCANNER_LAS_PREFERRED.length + 1 : aIndex;
    const bRank = bIndex === -1 ? SCANNER_LAS_PREFERRED.length + 1 : bIndex;
    if (aRank !== bRank) return aRank - bRank;
    return aName.localeCompare(bName);
  });
  return ranked.length ? path.join(dirPath, ranked[0]) : null;
}

function buildLocalSourceFileInfo(absPath) {
  const stat = safeStat(absPath);
  if (!stat?.isFile()) return null;
  return {
    absPath,
    name: path.basename(absPath),
    originalName: path.basename(absPath),
    relPath: path.basename(absPath),
    sizeBytes: stat.size,
    sizeLabel: formatBytes(stat.size),
    ext: path.extname(absPath).toLowerCase(),
  };
}

function createLocalPointcloudEntry({
  cloudName,
  displayName,
  metadataPath,
  metadataUrl,
  sourceType = 'desktop-local-import',
  kind = 'pointcloud',
  originalPath = null,
  sourceFiles = [],
  projectId = null,
  projectName = null,
  dirPath = null,
  features = null,
  managedOutputDir = null,
}) {
  const entry = {
    cloudName,
    displayName: displayName || cloudName,
    metadataPath,
    metadataUrl,
    sourceType,
    kind,
    originalPath,
    sourceFiles,
    projectId,
    projectName,
    scannerProjectId: projectId,
    scannerProjectName: projectName,
    dirPath,
    features,
    managedOutputDir,
    points: readMetadataPointCount(metadataPath),
    updatedAt: new Date().toISOString(),
  };
  return upsertLocalImportEntry(entry);
}

function registerLocalStandalonePointcloud({
  metadataPath,
  displayName,
  originalPath = null,
  sourceType = 'desktop-local-pointcloud',
  managedOutputDir = null,
}) {
  const metadataDir = path.dirname(metadataPath);
  const sourceKey = originalPath || metadataDir;
  const cloudName = buildStableLocalId('local-cloud', displayName || path.basename(metadataDir), sourceKey);
  const sourceFiles = originalPath ? [buildLocalSourceFileInfo(originalPath)].filter(Boolean) : [];
  const entry = createLocalPointcloudEntry({
    cloudName,
    displayName: displayName || path.basename(metadataDir),
    metadataPath,
    metadataUrl: buildLocalPointcloudMetadataUrl(cloudName),
    sourceType,
    kind: 'pointcloud',
    originalPath,
    sourceFiles,
    managedOutputDir,
  });
  return {
    entry,
    viewerUrl: `/viewer?pointcloud=${encodeURIComponent(entry.metadataUrl)}`,
    importedKind: 'pointcloud',
  };
}

function buildScannerViewerUrl({ projectId, metadataUrl, projectName }) {
  const params = new URLSearchParams();
  if (metadataUrl) params.set('pointcloud', metadataUrl);
  if (projectId) {
    params.set('projectId', projectId);
    params.set('scanDataUrl', `/scan-data/${projectId}`);
  }
  if (projectName) params.set('projectName', projectName);
  return `/viewer?${params.toString()}`;
}

function registerLocalScannerProject({
  dirPath,
  metadataPath,
  displayName,
  originalPath = null,
  sourceType = 'desktop-local-scan-project',
  managedOutputDir = null,
}) {
  const projectName = displayName || path.basename(dirPath);
  const projectId = buildStableLocalId('scan', projectName, dirPath);
  const cloudName = buildStableLocalId('scan-cloud', projectName, metadataPath || dirPath);
  const features = detectScannerFeatures(dirPath);
  const sourceFiles = originalPath ? [buildLocalSourceFileInfo(originalPath)].filter(Boolean) : [];
  const entry = createLocalPointcloudEntry({
    cloudName,
    displayName: projectName,
    metadataPath,
    metadataUrl: `/scan-data/${encodeURIComponent(projectId)}/converted/metadata.json`,
    sourceType,
    kind: 'scannerProject',
    originalPath,
    sourceFiles,
    projectId,
    projectName,
    dirPath,
    features,
    managedOutputDir,
  });
  return {
    entry,
    viewerUrl: buildScannerViewerUrl({
      projectId,
      metadataUrl: entry.metadataUrl,
      projectName,
    }),
    importedKind: 'scannerProject',
  };
}

function convertLasToPotree(absLasPath, outDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CONVERTER)) {
      const error = new Error('PotreeConverter not found');
      error.code = 'CONVERTER_NOT_FOUND';
      reject(error);
      return;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const proc = spawn(CONVERTER, [absLasPath, '-o', outDir], { cwd: ROOT, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += String(d); });
    proc.stderr.on('data', d => { stderr += String(d); });
    proc.on('error', reject);
    proc.on('close', code => {
      const metadataPath = path.join(outDir, 'metadata.json');
      if (code === 0 && fs.existsSync(metadataPath)) {
        resolve({ metadataPath, stdout, stderr });
        return;
      }
      const error = new Error((stderr || stdout || 'Point cloud conversion failed').slice(-2000));
      error.code = 'CONVERSION_FAILED';
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function removeDirIfExists(targetPath) {
  try {
    if (targetPath && fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('[Cleanup] Failed to remove directory:', targetPath, error.message);
  }
}

function inferPotreeSanitizeMode(absLasPath) {
  const lower = String(absLasPath || '').toLowerCase();
  if (lower.includes('_semantic')) return 'semantic';
  if (lower.includes('_trees')) return 'treeid';
  return 'auto';
}

function isDerivedAnalysisLas(absLasPath) {
  const base = path.parse(String(absLasPath || '')).name.toLowerCase();
  return [
    '_classified',
    '_semantic',
    '_trees',
    '_hag',
    '_geom',
    '_rulecls',
  ].some(token => base.includes(token));
}

async function sanitizeLasForPotree(absLasPath, sanitizeMode = 'auto') {
  const tempDir = path.join(__dirname, '.cache', 'potree-sanitize');
  fs.mkdirSync(tempDir, { recursive: true });
  const parsed = path.parse(absLasPath);
  const safeName = `${parsed.name}_potree_safe${parsed.ext}`;
  const outputPath = path.join(tempDir, safeName);
  const result = await runTerrainPythonJob(
    SANITIZE_FOR_POTREE_SCRIPT,
    [absLasPath, outputPath, sanitizeMode],
    {
      timeoutMs: 900000,
      errorCode: 'POTREE_SANITIZE_FAILED',
      logLabel: 'PotreeSanitize',
    }
  );
  return {
    outputPath: result.outputPath || outputPath,
    classificationMode: result.classificationMode || sanitizeMode,
  };
}

async function convertLasToPotreeWithFallback(absLasPath, outDir, {
  sanitizeMode = inferPotreeSanitizeMode(absLasPath),
} = {}) {
  removeDirIfExists(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const result = await convertLasToPotree(absLasPath, outDir);
    return { ...result, inputPath: absLasPath, sanitized: false };
  } catch (error) {
    const shouldFallback = /\.(las|laz)$/i.test(absLasPath);
    if (!shouldFallback) {
      removeDirIfExists(outDir);
      throw error;
    }
    console.warn('[Potree] Primary conversion failed, retrying with sanitized LAS:', error.message);
    removeDirIfExists(outDir);
    const sanitized = await sanitizeLasForPotree(absLasPath, sanitizeMode);
    const result = await convertLasToPotree(sanitized.outputPath, outDir);
    return {
      ...result,
      inputPath: sanitized.outputPath,
      sanitized: true,
      sanitizeMode: sanitized.classificationMode,
    };
  }
}

async function importLocalLasPath(absLasPath, {
  displayName = '',
} = {}) {
  const parentDir = path.dirname(absLasPath);
  const features = detectScannerFeatures(parentDir);
  const fileBaseName = path.basename(absLasPath).toLowerCase();
  const derivedAnalysisFile = isDerivedAnalysisLas(absLasPath);
  const treatAsScanner = !derivedAnalysisFile && (
    isLikelyScannerProject(features)
    || SCANNER_LAS_PREFERRED.includes(fileBaseName)
    || fs.existsSync(path.join(parentDir, 'converted'))
  );
  const existingMetadataPath = path.join(parentDir, 'converted', 'metadata.json');

  if (!derivedAnalysisFile && fs.existsSync(existingMetadataPath)) {
    if (treatAsScanner) {
      return registerLocalScannerProject({
        dirPath: parentDir,
        metadataPath: existingMetadataPath,
        displayName: displayName || path.basename(parentDir),
        originalPath: absLasPath,
        sourceType: 'desktop-local-scan-existing',
      });
    }
    return registerLocalStandalonePointcloud({
      metadataPath: existingMetadataPath,
      displayName: displayName || path.parse(absLasPath).name,
      originalPath: absLasPath,
      sourceType: 'desktop-local-las-existing',
    });
  }

  const outputDir = treatAsScanner
    ? path.join(parentDir, 'converted')
    : path.join(parentDir, `${path.parse(absLasPath).name}_converted`);
  const { metadataPath } = await convertLasToPotreeWithFallback(absLasPath, outputDir);

  if (treatAsScanner) {
    return registerLocalScannerProject({
      dirPath: parentDir,
      metadataPath,
      displayName: displayName || path.basename(parentDir),
      originalPath: absLasPath,
      sourceType: 'desktop-local-scan-converted',
      managedOutputDir: outputDir,
    });
  }

  return registerLocalStandalonePointcloud({
    metadataPath,
    displayName: displayName || path.parse(absLasPath).name,
    originalPath: absLasPath,
    sourceType: 'desktop-local-las-converted',
    managedOutputDir: outputDir,
  });
}

async function importLocalDirectoryPath(absDirPath, {
  displayName = '',
} = {}) {
  const directMetadataPath = path.join(absDirPath, 'metadata.json');
  const convertedMetadataPath = path.join(absDirPath, 'converted', 'metadata.json');

  if (fs.existsSync(convertedMetadataPath)) {
    return registerLocalScannerProject({
      dirPath: absDirPath,
      metadataPath: convertedMetadataPath,
      displayName: displayName || path.basename(absDirPath),
      sourceType: 'desktop-local-scan-existing',
    });
  }

  if (fs.existsSync(directMetadataPath)) {
    const parentDir = path.dirname(absDirPath);
    const parentFeatures = detectScannerFeatures(parentDir);
    if (path.basename(absDirPath).toLowerCase() === 'converted' && isLikelyScannerProject(parentFeatures)) {
      return registerLocalScannerProject({
        dirPath: parentDir,
        metadataPath: directMetadataPath,
        displayName: displayName || path.basename(parentDir),
        sourceType: 'desktop-local-scan-existing',
      });
    }
    return registerLocalStandalonePointcloud({
      metadataPath: directMetadataPath,
      displayName: displayName || path.basename(absDirPath),
      sourceType: 'desktop-local-potree-folder',
    });
  }

  const features = detectScannerFeatures(absDirPath);
  const bestLasPath = pickPreferredLasPath(absDirPath, features);
  if (bestLasPath) {
    return importLocalLasPath(bestLasPath, {
      displayName: displayName || (isLikelyScannerProject(features) ? path.basename(absDirPath) : path.parse(bestLasPath).name),
    });
  }

  const error = new Error('The selected folder does not contain a supported scanner project, LAS/LAZ source, or Potree metadata.json.');
  error.code = 'BAD_REQUEST';
  throw error;
}

async function importLocalEntryPath(absPath, {
  displayName = '',
} = {}) {
  absPath = ensureExistingBoundedPath(absPath, { fieldName: 'path' });
  if (!fs.existsSync(absPath)) {
    const error = new Error(`Path not found: ${absPath}`);
    error.code = 'FILE_NOT_FOUND';
    throw error;
  }

  const stat = fs.statSync(absPath);
  if (!stat.isDirectory() && !/\.(las|laz|obj)$/i.test(absPath)) {
    const error = new Error('Only LAS/LAZ, OBJ files, or folders can be imported.');
    error.code = 'BAD_REQUEST';
    throw error;
  }

  if (!stat.isDirectory() && /\.obj$/i.test(absPath)) {
    return {
      ok: true,
      entry: {
        displayName: displayName || path.basename(absPath),
        originalPath: absPath,
        sourceType: 'desktop-local-obj-file',
      },
      importedKind: 'meshFile',
      meshPath: absPath,
    };
  }

  return stat.isDirectory()
    ? importLocalDirectoryPath(absPath, { displayName })
    : importLocalLasPath(absPath, { displayName });
}

function listAvailablePhotoFrames(projectDir) {
  const collectSide = (side) => {
    const sideDir = path.join(projectDir, 'undistort', side);
    if (!fs.existsSync(sideDir)) return [];
    try {
      return fs.readdirSync(sideDir)
        .filter(name => /\.(jpe?g|png|webp)$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      console.warn(`[Scanner] Could not read ${sideDir}:`, error.message);
      return [];
    }
  };

  return {
    leftFiles: collectSide('left'),
    rightFiles: collectSide('right'),
  };
}

function getScannerProjectPointcloudInfo(projectName, projectId) {
  const candidates = [];
  for (const pointcloudDir of RUNTIME_STORAGE.pointclouds.candidates) {
    candidates.push(
      { cloudName: projectName, metadataPath: path.join(pointcloudDir, projectName, 'metadata.json') },
      { cloudName: projectId, metadataPath: path.join(pointcloudDir, projectId, 'metadata.json') },
    );
  }
  for (const projectDir of RUNTIME_STORAGE.projects.candidates) {
    candidates.push(
      { cloudName: projectName, metadataPath: path.join(projectDir, projectName, 'converted', 'metadata.json') },
      { cloudName: projectId, metadataPath: path.join(projectDir, projectId, 'converted', 'metadata.json') },
    );
  }

  for (const candidate of candidates) {
    if (!candidate.cloudName || !fs.existsSync(candidate.metadataPath)) continue;
    let pointCount = null;
    try {
      const meta = JSON.parse(fs.readFileSync(candidate.metadataPath, 'utf-8'));
      pointCount = meta.points ?? null;
    } catch { }
    return {
      hasPotree: true,
      pointCount,
      cloudName: candidate.cloudName,
      pointcloudUrl: `/pointclouds/${encodeURIComponent(candidate.cloudName)}/metadata.json`,
    };
  }

  return {
    hasPotree: false,
    pointCount: null,
    cloudName: null,
    pointcloudUrl: null,
  };
}

/**
 * Scan known directories for scanner projects
 */
function discoverScanProjects() {
  scanProjectRegistry.clear();

  for (const root of SCAN_PROJECT_ROOTS) {
    if (!fs.existsSync(root)) continue;

    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(root, entry.name);
      const features = detectScannerFeatures(dirPath);

      // It's a scanner project if it has scanner markers OR any LAS file
      // (any LAS in a SCAN_PROJECT_ROOTS subdir is relevant for DTM purposes)
      const isScanner = features.hasOdom || features.hasPotree || features.hasCameras ||
        features.hasGeo || features.hasColorizedLas || features.hasUncolorizedLas ||
        features.hasScanLas || features.hasAnyLas;
      if (isScanner) {
        const projectId = entry.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const pointcloudInfo = getScannerProjectPointcloudInfo(entry.name, projectId);
        if (pointcloudInfo.hasPotree) {
          features.hasPotree = true;
          features.pointCount = pointcloudInfo.pointCount;
        }
        scanProjectRegistry.set(projectId, {
          name: entry.name,
          dirPath,
          features,
          projectId,
          cloudName: pointcloudInfo.cloudName,
          pointcloudUrl: pointcloudInfo.pointcloudUrl,
        });
      }
    }
  }

  for (const entry of listLocalImportEntries()) {
    if (entry?.kind !== 'scannerProject' || !entry.dirPath || !fs.existsSync(entry.dirPath)) continue;
    const features = detectScannerFeatures(entry.dirPath);
    if (entry.metadataPath && fs.existsSync(entry.metadataPath)) {
      features.hasPotree = true;
      features.pointCount = readMetadataPointCount(entry.metadataPath);
    }
    scanProjectRegistry.set(entry.projectId, {
      name: entry.projectName || entry.displayName || path.basename(entry.dirPath),
      dirPath: entry.dirPath,
      features,
      projectId: entry.projectId,
      cloudName: entry.cloudName,
      pointcloudUrl: `/scan-data/${entry.projectId}/converted/metadata.json`,
    });
  }

  return Array.from(scanProjectRegistry.values());
}

// ── Dynamic static file serving for scanner projects ──
app.use('/scan-data/:projectId', (req, res, next) => {
  const project = scanProjectRegistry.get(req.params.projectId);
  if (!project) {
    return sendApiError(res, new Error('Scanner project not found'), { fallbackCode: 'PROJECT_NOT_FOUND', fallbackStatus: 404 });
  }
  if (!isSafePublicStaticRequest(req)) {
    return res.sendStatus(404);
  }
  // Serve files from the project directory
  express.static(project.dirPath, { dotfiles: 'deny', fallthrough: true, index: false, redirect: false })(req, res, next);
});

// ── API: List scanner projects ──
app.get('/api/scan-projects', (_req, res) => {
  try {
    const projects = discoverScanProjects();
    return sendApiSuccess(res, {
      projects: projects.map(p => ({
        projectId: p.projectId,
        name: p.name,
        dirPath: p.dirPath || null,
        features: p.features,
        sourceFiles: listScannerSourceFiles(p).map(file => ({
          ...file,
          absPath: path.join(p.dirPath, file.relPath),
        })),
        cloudName: p.cloudName || null,
        pointcloudUrl: p.pointcloudUrl || null,
        scanDataUrl: `/scan-data/${p.projectId}`,
        viewerUrl: p.pointcloudUrl ? buildScannerViewerUrl({
          projectId: p.projectId,
          metadataUrl: p.pointcloudUrl,
          projectName: p.name,
        }) : buildScannerViewerUrl({
          projectId: p.projectId,
          metadataUrl: '',
          projectName: p.name,
        }),
      }))
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.get('/api/scan-projects/photos', (req, res) => {
  try {
    const projectId = requireNonEmptyString(req.query.projectId, 'projectId', { code: 'BAD_REQUEST' });
    if (!scanProjectRegistry.has(projectId)) discoverScanProjects();
    const project = scanProjectRegistry.get(projectId);
    if (!project) {
      return sendApiError(res, new Error('Scanner project not found'), {
        fallbackCode: 'PROJECT_NOT_FOUND',
        fallbackStatus: 404,
      });
    }

    const manifest = listAvailablePhotoFrames(project.dirPath);
    return sendApiSuccess(res, {
      projectId,
      leftFiles: manifest.leftFiles,
      rightFiles: manifest.rightFiles,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'BAD_REQUEST', fallbackStatus: 400 });
  }
});

// ── API: Register a new scan project directory ──
// Local desktop compatibility is preserved by accepting the development upload
// credential when no explicit password env is required. Production/staging
// deployments must configure UPLOAD_REVIEW_PASSWORD_SHA256 before this write
// endpoint can be used.
app.post('/api/scan-projects/register', uploadCredentialJsonPrecheck, (req, res) => {
  try {
    const dirPath = ensureExistingBoundedPath(req.body?.dirPath, {
      fieldName: 'dirPath',
      missingCode: 'BAD_REQUEST',
      missingMessage: 'Directory not found',
      type: 'directory',
    });
    if (!SCAN_PROJECT_ROOTS.includes(dirPath)) {
      SCAN_PROJECT_ROOTS.push(dirPath);
      try {
        fs.writeFileSync(SCAN_ROOTS_CONFIG, JSON.stringify(SCAN_PROJECT_ROOTS, null, 2));
      } catch (e) {
        console.warn('[Scanner] Could not save scan_roots.json:', e.message);
      }
    }
    const projects = discoverScanProjects();
    return sendApiSuccess(res, { projects: projects.length, roots: SCAN_PROJECT_ROOTS });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'BAD_REQUEST', fallbackStatus: 400 });
  }
});

// ── API: Get scan roots ──
app.get('/api/scan-roots', (_req, res) => {
  return sendApiSuccess(res, { roots: SCAN_PROJECT_ROOTS });
});

// ── Standard routes ──
app.get('/', (_req, res) => {
  const desktopIndex = path.join(__dirname, 'desktop-index.html');
  res.sendFile(IS_DESKTOP_BUILD && fs.existsSync(desktopIndex)
    ? desktopIndex
    : path.join(__dirname, 'index.html'));
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.get('/viewer', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  const viewerPath = pathExists(EMBEDDED_VIEWER_HTML)
    ? EMBEDDED_VIEWER_HTML
    : path.join(__dirname, 'viewer.html');
  res.sendFile(viewerPath);
});

app.get('/gaussian-viewer', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.sendFile(path.join(__dirname, 'gaussian-viewer.html'));
});

app.get('/gaussian-viewer.html', (_req, res) => {
  res.redirect(302, '/gaussian-viewer');
});

app.get('/3dgs/:assetName', (req, res) => {
  try {
    const assetName = requireSafeCloudName(req.params.assetName);
    const manifest = readGaussianManifest(assetName);
    if (!manifest) {
      return res.status(404).send('3DGS scene not found');
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.redirect(302, buildGaussianEditorUrl(assetName, manifest, manifest.publish || {}));
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'BAD_REQUEST',
      fallbackStatus: error?.code === 'BAD_REQUEST' ? 400 : 500,
    });
  }
});

app.get(['/supersplat-viewer', '/supersplat-viewer/'], (req, res) => {
  try {
    const content = String(req.query.content || '');
    const match = decodeURIComponent(content).match(/\/gaussians\/([^/]+)/);
    if (!match) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      return res.redirect(302, '/');
    }
    const assetName = requireSafeCloudName(match[1]);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    return res.redirect(302, `/3dgs/${encodeURIComponent(assetName)}`);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'BAD_REQUEST',
      fallbackStatus: error?.code === 'BAD_REQUEST' ? 400 : 500,
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    platform: process.platform,
    desktop: false,
    converter: pathExists(CONVERTER),
    converterPath: CONVERTER,
    potreePath: POTREE_ROOT,
    exportPython: pathExists(PYTHON_BIN),
    exportPythonPath: PYTHON_BIN,
    systemPython: Boolean(SYSTEM_PYTHON_BIN),
    systemPythonPath: SYSTEM_PYTHON_BIN,
    desktopDialogs: false,
    desktopDialogsPath: null,
    exportScript: fs.existsSync(EXPORT_POINTCLOUD_SCRIPT),
    storage: getRuntimeStorageHealth(),
  });
});

// ── API: Get/Set CRS config per project ──
app.get('/api/scan-projects/crs', (req, res) => {
  try {
    const { crsFile } = getProjectCrsConfigPath(req.query.projectId);
    if (!fs.existsSync(crsFile)) {
      return res.json({ ok: false });
    }
    const config = JSON.parse(fs.readFileSync(crsFile, 'utf8'));
    return sendApiSuccess(res, { config });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.post('/api/scan-projects/crs', express.json(), (req, res) => {
  try {
    const { config } = req.body || {};
    const { crsFile } = getProjectCrsConfigPath(req.body?.projectId);
    fs.writeFileSync(crsFile, JSON.stringify(config, null, 2));
    return sendApiSuccess(res);
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.get('/api/crs/resolve', async (req, res) => {
  let normalized = null;
  try {
    const queryCode = String(req.query.code || '').trim();
    normalized = normalizeAuthorityCode(queryCode);
    if (!normalized) {
      const error = new Error('Invalid CRS authority code.');
      error.code = 'CRS_BAD_CODE';
      throw error;
    }
    const record = await resolveCrsDefinition(normalized.normalizedCode);
    if (String(req.query.kind || '').trim().toLowerCase() === 'geographic' && !isGeographicCrsRecord(record)) {
      const error = new Error(`Source CRS must be geographic. ${record.normalizedCode} is ${record?.summary?.kind || 'unsupported'}.`);
      error.code = 'SOURCE_CRS_MUST_BE_GEOGRAPHIC';
      throw error;
    }
    return res.json({
      ok: true,
      query: queryCode,
      normalizedCode: record.normalizedCode,
      authority: record.authority,
      code: record.code,
      name: record.name,
      proj4: record.proj4,
      projJson: record.projJson || null,
      summary: record.summary || null,
      source: record.source || { type: 'unknown', provider: 'local' },
      sourceGeodetic: isGeographicCrsRecord(record) ? buildSourceGeodeticContext(record, queryCode) : null,
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'CRS_INTERNAL_ERROR',
      extra: { normalizedCode: normalized?.normalizedCode || null },
    });
  }
});

app.get('/api/crs/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const kind = String(req.query.kind || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 8, 20));
    if (kind && kind !== 'geographic') {
      const error = new Error('Only geographic CRS search is supported for source CRS selection.');
      error.code = 'SOURCE_CRS_MUST_BE_GEOGRAPHIC';
      throw error;
    }
    const results = searchLocalGeographicCrs(query, limit).map(item => ({
      query,
      normalizedCode: item.code,
      name: item.name,
      kind: item.kind,
      proj4: item.proj4,
      summary: item.summary || null,
      source: item.source || { type: 'unknown', provider: 'local' },
      geographic3D: item.geographic3D || null,
      geocentric: item.geocentric || null,
    }));
    return sendApiSuccess(res, { query, kind: 'geographic', results });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'CRS_INTERNAL_ERROR',
      fallbackStatus: error?.code === 'SOURCE_CRS_MUST_BE_GEOGRAPHIC' ? 400 : 500,
    });
  }
});

app.get('/api/grids', async (_req, res) => {
  try {
    await ensureBuiltinGridsRegistered();
    const registry = loadGridRegistry();
    const installed = Object.values(registry)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      .map(sanitizeGridRecordForClient)
      .filter(Boolean);
    return res.json({
      ok: true,
      installed,
      catalog: loadGridCatalog(),
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'GRID_INTERNAL_ERROR' });
  }
});

// Multipart grid imports are API-facing; callers must send the upload password
// in X-CloudStudio-Upload-Password or query params so multer can reject before disk writes.
app.post('/api/grids/import', uploadCredentialPrecheck, gridUpload.single('gridFile'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    if (!req.file) {
      return sendApiError(res, new Error('Missing grid file upload.'), { fallbackCode: 'GRID_BAD_REQUEST', fallbackStatus: 400 });
    }

    const record = await registerGridFilePath({
      absPath: uploadedPath,
      originalName: req.file.originalname || req.file.filename,
      storedFileName: req.file.filename,
      sourceType: 'upload',
      scope: 'custom',
      note: 'Imported by user.',
    });
    return sendApiSuccess(res, {
      grid: sanitizeGridRecordForClient(record),
    });
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch { }
    }
    return sendApiError(res, error, { fallbackCode: 'GRID_VALIDATION_FAILED', fallbackStatus: 400 });
  }
});

// ── API: List point clouds (enhanced with scanner detection) ──
app.get('/api/clouds', (_req, res) => {
  try {
    const diskClouds = fs.readdirSync(POINTCLOUDS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => fs.existsSync(path.join(POINTCLOUDS_DIR, name, 'metadata.json')))
      .map(name => {
        const metaPath = path.join(POINTCLOUDS_DIR, name, 'metadata.json');
        let points = null;
        try {
          const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          points = m.points ?? null;
        } catch { }
        // Include scanner project info from source.json so homepage can show scanner badge
        let scannerProjectId = null;
        let scannerProjectName = null;
        let features = null;
        let sourceType = null;
        try {
          const manifest = readUploadSourceManifest(name);
          sourceType = manifest?.type || null;
          if (manifest?.scannerProjectId) {
            scannerProjectId = manifest.scannerProjectId;
            scannerProjectName = manifest.scannerProjectName || manifest.projectName || null;
            features = manifest.features || null;
          }
        } catch { }
        return {
          name,
          cloudName: name,
          points,
          scannerProjectId,
          scannerProjectName,
          features,
          sourceType,
          metadataUrl: `/pointclouds/${encodeURIComponent(name)}/metadata.json`,
          scanDataUrl: scannerProjectId ? `/scan-data/${encodeURIComponent(scannerProjectId)}` : null,
          viewerUrl: scannerProjectId
            ? buildScannerViewerUrl({
                projectId: scannerProjectId,
                metadataUrl: `/pointclouds/${encodeURIComponent(name)}/metadata.json`,
                projectName: scannerProjectName || name,
              })
            : `/viewer?pointcloud=${encodeURIComponent(`/pointclouds/${name}/metadata.json`)}`,
        };
      });

    const gaussianClouds = fs.readdirSync(GAUSSIANS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .map(name => {
        const manifestPath = path.join(GAUSSIANS_DIR, name, 'source.json');
        if (!fs.existsSync(manifestPath)) return null;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          return buildGaussianCloudListEntry(name, manifest);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const localClouds = listLocalImportEntries()
      .filter(entry => entry?.metadataPath && fs.existsSync(entry.metadataPath))
      .map(entry => ({
        name: entry.displayName || entry.cloudName,
        cloudName: entry.cloudName,
        points: entry.points ?? readMetadataPointCount(entry.metadataPath),
        scannerProjectId: entry.projectId || null,
        scannerProjectName: entry.projectName || null,
        features: entry.features || null,
        sourceType: entry.sourceType || 'desktop-local-import',
        metadataUrl: entry.metadataUrl || buildLocalPointcloudMetadataUrl(entry.cloudName),
        sourcePath: entry.dirPath || entry.originalPath || path.dirname(entry.metadataPath),
        isExternal: true,
        scanDataUrl: entry.projectId ? `/scan-data/${encodeURIComponent(entry.projectId)}` : null,
        viewerUrl: entry.projectId
          ? buildScannerViewerUrl({
              projectId: entry.projectId,
              metadataUrl: entry.metadataUrl || buildLocalPointcloudMetadataUrl(entry.cloudName),
              projectName: entry.projectName || entry.displayName || entry.cloudName,
            })
          : `/viewer?pointcloud=${encodeURIComponent(entry.metadataUrl || buildLocalPointcloudMetadataUrl(entry.cloudName))}`,
      }));

    const scannerClouds = discoverScanProjects()
      .filter(entry => entry?.pointcloudUrl)
      .map(entry => ({
        name: entry.name,
        cloudName: entry.cloudName || entry.name,
        points: entry.features?.pointCount ?? null,
        scannerProjectId: entry.projectId,
        scannerProjectName: entry.name,
        features: entry.features || null,
        sourceType: 'scan-project',
        metadataUrl: entry.pointcloudUrl,
        sourcePath: entry.dirPath,
        scanDataUrl: `/scan-data/${encodeURIComponent(entry.projectId)}`,
        viewerUrl: buildScannerViewerUrl({
          projectId: entry.projectId,
          metadataUrl: entry.pointcloudUrl,
          projectName: entry.name,
        }),
      }));

    const seen = new Set();
    const mergedClouds = [...gaussianClouds, ...localClouds, ...scannerClouds, ...diskClouds].filter((entry) => {
      const key = `${entry.resourceType || 'pointcloud'}::${entry.cloudName || entry.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return sendApiSuccess(res, { clouds: mergedClouds });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.get('/api/export-sources', (req, res) => {
  try {
    const context = getDatasetContext(req.query);
    return sendApiSuccess(res, {
      context: context.type === 'scanner'
        ? {
          type: 'scanner',
          projectId: context.projectId,
          name: context.name,
          geoInfoAvailable: context.geoInfoAvailable,
        }
        : {
          type: 'cloud',
          cloudName: context.cloudName,
          name: context.name,
          geoInfoAvailable: false,
        },
      sources: context.sourceFiles,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

function buildSafeZipPythonHelpers() {
  return `
import os, re, stat

ZIP_MAX_FILES = ${ZIP_MAX_FILES}
ZIP_MAX_TOTAL_BYTES = ${ZIP_MAX_TOTAL_BYTES}
ZIP_MAX_FILE_BYTES = ${ZIP_MAX_FILE_BYTES}

class ZipValidationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

def zip_error_payload(error):
    code = getattr(error, 'code', 'UNSAFE_ZIP_ENTRY')
    return {'errorCode': code, 'error': str(error)}

def should_skip_zip_member(filename):
    parts = filename.replace('\\\\', '/').split('/')
    return any(p == '__MACOSX' or p.startswith('._') for p in parts)

def validate_zip_member(member):
    raw = member.filename or ''
    name = raw.replace('\\\\', '/')
    stripped = name.rstrip('/')
    if not stripped:
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry has an empty path.')
    if name.startswith('/') or name.startswith('//') or re.match(r'^[A-Za-z]:', name):
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry uses an absolute path: ' + raw)
    parts = stripped.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry contains unsafe path segments: ' + raw)

    mode = (member.external_attr >> 16) & 0o177777
    if mode:
        file_type = stat.S_IFMT(mode)
        if file_type and file_type not in (stat.S_IFREG, stat.S_IFDIR):
            raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry is not a regular file or directory: ' + raw)
    return '/'.join(parts)

def assert_safe_zip_archive(zf):
    file_count = 0
    total_size = 0
    for member in zf.infolist():
        if should_skip_zip_member(member.filename or ''):
            continue
        validate_zip_member(member)
        if member.is_dir():
            continue
        file_count += 1
        if file_count > ZIP_MAX_FILES:
            raise ZipValidationError('ZIP_TOO_LARGE', 'ZIP contains too many files.')
        size = int(getattr(member, 'file_size', 0) or 0)
        if size < 0:
            raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry has an invalid size: ' + member.filename)
        if size > ZIP_MAX_FILE_BYTES:
            raise ZipValidationError('ZIP_TOO_LARGE', 'ZIP entry is too large: ' + member.filename)
        total_size += size
        if total_size > ZIP_MAX_TOTAL_BYTES:
            raise ZipValidationError('ZIP_TOO_LARGE', 'ZIP extracted size is too large.')

def safe_zip_target(dest_dir, rel_path):
    rel = rel_path.replace('\\\\', '/')
    stripped = rel.rstrip('/')
    if not stripped:
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry has an empty extraction path.')
    parts = stripped.split('/')
    if any(p in ('', '.', '..') for p in parts):
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry contains unsafe extraction path: ' + rel_path)
    dest_real = os.path.realpath(dest_dir)
    target = os.path.join(dest_dir, *parts)
    target_real = os.path.realpath(target)
    if os.path.commonpath([dest_real, target_real]) != dest_real:
        raise ZipValidationError('UNSAFE_ZIP_ENTRY', 'ZIP entry would escape extraction directory: ' + rel_path)
    return target

def write_zip_member(zf, member, dest_dir, rel_path):
    target = safe_zip_target(dest_dir, rel_path)
    if member.is_dir():
        os.makedirs(target, exist_ok=True)
        return
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with zf.open(member) as src, open(target, 'wb') as dst:
        shutil.copyfileobj(src, dst)
`;
}

function buildScannerProjectZipExtractScript() {
  return `
import zipfile, os, sys, json, shutil, re
${buildSafeZipPythonHelpers()}

zip_path   = sys.argv[1]
projects_dir = sys.argv[2]
name_override = sys.argv[3]   # may be empty string

def safe_name(s):
    return re.sub(r'[^a-zA-Z0-9._-]', '_', s)

try:
    with zipfile.ZipFile(zip_path, 'r') as zf:
        assert_safe_zip_archive(zf)
        names = zf.namelist()
        # Detect if all entries share a common root folder (ignore Mac __MACOSX metadata)
        roots = set()
        for n in names:
            if should_skip_zip_member(n):
                continue
            safe_rel = validate_zip_member(zf.getinfo(n))
            parts = safe_rel.split('/')
            if parts[0]:
                roots.add(parts[0])
        real_names = [n for n in names if not should_skip_zip_member(n)]
        has_root_folder = len(roots) == 1 and any('/' in n for n in real_names)
        detected_root = list(roots)[0] if has_root_folder else None

        # Determine project name
        if name_override:
            project_name = safe_name(name_override)
        elif detected_root:
            project_name = safe_name(detected_root)
        else:
            project_name = safe_name(os.path.splitext(os.path.basename(zip_path))[0])
            # Strip timestamp prefix if any (e.g. "1234567890_scan" -> "scan")
            project_name = re.sub(r'^\\d+_', '', project_name)

        dest_dir = os.path.join(projects_dir, project_name)
        os.makedirs(dest_dir, exist_ok=True)

        if has_root_folder:
            # Strip the root folder prefix when extracting
            prefix = detected_root + '/'
            for member in zf.infolist():
                rel = member.filename
                if should_skip_zip_member(rel):
                    continue
                safe_rel = validate_zip_member(member)
                if not safe_rel.startswith(prefix):
                    continue
                rel_stripped = safe_rel[len(prefix):]
                if not rel_stripped:
                    continue
                write_zip_member(zf, member, dest_dir, rel_stripped)
        else:
            # Flat: extract everything directly into dest_dir
            for member in zf.infolist():
                rel = member.filename
                if should_skip_zip_member(rel):
                    continue
                if member.is_dir():
                    continue
                safe_rel = validate_zip_member(member)
                write_zip_member(zf, member, dest_dir, safe_rel)

        # Find LAS/LAZ files in the extracted directory
        las_files = []
        for root, dirs, files in os.walk(dest_dir):
            # Skip converted potree data and Mac metadata folders
            dirs[:] = [d for d in dirs if d not in ('converted', '__MACOSX')]
            for f in files:
                # Skip Mac resource fork files (._filename)
                if f.startswith('._'):
                    continue
                if f.lower().endswith(('.las', '.laz')):
                    las_files.append(os.path.relpath(os.path.join(root, f), dest_dir))

        # Pick best LAS: prefer colorized > uncolorized > any
        # IMPORTANT: check 'uncolorized' BEFORE 'colorized' because 'colorized' is a substring.
        def las_priority(p):
            n = os.path.basename(p).lower()
            if 'uncolorized' in n: return 2
            if 'colorized' in n: return 1
            if 'scan_resumer' in n: return 3
            return 2

        las_files.sort(key=las_priority)

        print(json.dumps({
            'projectName': project_name,
            'destDir': dest_dir,
            'lasFiles': las_files,
            'bestLas': las_files[0] if las_files else None,
            'hasGeo': os.path.exists(os.path.join(dest_dir, 'geo_info.csv')),
            'hasOdom': os.path.exists(os.path.join(dest_dir, 'odom.csv')),
            'hasCameras': os.path.exists(os.path.join(dest_dir, 'ImgPose.txt')),
        }))
except zipfile.BadZipFile:
    print(json.dumps({'errorCode': 'INVALID_POTREE_ZIP', 'error': 'File is not a valid ZIP archive.'}))
except ZipValidationError as e:
    print(json.dumps(zip_error_payload(e)))
`;
}

function buildPreconvertedZipExtractScript() {
  return `
import zipfile, os, sys, json, shutil, re
${buildSafeZipPythonHelpers()}

zip_path = sys.argv[1]
pointclouds_dir = sys.argv[2]
name_override = sys.argv[3]

def safe_name(s):
    return re.sub(r'[^a-zA-Z0-9._-]', '_', s)

try:
    with zipfile.ZipFile(zip_path, 'r') as zf:
        assert_safe_zip_archive(zf)
        names = zf.namelist()
        real_names = [n for n in names if not should_skip_zip_member(n)]

        # Find metadata.json (Potree 2.0 marker)
        meta_paths = []
        for n in real_names:
            member = zf.getinfo(n)
            safe_rel = validate_zip_member(member)
            if os.path.basename(safe_rel) == 'metadata.json' and not member.is_dir():
                meta_paths.append(safe_rel)
        if not meta_paths:
            print(json.dumps({'errorCode': 'INVALID_POTREE_ZIP', 'error': 'No metadata.json found in ZIP. This does not appear to be a Potree 2.0 octree. Please convert your LAS file with PotreeConverter first, then ZIP the output folder.'}))
            sys.exit(0)

        # Use the shallowest metadata.json
        meta_paths.sort(key=lambda x: x.count('/'))
        meta_path = meta_paths[0]

        # Determine prefix (folder inside ZIP) and cloud name
        parts = meta_path.split('/')
        if len(parts) == 1:
            prefix = ''
            zip_stem = os.path.splitext(os.path.basename(zip_path))[0]
            detected_name = safe_name(re.sub(r'^\\d+_', '', zip_stem))
        else:
            prefix = '/'.join(parts[:-1]) + '/'
            detected_name = safe_name(parts[0])

        cloud_name = safe_name(name_override) if name_override else detected_name
        dest_dir = os.path.join(pointclouds_dir, cloud_name)

        if os.path.exists(dest_dir):
            shutil.rmtree(dest_dir)
        os.makedirs(dest_dir, exist_ok=True)

        for member in zf.infolist():
            rel = member.filename
            if should_skip_zip_member(rel):
                continue
            safe_rel = validate_zip_member(member)
            if prefix:
                if not safe_rel.startswith(prefix):
                    continue
                rel_stripped = safe_rel[len(prefix):]
            else:
                rel_stripped = safe_rel
            if not rel_stripped or member.is_dir():
                continue
            write_zip_member(zf, member, dest_dir, rel_stripped)

        meta_dest = os.path.join(dest_dir, 'metadata.json')
        if not os.path.exists(meta_dest):
            print(json.dumps({'errorCode': 'INVALID_POTREE_ZIP', 'error': 'Extraction failed: metadata.json not found in extracted output. Check ZIP structure.'}))
            sys.exit(0)

        points = None
        try:
            with open(meta_dest) as f:
                meta = json.load(f)
            points = meta.get('points')
        except:
            pass

        print(json.dumps({'cloudName': cloud_name, 'destDir': dest_dir, 'points': points}))
except zipfile.BadZipFile:
    print(json.dumps({'errorCode': 'INVALID_POTREE_ZIP', 'error': 'File is not a valid ZIP archive.'}))
except ZipValidationError as e:
    print(json.dumps(zip_error_payload(e)))
`;
}

// ── Upload and convert ──
app.post('/api/upload', uploadCredentialPrecheck, upload.single('pointcloud'), (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    verifyUploadCredentialFromRequest(req);
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch { }
    }
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }

  if (!req.file) {
    return sendApiError(res, new Error('Missing file field: pointcloud'), { fallbackCode: 'MISSING_POINTCLOUD_FILE', fallbackStatus: 400 });
  }

  if (!fs.existsSync(CONVERTER)) {
    return sendApiError(res, new Error('PotreeConverter not found'), {
      fallbackCode: 'CONVERTER_NOT_FOUND',
      extra: { converter: CONVERTER },
    });
  }

  const cloudName = (req.body.name || path.parse(req.file.originalname).name)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const outDir = path.join(POINTCLOUDS_DIR, cloudName);
  fs.mkdirSync(outDir, { recursive: true });

  const inputPath = req.file.path;
  const args = [inputPath, '-o', outDir];

  const proc = spawn(CONVERTER, args, { cwd: ROOT });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', d => (stdout += d.toString()));
  proc.stderr.on('data', d => (stderr += d.toString()));

  proc.on('close', code => {
    const metadata = path.join(outDir, 'metadata.json');
    const ok = code === 0 && fs.existsSync(metadata);

    if (ok) {
      try {
        // Try to detect if this file belongs to a known scanner project (by filename match)
        let detectedProject = null;
        const originalBaseName = req.file.originalname; // e.g. 'colorized.las'
        try {
          discoverScanProjects();
          for (const [, proj] of scanProjectRegistry) {
            const candidate = path.join(proj.dirPath, originalBaseName);
            if (fs.existsSync(candidate)) {
              detectedProject = proj;
              break;
            }
            // Also check if the lasFiles list matches
            if (proj.features?.lasFiles?.includes(originalBaseName)) {
              detectedProject = proj;
              break;
            }
          }
        } catch (e) {
          console.warn('[Upload] Scanner project detection failed:', e.message);
        }

        const sourceData = {
          type: 'upload',
          uploadFilename: req.file.filename,
          originalName: req.file.originalname,
          uploadedAt: new Date().toISOString(),
        };

        if (detectedProject) {
          sourceData.scannerProjectId = detectedProject.projectId;
          sourceData.scannerProjectName = detectedProject.name;
          sourceData.originalPath = path.join(detectedProject.dirPath, originalBaseName);
          console.log(`[Upload] Linked cloud '${cloudName}' → scanner project '${detectedProject.name}'`);
        }

        fs.writeFileSync(path.join(outDir, 'source.json'), JSON.stringify(sourceData, null, 2));
      } catch (error) {
        console.warn('[Export] Failed to write source manifest:', error.message);
      }
    }

    const lasErrorMsg = buildConversionFailureMessage({ ok, code, metadataPath: metadata, stdout, stderr });
    return res.status(ok ? 200 : 500).json({
      ok,
      code,
      errorCode: ok ? null : 'CONVERSION_FAILED',
      error: lasErrorMsg,
      cloudName,
      viewerUrl: ok ? `/viewer?pointcloud=%2Fpointclouds%2F${encodeURIComponent(cloudName)}%2Fmetadata.json` : null,
      metadataExists: fs.existsSync(metadata),
      stdout: stdout.slice(-4000),
      stderr: stderr.slice(-4000)
    });
  });
});

// ── Upload scanner project folder as ZIP ────────────────────────────
// Extracts zip → projects/{name}/, auto-discovers as scanner project,
// then runs PotreeConverter on any LAS found inside.
app.post('/api/upload-project', uploadCredentialPrecheck, zipUpload.single('projectzip'), (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    verifyUploadCredentialFromRequest(req);
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch { }
    }
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }

  if (!req.file) {
    return sendApiError(res, new Error('Missing file field: projectzip'), { fallbackCode: 'MISSING_ZIP_FILE', fallbackStatus: 400 });
  }

  const zipPath = req.file.path;

  // ── Step 1: Determine project name from zip or override ──────────
  const nameOverride = (req.body.name || '').trim();

  // ── Step 2: Use Python3 zipfile to peek at zip structure, then extract ──
  const extractScript = buildScannerProjectZipExtractScript();

  const pyProc = spawn(SYSTEM_PYTHON_BIN, ['-c', extractScript, zipPath, PROJECTS_DIR, nameOverride], { env: buildPythonEnv() });
  let pyOut = '';
  let pyErr = '';
  pyProc.stdout.on('data', d => (pyOut += d.toString()));
  pyProc.stderr.on('data', d => (pyErr += d.toString()));

  pyProc.on('close', (pyCode) => {
    // Clean up zip temp file
    try { fs.unlinkSync(zipPath); } catch { }

    if (pyCode !== 0) {
      return sendApiError(res, new Error('解压失败: ' + pyErr.slice(0, 500)), { fallbackCode: 'EXTRACT_FAILED' });
    }

    let info;
    try {
      info = JSON.parse(pyOut.trim());
    } catch (e) {
      return sendApiError(res, new Error('解析解压信息失败: ' + pyOut), { fallbackCode: 'EXTRACT_PARSE_FAILED' });
    }
    if (info.error) {
      const error = new Error(info.error);
      error.code = info.errorCode || 'EXTRACT_FAILED';
      return sendApiError(res, error, { fallbackCode: error.code, fallbackStatus: 400 });
    }

    const { projectName, destDir, bestLas } = info;

    // Refresh scanner registry so this project shows up
    discoverScanProjects();

    // ── Step 3: Auto-convert LAS if not already done ────────────────
    const convertedDir = path.join(destDir, 'converted');
    const metadataPath = path.join(convertedDir, 'metadata.json');

    if (!bestLas || fs.existsSync(metadataPath)) {
      const alreadyConverted = fs.existsSync(metadataPath);
      const cloudName = bestLas ? projectName : null;

      if (alreadyConverted) {
        const pointcloudDir = path.join(POINTCLOUDS_DIR, projectName);
        if (!fs.existsSync(pointcloudDir)) {
          try {
            fs.symlinkSync(convertedDir, pointcloudDir, 'dir');
          } catch (e) {
            console.warn(`[ZIP Upload] Failed to link converted project into pointclouds/: ${e.message}`);
          }
        }
      }

      discoverScanProjects();

      // No LAS to convert, or already converted — done.
      return res.json({
        ok: true,
        projectName,
        cloudName,
        alreadyConverted,
        hasLas: !!bestLas,
        features: { hasGeo: info.hasGeo, hasOdom: info.hasOdom, hasCameras: info.hasCameras },
        lasFiles: info.lasFiles,
        viewerUrl: alreadyConverted
          ? `/viewer?pointcloud=%2Fpointclouds%2F${encodeURIComponent(projectName)}%2Fmetadata.json`
          : null,
      });
    }

    // Run PotreeConverter; output goes into pointclouds/{projectName}/
    const lasAbsPath = path.join(destDir, bestLas);
    const cloudName = projectName;
    const outDir = path.join(POINTCLOUDS_DIR, cloudName);
    fs.mkdirSync(outDir, { recursive: true });

    console.log(`[ZIP Upload] Project: ${projectName}, LAS files found: [${info.lasFiles.join(', ')}]`);
    console.log(`[ZIP Upload] Selected for conversion: ${lasAbsPath}`);
    console.log(`[ZIP Upload] Output dir: ${outDir}`);

    // Verify LAS file exists before spawning converter
    if (!fs.existsSync(lasAbsPath)) {
      return res.status(500).json({
        ok: false, projectName, error: `LAS 文件路径不存在: ${lasAbsPath}。找到的 LAS 列表: [${info.lasFiles.join(', ')}]`,
        errorCode: 'LAS_NOT_FOUND',
      });
    }

    if (!fs.existsSync(CONVERTER)) {
      return res.status(500).json({
        ok: false, projectName, error: `PotreeConverter 未找到: ${CONVERTER}`,
        errorCode: 'CONVERTER_NOT_FOUND',
        note: '项目文件夹已解压到 projects/' + projectName + '，但 LAS 转换失败（找不到转换器）',
      });
    }

    console.log(`[ZIP Upload] Spawning: ${CONVERTER} ${lasAbsPath} -o ${outDir}`);

    const conv = spawn(CONVERTER, [lasAbsPath, '-o', outDir], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    conv.stdout.on('data', d => (stdout += d.toString()));
    conv.stderr.on('data', d => (stderr += d.toString()));

    conv.on('close', (code) => {
      const metadataExists = fs.existsSync(path.join(outDir, 'metadata.json'));
      const ok = code === 0 && metadataExists;

      if (ok) {
        // Write source manifest linking back to project folder
        const scannerProjectId = projectName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const sourceData = {
          type: 'project-upload',
          projectName,
          projectDir: destDir,
          lasFile: bestLas,
          uploadedAt: new Date().toISOString(),
          features: { hasGeo: info.hasGeo, hasOdom: info.hasOdom, hasCameras: info.hasCameras },
          // Link back to the scanner project so viewer can auto-detect it
          scannerProjectId,
          scannerProjectName: projectName,
          scanDataUrl: `/scan-data/${scannerProjectId}`,
        };
        try {
          fs.writeFileSync(path.join(outDir, 'source.json'), JSON.stringify(sourceData, null, 2));
        } catch { }
        discoverScanProjects();
      }

      // Build a human-readable error message for the client
      const errDetail = (stderr || stdout).slice(-400).trim();
      const errorMsg = ok ? null
        : !metadataExists && code === 0
          ? `PotreeConverter 运行结束但未生成 metadata.json（LAS 格式可能不兼容）`
          : errDetail
            ? `PotreeConverter 退出码 ${code}：${errDetail}`
            : `PotreeConverter 退出码 ${code}，无详细输出。请用 pm2 logs cloudstudio 查看服务端日志。`;

      res.status(ok ? 200 : 500).json({
        ok,
        projectName,
        cloudName,
        features: { hasGeo: info.hasGeo, hasOdom: info.hasOdom, hasCameras: info.hasCameras },
        lasFiles: info.lasFiles,
        viewerUrl: ok ? `/viewer?pointcloud=%2Fpointclouds%2F${encodeURIComponent(cloudName)}%2Fmetadata.json` : null,
        // Even on failure, project folder is accessible at /projects/{projectName}/
        projectUrl: `/projects/${projectName}/`,
        errorCode: ok ? null : 'CONVERSION_FAILED',
        error: errorMsg,
        stdout: stdout.slice(-3000),
        stderr: stderr.slice(-3000),
      });
    });
  });
});

// ── Upload pre-converted Potree octree ZIP ──────────────────────────
// User already ran PotreeConverter locally and zipped the output folder.
// This just extracts the ZIP into pointclouds/ and verifies the structure.
app.post('/api/upload-preconverted', uploadCredentialPrecheck, zipUpload.single('potreezip'), (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    verifyUploadCredentialFromRequest(req);
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch { }
    }
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }

  if (!req.file) {
    return sendApiError(res, new Error('Missing file field: potreezip'), { fallbackCode: 'MISSING_ZIP_FILE', fallbackStatus: 400 });
  }

  const zipPath = req.file.path;
  const nameOverride = (req.body.name || '').trim();
  const extractScript = buildPreconvertedZipExtractScript();

  const pyProc = spawn(SYSTEM_PYTHON_BIN, ['-c', extractScript, zipPath, POINTCLOUDS_DIR, nameOverride], { env: buildPythonEnv() });
  let pyOut = '';
  let pyErr = '';
  pyProc.stdout.on('data', d => (pyOut += d.toString()));
  pyProc.stderr.on('data', d => (pyErr += d.toString()));

  pyProc.on('close', (pyCode) => {
    try { fs.unlinkSync(zipPath); } catch { }

    if (pyCode !== 0) {
      return sendApiError(res, new Error('Extraction failed: ' + pyErr.slice(0, 500)), { fallbackCode: 'EXTRACT_FAILED' });
    }

    let info;
    try {
      info = JSON.parse(pyOut.trim());
    } catch (e) {
      return sendApiError(res, new Error('Failed to parse extraction result: ' + pyOut), { fallbackCode: 'EXTRACT_PARSE_FAILED' });
    }

    if (info.error) {
      const error = new Error(info.error);
      error.code = info.errorCode || 'INVALID_POTREE_ZIP';
      return sendApiError(res, error, { fallbackCode: error.code, fallbackStatus: 400 });
    }

    const { cloudName, destDir, points } = info;

    try {
      fs.writeFileSync(path.join(destDir, 'source.json'), JSON.stringify({
        type: 'preconverted-upload',
        cloudName,
        uploadedAt: new Date().toISOString(),
        points,
      }, null, 2));
    } catch (e) {
      console.warn('[Preconverted] Failed to write source.json:', e.message);
    }

    console.log(`[Preconverted] Uploaded pre-converted cloud: ${cloudName} (${points ?? 'unknown'} pts)`);
    return res.json({
      ok: true,
      cloudName,
      points,
      viewerUrl: `/viewer?pointcloud=%2Fpointclouds%2F${encodeURIComponent(cloudName)}%2Fmetadata.json`,
    });
  });
});


// ── Upload Gaussian / 3DGS asset ──────────────────────────────────
app.post('/api/upload-gaussian', uploadCredentialPrecheck, upload.single('gaussianFile'), async (req, res) => {
  const uploadedPath = req.file?.path;
  try {
    verifyUploadCredentialFromRequest(req);
  } catch (error) {
    if (uploadedPath && fs.existsSync(uploadedPath)) {
      try { fs.unlinkSync(uploadedPath); } catch {}
    }
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }

  if (!req.file) {
    return sendApiError(res, new Error('Missing file field: gaussianFile'), { fallbackCode: 'MISSING_POINTCLOUD_FILE', fallbackStatus: 400 });
  }

  const originalName = req.file.originalname || '';
  const ext = path.extname(originalName).toLowerCase();
  if (!GAUSSIAN_UPLOAD_EXTENSIONS.has(ext)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return sendApiError(res, new Error(`Unsupported Gaussian file format: ${ext || 'unknown'}. Upload a supported 3DGS file.`), {
      fallbackCode: 'BAD_REQUEST',
      fallbackStatus: 400,
    });
  }

  const { assetName, assetDir } = getUniqueGaussianAssetDir(req.body.name || path.parse(originalName).name);
  fs.mkdirSync(assetDir, { recursive: true });

  const targetName = `scene${ext}`;
  const targetPath = path.join(assetDir, targetName);
  try {
    fs.renameSync(req.file.path, targetPath);
  } catch (error) {
    try {
      fs.copyFileSync(req.file.path, targetPath);
      fs.unlinkSync(req.file.path);
    } catch (copyError) {
      return sendApiError(res, copyError, { fallbackCode: 'INTERNAL_ERROR' });
    }
  }

  const sourceBytes = fs.statSync(targetPath).size;
  const uploadedAt = new Date().toISOString();
  const directManifest = createGaussianDirectManifest(assetName, {
    assetDir,
    originalName,
    targetName,
    sourceBytes,
    uploadedAt,
  });

  if (ext === '.ply') {
    const runtimeName = 'scene.sog';
    const runtimePath = path.join(assetDir, runtimeName);
    void enqueueGaussianConversion(() => optimizeGaussianAssetToSog({
      assetName,
      assetDir,
      originalName,
      targetName,
      targetPath,
      runtimeName,
      runtimePath,
      sourceBytes,
    })).catch(error => {
      console.warn(`[Gaussian] Queue execution failed for ${assetName}:`, error?.message || error);
    });
  }

  return sendApiSuccess(res, {
    assetName,
    cloudName: assetName,
    resourceType: 'gaussian',
    format: directManifest.format,
    originalBytes: directManifest.originalBytes,
    runtimeBytes: null,
    conversionDurationMs: null,
    fileUrl: directManifest.fileUrl,
    sourceFileUrl: directManifest.sourceFileUrl || null,
    viewerUrl: directManifest.viewerUrl,
    viewerRotation: directManifest.viewerRotation,
    directBrowseStatus: directManifest.directBrowseStatus,
    optimizationStatus: directManifest.optimizationStatus,
    optimizationEligible: directManifest.publish?.optimizationEligible || false,
    optimizationPipeline: directManifest.publish?.optimizationPipeline || null,
    publish: directManifest.publish,
    note: directManifest.note,
  });
});

// ── Upload by server-side path (for importing classified LAS etc.) ──
app.post('/api/upload-by-path', (req, res) => {
  try {
    verifyUploadPassword(req.body?.uploadPassword);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'WRONG_PASSWORD',
      fallbackStatus: 403,
    });
  }

  const { filePath, name } = req.body;

  if (!filePath) {
    return sendApiError(res, new Error('filePath is required'), { fallbackCode: 'MISSING_FILE_PATH', fallbackStatus: 400 });
  }

  let absPath;
  try {
    absPath = ensureExistingBoundedPath(filePath, {
      fieldName: 'filePath',
      missingCode: 'FILE_NOT_FOUND',
      type: 'file',
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: error?.code || 'FILE_NOT_FOUND', fallbackStatus: 400 });
  }

  if (!/\.(las|laz)$/i.test(absPath)) {
    return sendApiError(res, new Error('Only LAS/LAZ files can be imported by path'), { fallbackCode: 'BAD_REQUEST', fallbackStatus: 400 });
  }

  if (!fs.existsSync(CONVERTER)) {
    return sendApiError(res, new Error('PotreeConverter not found'), { fallbackCode: 'CONVERTER_NOT_FOUND' });
  }

  const cloudName = (name || path.parse(absPath).name)
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const outDir = path.join(POINTCLOUDS_DIR, cloudName);
  (async () => {
    try {
      const result = await convertLasToPotreeWithFallback(absPath, outDir);
      try {
        fs.writeFileSync(path.join(outDir, 'source.json'), JSON.stringify({
          type: 'import-by-path',
          originalPath: absPath,
          originalName: path.basename(absPath),
          convertedInputPath: result.inputPath || absPath,
          sanitizedForPotree: Boolean(result.sanitized),
          sanitizeMode: result.sanitizeMode || null,
          importedAt: new Date().toISOString(),
        }, null, 2));
      } catch (e) {
        console.warn('[Upload-by-path] Failed to write source.json:', e.message);
      }

      res.status(200).json({
        ok: true,
        code: 0,
        errorCode: null,
        cloudName,
        viewerUrl: `/viewer?pointcloud=%2Fpointclouds%2F${encodeURIComponent(cloudName)}%2Fmetadata.json`,
        metadataExists: true,
        error: null,
        sanitizedForPotree: Boolean(result.sanitized),
      });
    } catch (error) {
      removeDirIfExists(outDir);
      res.status(500).json({
        ok: false,
        code: null,
        errorCode: error.code || 'CONVERSION_FAILED',
        cloudName,
        viewerUrl: null,
        metadataExists: false,
        error: error.message,
      });
    }
  })();
});

app.post('/api/export-pointcloud', (req, res) => {
  handlePointcloudExport(req, res);
});

app.post('/api/export-las', (req, res) => {
  handlePointcloudExport(req, res, { forceFormat: 'las', legacyLasResponse: true });
});

app.post('/api/crs/transform', (req, res) => {
  if (!fs.existsSync(PYTHON_BIN)) {
    return sendApiError(res, new Error(`导出环境未安装: ${PYTHON_BIN}`), { fallbackCode: 'EXPORT_ENV_MISSING' });
  }
  if (!fs.existsSync(CRS_TRANSFORM_SCRIPT)) {
    return sendApiError(res, new Error(`坐标变换脚本不存在: ${CRS_TRANSFORM_SCRIPT}`), { fallbackCode: 'EXPORT_SCRIPT_MISSING' });
  }

  (async () => {
    try {
      const pointsWgs84 = Array.isArray(req.body?.pointsWgs84) ? req.body.pointsWgs84 : [];
      const localPoints = Array.isArray(req.body?.localPoints) ? req.body.localPoints : [];
      if (!pointsWgs84.length && !localPoints.length) {
        const error = new Error('缺少待变换坐标点');
        error.code = 'BAD_REQUEST';
        throw error;
      }

      const payload = {
        coordConfig: req.body?.coordConfig || {},
        sourceGeodetic: req.body?.sourceGeodetic || req.body?.coordConfig?.sourceGeodetic || null,
        resolvedCoordinateSystem: req.body?.resolvedCoordinateSystem || { kind: 'local', label: '本地坐标' },
        geoInfo: req.body?.geoInfo || null,
        localPoints,
        pointsWgs84,
        originWgs84: req.body?.originWgs84 || null,
        gridRegistryPath: GRID_REGISTRY_FILE,
      };

      const { code, stdout, stderr } = await runPythonConfigJob(CRS_TRANSFORM_SCRIPT, payload, {
        configDir: CACHE_DIR,
        configPrefix: 'crs_transform',
      });

      if (code !== 0) {
        const detailedError = summarizeExportProcessError(stdout, stderr);
        return res.status(500).json({
          ok: false,
          error: detailedError || '原生坐标变换失败',
          errorCode: 'EXPORT_FAILED',
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
        });
      }

      try {
        const result = readLastJsonLine(stdout);
        if (!result?.ok) {
          return sendApiError(res, new Error(result?.error || '原生坐标变换失败'), {
            fallbackCode: 'EXPORT_FAILED',
            fallbackStatus: 500,
          });
        }
        return res.json(result);
      } catch (error) {
        return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
      }
    } catch (error) {
      return sendApiError(res, error, { fallbackCode: 'BAD_REQUEST', fallbackStatus: 400 });
    }
  })();
});

// ═══════════════════════════════════════════════════════════
// P1/P2/P3: DTM / DSM / Contour API
// ═══════════════════════════════════════════════════════════

const DTM_DIR = path.join(__dirname, 'dtm_jobs');
const FLOORPLAN_DIR = path.join(__dirname, 'floorplan_jobs');
const SURFACE_DIR = path.join(__dirname, 'surface_jobs');
const VOLUME_SURFACE_DIR = path.join(__dirname, 'volume_surface_jobs');
const VOLUME_JOB_DIR = path.join(__dirname, 'volume_jobs');
const CONTOUR_DIR = path.join(__dirname, 'contour_jobs');
const DTM_SCRIPT = path.join(__dirname, 'scripts', 'generate_dtm.py');
const SURFACE_SCRIPT = path.join(__dirname, 'scripts', 'generate_surface_mesh.py');
const VOLUME_SURFACE_SCRIPT = path.join(__dirname, 'scripts', 'generate_volume_surface.py');
const VOLUME_ANALYSIS_SCRIPT = path.join(__dirname, 'scripts', 'compute_volume_analysis.py');
const CONTOUR_SCRIPT = path.join(__dirname, 'scripts', 'generate_contours.py');
function readPositiveNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const VOLUME_SURFACE_LIMITS = {
  minResolution: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MIN_RESOLUTION', 0.25),
  maxPolygonArea: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_AREA_M2', 10000),
  maxCells: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_CELLS', 12000),
  maxPolygonVertices: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_VERTICES', 80),
  maxSourceBytes: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_SOURCE_MB', 1536) * 1024 * 1024,
  maxConcurrentJobs: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_CONCURRENT', 1),
  maxQueuedJobs: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_MAX_QUEUE', 4),
  queueWaitMs: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_QUEUE_WAIT_MS', 10 * 60 * 1000),
  timeoutMs: readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_TIMEOUT_MS', 4 * 60 * 1000),
};
const VOLUME_JOB_RETENTION_MS = readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_JOB_RETENTION_DAYS', 3) * 24 * 60 * 60 * 1000;
const VOLUME_JOB_CLEANUP_INTERVAL_MS = readPositiveNumberEnv('CLOUDSTUDIO_VOLUME_JOB_CLEANUP_INTERVAL_HOURS', 6) * 60 * 60 * 1000;
let activeVolumeComputeJobs = 0;
const volumeComputeQueue = [];
// Use the project venv for terrain / volume scripts because these depend on
// numpy / matplotlib / laspy. Keep SYSTEM_PYTHON_BIN for lightweight system tasks.
fs.mkdirSync(DTM_DIR, { recursive: true });
fs.mkdirSync(FLOORPLAN_DIR, { recursive: true });
fs.mkdirSync(SURFACE_DIR, { recursive: true });
fs.mkdirSync(VOLUME_SURFACE_DIR, { recursive: true });
fs.mkdirSync(VOLUME_JOB_DIR, { recursive: true });
fs.mkdirSync(CONTOUR_DIR, { recursive: true });

function runPython(pythonBin, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { cwd: __dirname, env: buildPythonEnv() });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('Python process timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;

      // Extract RESULT: JSON line from stdout
      const lines = stdout.split('\n');
      const resultLine = lines.reverse().find(l => l.startsWith('RESULT:'));
      if (resultLine) {
        try {
          const parsed = JSON.parse(resultLine.slice('RESULT:'.length));
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed);
          }
          return;
        } catch (e) { }
      }

      if (code !== 0) {
        const errSummary = (stderr || stdout).slice(-2000);
        reject(new Error('Python exited with code ' + code + ': ' + errSummary));
      } else {
        resolve({ ok: true, stdout });
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error('Failed to start Python: ' + err.message));
    });
  });
}

function runPythonStreaming(pythonBin, args, {
  timeoutMs = 120000,
  onStdoutLine = null,
  onStderrLine = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { cwd: __dirname, env: buildPythonEnv() });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let killed = false;

    const flushLines = (buffer, chunk, handler) => {
      const combined = buffer + chunk;
      const lines = combined.split(/\r?\n/);
      const remainder = lines.pop() || '';
      if (handler) {
        for (const line of lines) {
          const trimmed = String(line || '').trim();
          if (trimmed) handler(trimmed);
        }
      }
      return remainder;
    };

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('Python process timed out after ' + (timeoutMs / 1000) + 's'));
    }, timeoutMs);

    proc.stdout.on('data', d => {
      const chunk = d.toString();
      stdout += chunk;
      stdoutBuffer = flushLines(stdoutBuffer, chunk, onStdoutLine);
    });
    proc.stderr.on('data', d => {
      const chunk = d.toString();
      stderr += chunk;
      stderrBuffer = flushLines(stderrBuffer, chunk, onStderrLine);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (stdoutBuffer.trim() && onStdoutLine) onStdoutLine(stdoutBuffer.trim());
      if (stderrBuffer.trim() && onStderrLine) onStderrLine(stderrBuffer.trim());

      const lines = stdout.split('\n');
      const resultLine = lines.reverse().find(l => l.startsWith('RESULT:'));
      if (resultLine) {
        try {
          const parsed = JSON.parse(resultLine.slice('RESULT:'.length));
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed);
          }
          return;
        } catch (e) { }
      }

      if (code !== 0) {
        const errSummary = (stderr || stdout).slice(-2000);
        reject(new Error('Python exited with code ' + code + ': ' + errSummary));
      } else {
        resolve({ ok: true, stdout });
      }
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error('Failed to start Python: ' + err.message));
    });
  });
}

function computePolygonBoundsFromPairs(polygonPairs = []) {
  const xs = polygonPairs.map(pair => Number(pair?.[0]));
  const ys = polygonPairs.map(pair => Number(pair?.[1]));
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function computePolygonAreaFromPairs(polygonPairs = []) {
  if (!Array.isArray(polygonPairs) || polygonPairs.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < polygonPairs.length; index += 1) {
    const [x1, y1] = polygonPairs[index] || [];
    const [x2, y2] = polygonPairs[(index + 1) % polygonPairs.length] || [];
    area += Number(x1) * Number(y2) - Number(x2) * Number(y1);
  }
  return Math.abs(area) * 0.5;
}

function normalizeVolumePolygon(rawPolygon) {
  if (!Array.isArray(rawPolygon) || rawPolygon.length < 3) {
    const error = new Error('Volume region polygon must contain at least 3 points.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (rawPolygon.length > VOLUME_SURFACE_LIMITS.maxPolygonVertices) {
    const error = new Error(`Polygon is too detailed for mesh generation (${rawPolygon.length} vertices > ${VOLUME_SURFACE_LIMITS.maxPolygonVertices}). Simplify the selection and try again.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const polygon = rawPolygon.map((pair, index) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      const error = new Error(`Invalid polygon point at index ${index}.`);
      error.code = 'BAD_REQUEST';
      throw error;
    }
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const error = new Error(`Invalid polygon coordinate at index ${index}.`);
      error.code = 'BAD_REQUEST';
      throw error;
    }
    return [x, y];
  });
  const area = computePolygonAreaFromPairs(polygon);
  if (!Number.isFinite(area) || area <= 0) {
    const error = new Error('Volume region polygon has zero area.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return { polygon, area, bounds: computePolygonBoundsFromPairs(polygon) };
}

function validateVolumeSurfaceRequest({ polygon, resolution }) {
  const { area, bounds } = normalizeVolumePolygon(polygon);
  const normalizedResolution = Number(resolution);
  if (!Number.isFinite(normalizedResolution) || normalizedResolution < VOLUME_SURFACE_LIMITS.minResolution) {
    const error = new Error(`Resolution must be at least ${VOLUME_SURFACE_LIMITS.minResolution.toFixed(2)} m for mesh generation.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (area > VOLUME_SURFACE_LIMITS.maxPolygonArea) {
    const error = new Error(`Selected region is too large for mesh generation (${area.toFixed(1)} m² > ${VOLUME_SURFACE_LIMITS.maxPolygonArea.toLocaleString()} m²). Split the region first.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const width = Math.max(bounds.maxX - bounds.minX, normalizedResolution);
  const height = Math.max(bounds.maxY - bounds.minY, normalizedResolution);
  const estimatedRows = Math.max(2, Math.ceil(height / normalizedResolution));
  const estimatedCols = Math.max(2, Math.ceil(width / normalizedResolution));
  const estimatedCells = estimatedRows * estimatedCols;
  if (estimatedCells > VOLUME_SURFACE_LIMITS.maxCells) {
    const error = new Error(`Mesh request exceeds the hard cell limit (${estimatedCells.toLocaleString()} cells > ${VOLUME_SURFACE_LIMITS.maxCells.toLocaleString()}). Increase cell size or split the region.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return {
    polygonArea: area,
    estimatedRows,
    estimatedCols,
    estimatedCells,
    resolution: normalizedResolution,
  };
}

function assertVolumeSourceWithinLimits(lasPath) {
  const stat = fs.statSync(lasPath);
  if (stat.size > VOLUME_SURFACE_LIMITS.maxSourceBytes) {
    const limitMb = VOLUME_SURFACE_LIMITS.maxSourceBytes / 1024 / 1024;
    const actualMb = stat.size / 1024 / 1024;
    const error = new Error(`Source point cloud is too large for public volume calculation (${actualMb.toFixed(0)} MB > ${limitMb.toFixed(0)} MB). Split the cloud or run this job offline.`);
    error.code = 'VOLUME_SOURCE_TOO_LARGE';
    throw error;
  }
}

function drainVolumeComputeQueue() {
  while (activeVolumeComputeJobs < VOLUME_SURFACE_LIMITS.maxConcurrentJobs && volumeComputeQueue.length > 0) {
    const entry = volumeComputeQueue.shift();
    clearTimeout(entry.timer);
    activeVolumeComputeJobs += 1;
    entry.resolve({
      queued: true,
      waitedMs: Date.now() - entry.enqueuedAt,
    });
  }
}

function acquireVolumeComputeSlot() {
  if (activeVolumeComputeJobs >= VOLUME_SURFACE_LIMITS.maxConcurrentJobs) {
    if (volumeComputeQueue.length >= VOLUME_SURFACE_LIMITS.maxQueuedJobs) {
      const error = new Error('Volume calculation queue is full. Please wait for an active job to finish before starting a new one.');
      error.code = 'VOLUME_JOB_BUSY';
      throw error;
    }
    return new Promise((resolve, reject) => {
      const entry = {
        enqueuedAt: Date.now(),
        resolve,
        reject,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        const index = volumeComputeQueue.indexOf(entry);
        if (index >= 0) volumeComputeQueue.splice(index, 1);
        const error = new Error('Volume calculation waited too long in the queue. Please try again later or split the region.');
        error.code = 'VOLUME_JOB_BUSY';
        reject(error);
      }, VOLUME_SURFACE_LIMITS.queueWaitMs);
      volumeComputeQueue.push(entry);
      console.log(`[Volume] Queued compute job (${volumeComputeQueue.length}/${VOLUME_SURFACE_LIMITS.maxQueuedJobs})`);
    });
  }
  activeVolumeComputeJobs += 1;
  return Promise.resolve({ queued: false, waitedMs: 0 });
}

function releaseVolumeComputeSlot() {
  activeVolumeComputeJobs = Math.max(0, activeVolumeComputeJobs - 1);
  drainVolumeComputeQueue();
}

function parseOptionalFiniteNumber(value, {
  fieldName = 'value',
  errorMessage = null,
} = {}) {
  if (value === null || value === '' || typeof value === 'undefined') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const error = new Error(errorMessage || `Invalid ${fieldName}.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return numeric;
}

function normalizeVolumeJobPolygon(rawPolygon) {
  if (!Array.isArray(rawPolygon) || rawPolygon.length < 3) {
    const error = new Error('Volume region polygon must contain at least 3 points.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (rawPolygon.length > VOLUME_SURFACE_LIMITS.maxPolygonVertices) {
    const error = new Error(`Polygon is too detailed for mesh generation (${rawPolygon.length} vertices > ${VOLUME_SURFACE_LIMITS.maxPolygonVertices}). Simplify the selection and try again.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }

  const polygon = rawPolygon.map((point, index) => {
    const isArrayPoint = Array.isArray(point);
    const xRaw = isArrayPoint ? point[0] : point?.x;
    const yRaw = isArrayPoint ? point[1] : point?.y;
    const zRaw = isArrayPoint ? point[2] : point?.z;
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const error = new Error(`Invalid polygon coordinate at index ${index}.`);
      error.code = 'BAD_REQUEST';
      throw error;
    }
    const z = zRaw === null || zRaw === '' || typeof zRaw === 'undefined'
      ? null
      : Number(zRaw);
    if (z !== null && !Number.isFinite(z)) {
      const error = new Error(`Invalid polygon Z value at index ${index}.`);
      error.code = 'BAD_REQUEST';
      throw error;
    }
    return { x, y, z };
  });

  const polygonPairs = polygon.map(point => [point.x, point.y]);
  const area = computePolygonAreaFromPairs(polygonPairs);
  if (!Number.isFinite(area) || area <= 0) {
    const error = new Error('Volume region polygon has zero area.');
    error.code = 'BAD_REQUEST';
    throw error;
  }

  return {
    polygon,
    polygonPairs,
    area,
    bounds: computePolygonBoundsFromPairs(polygonPairs),
  };
}

function validateVolumeJobRequest({ polygon, resolution }) {
  const normalized = normalizeVolumeJobPolygon(polygon);
  const normalizedResolution = Number(resolution);
  if (!Number.isFinite(normalizedResolution) || normalizedResolution < VOLUME_SURFACE_LIMITS.minResolution) {
    const error = new Error(`Resolution must be at least ${VOLUME_SURFACE_LIMITS.minResolution.toFixed(2)} m for mesh generation.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  if (normalized.area > VOLUME_SURFACE_LIMITS.maxPolygonArea) {
    const error = new Error(`Selected region is too large for mesh generation (${normalized.area.toFixed(1)} m² > ${VOLUME_SURFACE_LIMITS.maxPolygonArea.toLocaleString()} m²). Split the region first.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const width = Math.max(normalized.bounds.maxX - normalized.bounds.minX, normalizedResolution);
  const height = Math.max(normalized.bounds.maxY - normalized.bounds.minY, normalizedResolution);
  const estimatedRows = Math.max(2, Math.ceil(height / normalizedResolution));
  const estimatedCols = Math.max(2, Math.ceil(width / normalizedResolution));
  const estimatedCells = estimatedRows * estimatedCols;
  if (estimatedCells > VOLUME_SURFACE_LIMITS.maxCells) {
    const error = new Error(`Mesh request exceeds the hard cell limit (${estimatedCells.toLocaleString()} cells > ${VOLUME_SURFACE_LIMITS.maxCells.toLocaleString()}). Increase cell size or split the region.`);
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return {
    ...normalized,
    polygonArea: normalized.area,
    estimatedRows,
    estimatedCols,
    estimatedCells,
    resolution: normalizedResolution,
  };
}

function normalizeVolumeBaseMode(mode, scenarioMode = '') {
  const fallbackMode = String(scenarioMode || '').toLowerCase().includes('ground')
    ? 'ground'
    : (String(scenarioMode || '').toLowerCase().includes('fixed') ? 'fixed' : 'boundary');
  const raw = String(mode || fallbackMode).trim().toLowerCase();
  const aliases = {
    constant: 'fixed',
    plane: 'fixed',
    boundary_fit: 'boundary',
    ground_fit: 'ground',
    dtm: 'ground',
    ground_only: 'ground',
  };
  const normalized = aliases[raw] || raw;
  if (!['boundary', 'fixed', 'ground'].includes(normalized)) {
    const error = new Error('Unsupported base surface mode for volume job generation.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return normalized;
}

function requireVolumeJobSurface(surface) {
  const normalized = String(surface || '').trim().toLowerCase();
  if (!['analysis', 'base'].includes(normalized)) {
    const error = new Error('surface must be analysis or base');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  return normalized;
}

function writePngDataUrlToFile(dataUrl, filePath) {
  const normalized = String(dataUrl || '').trim();
  const match = normalized.match(/^data:image\/png;base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) {
    const error = new Error('imageDataUrl must be a PNG data URL.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) {
    const error = new Error('imageDataUrl did not contain any image data.');
    error.code = 'BAD_REQUEST';
    throw error;
  }
  fs.writeFileSync(filePath, buffer);
}

function getVolumeJobArtifactPath(jobId, artifact) {
  const jobDir = path.join(VOLUME_JOB_DIR, jobId);
  const lookup = {
    result: {
      filePath: path.join(jobDir, 'result.json'),
      filename: `${jobId}_result.json`,
      mimeType: 'application/json',
    },
    request: {
      filePath: path.join(jobDir, 'request_payload.json'),
      filename: `${jobId}_request_payload.json`,
      mimeType: 'application/json',
    },
    'analysis-mesh': {
      filePath: path.join(jobDir, 'analysis_surface_mesh.json'),
      filename: `${jobId}_analysis_surface_mesh.json`,
      mimeType: 'application/json',
    },
    'analysis-grid': {
      filePath: path.join(jobDir, 'analysis_surface_grid.json'),
      filename: `${jobId}_analysis_surface_grid.json`,
      mimeType: 'application/json',
    },
    'analysis-obj': {
      filePath: path.join(jobDir, 'analysis_surface.obj'),
      filename: `${jobId}_analysis_surface.obj`,
      mimeType: 'text/plain; charset=utf-8',
    },
    'analysis-preview': {
      filePath: path.join(jobDir, 'preview_analysis.png'),
      filename: `${jobId}_preview_analysis.png`,
      mimeType: 'image/png',
    },
    'base-mesh': {
      filePath: path.join(jobDir, 'base_surface_mesh.json'),
      filename: `${jobId}_base_surface_mesh.json`,
      mimeType: 'application/json',
    },
    'base-grid': {
      filePath: path.join(jobDir, 'base_surface_grid.json'),
      filename: `${jobId}_base_surface_grid.json`,
      mimeType: 'application/json',
    },
    'base-obj': {
      filePath: path.join(jobDir, 'base_surface.obj'),
      filename: `${jobId}_base_surface.obj`,
      mimeType: 'text/plain; charset=utf-8',
    },
    'base-preview': {
      filePath: path.join(jobDir, 'preview_base.png'),
      filename: `${jobId}_preview_base.png`,
      mimeType: 'image/png',
    },
    'report-pdf': {
      filePath: path.join(jobDir, 'volume_report.pdf'),
      filename: `${jobId}_volume_report.pdf`,
      mimeType: 'application/pdf',
    },
  };
  return lookup[artifact] || null;
}

// Recursively find LAS/LAZ files in a directory (depth-limited)
function findLasFilesInDir(dirPath, maxDepth = 3) {
  const results = [];
  if (!fs.existsSync(dirPath)) return results;
  const preferred = ['colorized.las', 'colorized.laz', 'uncolorized.las', 'uncolorized.laz',
    'scan_resumer.las', 'scan_resumer.laz', 'pointcloud.las', 'pointcloud.laz'];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && /\.(las|laz)$/i.test(e.name)) {
        results.push(full);
      } else if (e.isDirectory() && depth < maxDepth) {
        // Only recurse into likely subdirs
        if (['converted', 'data', 'scan_data', 'output', 'las', 'laz', 'pointcloud'].includes(e.name.toLowerCase())) {
          walk(full, depth + 1);
        }
      }
    }
  }
  walk(dirPath, 0);
  // Sort: preferred names first, then by mtime descending (newest upload first)
  results.sort((a, b) => {
    const an = path.basename(a).toLowerCase(), bn = path.basename(b).toLowerCase();
    const ai = preferred.indexOf(an), bi = preferred.indexOf(bn);
    const ar = ai === -1 ? preferred.length : ai;
    const br = bi === -1 ? preferred.length : bi;
    if (ar !== br) return ar - br;
    // Secondary: newest file first
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch { return 0; }
  });
  return results;
}

function resolveBestLasPathForContext({ projectId = null, cloudName = null } = {}) {
  if (projectId) {
    const project = getScannerProjectById(String(projectId));
    if (project?.dirPath) {
      const files = findLasFilesInDir(project.dirPath);
      if (files.length > 0) {
        return {
          lasPath: files[0],
          name: path.basename(files[0]),
          projectName: project.name,
          scannerProjectId: project.projectId,
          allPaths: files.slice(0, 8),
        };
      }
    }
  }

  if (cloudName) {
    const exactProject = getScannerProjectById(String(cloudName));
    if (exactProject?.dirPath) {
      const exactProjectFiles = findLasFilesInDir(exactProject.dirPath);
      if (exactProjectFiles.length > 0) {
        return {
          lasPath: exactProjectFiles[0],
          name: path.basename(exactProjectFiles[0]),
          projectName: exactProject.name,
          scannerProjectId: exactProject.projectId,
          allPaths: exactProjectFiles.slice(0, 8),
        };
      }
    }

    const manifest = readUploadSourceManifest(String(cloudName));
    if (manifest?.originalPath && fs.existsSync(manifest.originalPath)) {
      const allPaths = [manifest.originalPath];
      if (manifest.scannerProjectId) {
        const proj = getScannerProjectById(manifest.scannerProjectId);
        if (proj) {
          const extras = findLasFilesInDir(proj.dirPath).filter(p => p !== manifest.originalPath);
          allPaths.push(...extras.slice(0, 7));
        }
      }
      return {
        lasPath: manifest.originalPath,
        name: path.basename(manifest.originalPath),
        projectName: manifest.scannerProjectName,
        scannerProjectId: manifest.scannerProjectId,
        allPaths,
      };
    }

    const sources = getCloudSourceFiles(String(cloudName));
    if (sources.length > 0) {
      const best = sources[0];
      const lasPath = path.join(UPLOADS_DIR, best.relPath);
      if (fs.existsSync(lasPath)) {
        return {
          lasPath,
          name: best.originalName || best.name,
          allPaths: [lasPath],
        };
      }
    }

    const originalName = manifest?.originalName || (String(cloudName).replace(/[^a-zA-Z0-9._-]/g, '') + '.las');
    discoverScanProjects();
    for (const [, proj] of scanProjectRegistry) {
      const candidate = path.join(proj.dirPath, originalName);
      if (fs.existsSync(candidate)) {
        return {
          lasPath: candidate,
          name: originalName,
          projectName: proj.name,
          scannerProjectId: proj.projectId,
          allPaths: findLasFilesInDir(proj.dirPath).slice(0, 8),
        };
      }
      const files = findLasFilesInDir(proj.dirPath);
      const match = files.find(f => path.basename(f).toLowerCase() === originalName.toLowerCase());
      if (match) {
        return {
          lasPath: match,
          name: path.basename(match),
          projectName: proj.name,
          scannerProjectId: proj.projectId,
          allPaths: files.slice(0, 8),
        };
      }
    }
  }

  discoverScanProjects();
  for (const [, proj] of scanProjectRegistry) {
    const files = findLasFilesInDir(proj.dirPath);
    if (files.length > 0) {
      return {
        lasPath: files[0],
        name: path.basename(files[0]),
        projectName: proj.name,
        scannerProjectId: proj.projectId,
        allPaths: files.slice(0, 8),
      };
    }
  }

  const uploadLas = findLasFilesInDir(UPLOADS_DIR, 1);
  if (uploadLas.length > 0) {
    return {
      lasPath: uploadLas[0],
      name: path.basename(uploadLas[0]),
      allPaths: uploadLas.slice(0, 8),
    };
  }

  return null;
}

// GET /api/find-las?projectId=xxx  (or ?cloudName=xxx, or no params = scan all known locations)
// Returns the best LAS file path for DTM generation
app.get('/api/find-las', (req, res) => {
  try {
    const { projectId, cloudName } = req.query;

    // Strategy 1: Known scanner project
    if (projectId) {
      const project = getScannerProjectById(String(projectId));
      if (project?.dirPath) {
        const files = findLasFilesInDir(project.dirPath);
        if (files.length > 0) {
          return res.json({
            ok: true, lasPath: files[0], name: path.basename(files[0]),
            allPaths: files.slice(0, 8)
          });
        }
      }
    }

    // Strategy 2: Uploaded cloud's original LAS
    if (cloudName) {
      const manifest = readUploadSourceManifest(String(cloudName));

      // 2a: If source.json has the original scanner project path stored, use it directly
      if (manifest?.originalPath && fs.existsSync(manifest.originalPath)) {
        const allPaths = [manifest.originalPath];
        // Also include other LAS files from the same project dir for the dropdown
        if (manifest.scannerProjectId) {
          const proj = getScannerProjectById(manifest.scannerProjectId);
          if (proj) {
            const extras = findLasFilesInDir(proj.dirPath).filter(p => p !== manifest.originalPath);
            allPaths.push(...extras.slice(0, 7));
          }
        }
        return res.json({
          ok: true, lasPath: manifest.originalPath,
          name: path.basename(manifest.originalPath),
          projectName: manifest.scannerProjectName,
          scannerProjectId: manifest.scannerProjectId,
          allPaths
        });
      }

      // 2b: Check for upload file copy in uploads dir
      const sources = getCloudSourceFiles(String(cloudName));
      if (sources.length > 0) {
        const best = sources[0];
        const lasPath = path.join(UPLOADS_DIR, best.relPath);
        if (fs.existsSync(lasPath)) {
          return res.json({
            ok: true, lasPath, name: best.originalName || best.name,
            allPaths: [lasPath]
          });
        }
      }

      // 2c: Search all scanner projects for a file matching the original name
      const originalName = manifest?.originalName || (cloudName.replace(/[^a-zA-Z0-9._-]/g, '') + '.las');
      discoverScanProjects();
      for (const [, proj] of scanProjectRegistry) {
        // Direct filename match
        const candidate = path.join(proj.dirPath, originalName);
        if (fs.existsSync(candidate)) {
          const allPaths = findLasFilesInDir(proj.dirPath).slice(0, 8);
          return sendApiSuccess(res, {
            lasPath: candidate, name: originalName,
            projectName: proj.name, scannerProjectId: proj.projectId, allPaths
          });
        }
        // Also search recursively for any LAS with matching name
        const files = findLasFilesInDir(proj.dirPath);
        const match = files.find(f => path.basename(f).toLowerCase() === originalName.toLowerCase());
        if (match) {
          return sendApiSuccess(res, {
            lasPath: match, name: path.basename(match),
            projectName: proj.name, scannerProjectId: proj.projectId,
            allPaths: files.slice(0, 8)
          });
        }
      }
    }

    // Strategy 3: Scan all registered projects
    const allProjects = discoverScanProjects();
    for (const [, proj] of scanProjectRegistry) {
      const files = findLasFilesInDir(proj.dirPath);
      if (files.length > 0) {
        return sendApiSuccess(res, {
          lasPath: files[0], name: path.basename(files[0]),
          projectName: proj.name, allPaths: files.slice(0, 8)
        });
      }
    }

    // Strategy 4: Check uploads directory
    const uploadLas = findLasFilesInDir(UPLOADS_DIR, 1);
    if (uploadLas.length > 0) {
      return sendApiSuccess(res, {
        lasPath: uploadLas[0], name: path.basename(uploadLas[0]),
        allPaths: uploadLas.slice(0, 8)
      });
    }

    return res.json({
      ok: false, lasPath: null,
      message: '未找到 LAS/LAZ 文件。请在下方手动输入文件路径。',
      allPaths: []
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

// GET /api/cloud-source?cloudName=xxx — return source.json for a converted cloud
// Useful for the viewer to detect if an uploaded cloud was linked to a scanner project
app.get('/api/cloud-source', (req, res) => {
  try {
    const cloudName = requireSafeCloudName(req.query.cloudName);
    const manifest = readUploadSourceManifest(cloudName);
    if (!manifest) return res.json({ ok: false, manifest: null });

    // If we have a scannerProjectId, verify the project still exists
    if (manifest.scannerProjectId) {
      const proj = getScannerProjectById(manifest.scannerProjectId);
      if (proj) {
        manifest.scannerProjectName = proj.name;
        manifest.scanDataUrl = `/scan-data/${proj.projectId}`;
        manifest.pointcloudUrl = proj.features.hasPotree
          ? `/scan-data/${proj.projectId}/converted/metadata.json`
          : null;
      }
    }

    return sendApiSuccess(res, { manifest });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.get('/api/mesh-file', (req, res) => {
  try {
    const mesh = parseObjMeshFile(req.query.path);
    return sendApiSuccess(res, mesh);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'FILE_NOT_FOUND',
      fallbackStatus: error.code === 'BAD_REQUEST' ? 400 : 404,
    });
  }
});

// GET /api/project-dir?projectId=xxx — return filesystem path for a scanner project
app.get('/api/project-dir', (req, res) => {
  try {
    const projectId = requireNonEmptyString(req.query.projectId, 'projectId', { code: 'BAD_REQUEST' });
    const project = getScannerProjectById(projectId);
    if (!project) return res.json({ ok: false, dirPath: null });
    return sendApiSuccess(res, { dirPath: project.dirPath, name: project.name });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.post('/api/floorplan/extract', async (req, res) => {
  if (!fs.existsSync(PYTHON_BIN)) {
    return sendApiError(res, new Error(`导出环境未安装: ${PYTHON_BIN}`), { fallbackCode: 'EXPORT_ENV_MISSING' });
  }
  if (!fs.existsSync(FLOORPLAN_EXTRACT_SCRIPT)) {
    return sendApiError(res, new Error(`平面图提取脚本不存在: ${FLOORPLAN_EXTRACT_SCRIPT}`), { fallbackCode: 'EXPORT_SCRIPT_MISSING' });
  }

  try {
    const projectId = req.body?.projectId ? String(req.body.projectId) : null;
    const cloudName = req.body?.cloudName ? requireSafeCloudName(req.body.cloudName) : null;
    const source = resolveBestLasPathForContext({ projectId, cloudName });
    if (!source?.lasPath || !fs.existsSync(source.lasPath)) {
      const error = new Error('未找到可用于提取的原始 LAS/LAZ 数据源');
      error.code = 'FILE_NOT_FOUND';
      throw error;
    }

    const jobId = createTimestampJobId('floorplan');
    const jobDir = path.join(FLOORPLAN_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const payload = {
      lasPath: source.lasPath,
      jobId,
      jobDir,
      projectId: source.scannerProjectId || projectId,
      cloudName,
      zCenter: Number(req.body?.zCenter ?? 1.2),
      thickness: Number(req.body?.thickness ?? 0.12),
      minWallLength: Number(req.body?.minWallLength ?? 1.2),
      mergeTolerance: Number(req.body?.mergeTolerance ?? 0.18),
      autoAlign: req.body?.autoAlign !== false,
      orthogonalOnly: req.body?.orthogonalOnly !== false,
      gridSize: Number(req.body?.gridSize ?? 0.05),
      debugPreview: req.body?.debugPreview !== false,
    };

    const { code, stdout, stderr } = await runPythonConfigJob(FLOORPLAN_EXTRACT_SCRIPT, payload, {
      configDir: FLOORPLAN_DIR,
      configPrefix: 'floorplan_extract',
    });

    const result = readLastJsonLine(stdout) || {};
    if (code !== 0 || result.ok === false) {
      const detailedError = result.error || summarizeExportProcessError(stdout, stderr) || '平面图提取失败';
      return res.status(500).json({
        ok: false,
        error: detailedError,
        errorCode: 'FLOORPLAN_EXTRACTION_FAILED',
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
    }

    return sendApiSuccess(res, {
      jobId,
      sourcePath: source.lasPath,
      sourceName: source.name,
      projectName: source.projectName || null,
      scannerProjectId: source.scannerProjectId || null,
      sliceBounds: result.sliceBounds || null,
      rasterMeta: result.rasterMeta || null,
      segments: result.segments || [],
      corners: result.corners || [],
      debugImages: result.debugImages || [],
      stats: result.stats || {},
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'BAD_REQUEST', fallbackStatus: error.code === 'FILE_NOT_FOUND' ? 404 : 400 });
  }
});

// POST /api/generate-dtm
app.post('/api/generate-dtm', async (_req, res) => {
  const error = new Error('DTM generation is disabled on the production server to protect stability.');
  error.code = 'DTM_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'DTM_DISABLED',
    fallbackStatus: 503,
  });
});

// GET /api/download-dtm?jobId=xxx
app.get('/api/download-dtm', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'dtm', { code: 'DTM_BAD_JOB_ID' });
    const jobDir = path.join(DTM_DIR, jobId);
  const tifPath = path.join(jobDir, 'dtm.tif');
  const npyPath = path.join(jobDir, 'dtm.npy');

  if (fs.existsSync(tifPath)) {
    res.setHeader('Content-Disposition', `attachment; filename="${jobId}.tif"`);
    res.setHeader('Content-Type', 'image/tiff');
    return res.sendFile(tifPath);
  } else if (fs.existsSync(npyPath)) {
    res.setHeader('Content-Disposition', `attachment; filename="${jobId}.npy"`);
    return res.sendFile(npyPath);
    }
    const error = new Error('DTM file not found');
    error.code = 'DTM_FILE_NOT_FOUND';
    throw error;
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'DTM_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

// Serve DTM job files (preview images)
app.use('/dtm-jobs', createGuardedStaticDirectory(DTM_DIR));
app.use('/floorplan-jobs', createGuardedStaticDirectory(FLOORPLAN_DIR));

// POST /api/generate-surface
app.post('/api/generate-surface', async (_req, res) => {
  const error = new Error('Surface mesh generation is disabled on the production server to protect stability.');
  error.code = 'SURFACE_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'SURFACE_DISABLED',
    fallbackStatus: 503,
  });
});

app.get('/api/download-surface', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'surf', { code: 'SURFACE_BAD_JOB_ID' });
    const fmt = String(req.query.fmt || 'obj').toLowerCase();
    const jobDir = path.join(SURFACE_DIR, jobId);

    let filePath;
    let filename;
    let mimeType;
    if (fmt === 'obj') {
      filePath = path.join(jobDir, 'surface.obj');
      filename = `${jobId}_surface.obj`;
      mimeType = 'text/plain; charset=utf-8';
    } else if (fmt === 'json') {
      filePath = path.join(jobDir, 'surface_mesh.json');
      filename = `${jobId}_surface_mesh.json`;
      mimeType = 'application/json';
    } else if (fmt === 'grid') {
      filePath = path.join(jobDir, 'surface_grid.json');
      filename = `${jobId}_surface_grid.json`;
      mimeType = 'application/json';
    } else {
      const error = new Error('Invalid surface download format');
      error.code = 'INVALID_FORMAT';
      throw error;
    }

    if (!fs.existsSync(filePath)) {
      const error = new Error('Surface file not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.get('/api/surface-mesh', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'surf', { code: 'SURFACE_BAD_JOB_ID' });
    const filePath = path.join(SURFACE_DIR, jobId, 'surface_mesh.json');
    if (!fs.existsSync(filePath)) {
      const error = new Error('Surface mesh not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.get('/api/surface-grid', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'surf', { code: 'SURFACE_BAD_JOB_ID' });
    const filePath = path.join(SURFACE_DIR, jobId, 'surface_grid.json');
    if (!fs.existsSync(filePath)) {
      const error = new Error('Surface grid not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.use('/surface-jobs', createGuardedStaticDirectory(SURFACE_DIR));

app.post('/api/generate-volume-surface', async (req, res) => {
  let payloadPath = null;
  let volumeSlotAcquired = false;
  try {
    const lasPath = ensureExistingAbsoluteFile(req.body?.lasPath, {
      fieldName: 'lasPath',
      missingCode: 'FILE_NOT_FOUND',
      enforceStorageBounds: true,
    });
    assertVolumeSourceWithinLimits(lasPath);
    const validation = validateVolumeSurfaceRequest({
      polygon: req.body?.polygon,
      resolution: req.body?.resolution,
    });
    const holeMode = String(req.body?.holeMode || 'interpolate').toLowerCase();
    if (!['leave', 'interpolate', 'fixed'].includes(holeMode)) {
      const error = new Error('Unsupported hole fill mode for volume mesh generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const surfaceType = String(req.body?.surfaceType || 'stockpile').toLowerCase();
    if (!['stockpile', 'dsm', 'dtm'].includes(surfaceType)) {
      const error = new Error('Unsupported surface type for volume mesh generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const aggregateMode = String(req.body?.aggregateMode || 'p80').toLowerCase();
    const fixedHeightRaw = req.body?.fixedHeight;
    const fixedHeight = fixedHeightRaw === null || fixedHeightRaw === '' || typeof fixedHeightRaw === 'undefined'
      ? null
      : Number(fixedHeightRaw);
    if (fixedHeight !== null && !Number.isFinite(fixedHeight)) {
      const error = new Error('Invalid fixed height for volume mesh generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const referenceHeightRaw = req.body?.referenceHeight;
    const referenceHeight = referenceHeightRaw === null || referenceHeightRaw === '' || typeof referenceHeightRaw === 'undefined'
      ? null
      : Number(referenceHeightRaw);
    if (referenceHeight !== null && !Number.isFinite(referenceHeight)) {
      const error = new Error('Invalid reference height for volume mesh generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const spikeThresholdRaw = req.body?.spikeThreshold;
    const spikeThreshold = spikeThresholdRaw === null || spikeThresholdRaw === '' || typeof spikeThresholdRaw === 'undefined'
      ? null
      : Number(spikeThresholdRaw);
    if (spikeThreshold !== null && !Number.isFinite(spikeThreshold)) {
      const error = new Error('Invalid spike threshold for volume mesh generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const volumeQueueState = await acquireVolumeComputeSlot();
    volumeSlotAcquired = true;

    const jobId = createTimestampJobId('vsurf');
    const outputDir = path.join(VOLUME_SURFACE_DIR, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    payloadPath = path.join(outputDir, 'request_payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({
      lasPath,
      outputDir,
      polygon: req.body.polygon.map(([x, y]) => ({ x: Number(x), y: Number(y) })),
      resolution: validation.resolution,
      holeMode,
      fixedHeight,
      referenceHeight,
      surfaceType,
      aggregateMode,
      spikeThreshold,
    }, null, 2), 'utf8');

    const result = await runPython(EFFECTIVE_TERRAIN_PYTHON_BIN, [VOLUME_SURFACE_SCRIPT, payloadPath], VOLUME_SURFACE_LIMITS.timeoutMs);

    const metaPath = path.join(outputDir, 'meta.json');
    const previewPath = path.join(outputDir, 'preview.png');
    const surfaceGridPath = path.join(outputDir, 'surface_grid.json');
    const surfaceMeshPath = path.join(outputDir, 'surface_mesh.json');
    if (!fs.existsSync(metaPath) || !fs.existsSync(previewPath) || !fs.existsSync(surfaceGridPath) || !fs.existsSync(surfaceMeshPath)) {
      const error = new Error('Volume mesh generation did not produce the expected output files.');
      error.code = 'INTERNAL_ERROR';
      throw error;
    }

    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      meta = {};
    }

    return sendApiSuccess(res, {
      jobId,
      previewUrl: `/volume-surface-jobs/${encodeURIComponent(jobId)}/preview.png`,
      stats: result?.stats || {},
      limits: {
        estimatedCells: validation.estimatedCells,
        estimatedRows: validation.estimatedRows,
        estimatedCols: validation.estimatedCols,
        polygonArea: validation.polygonArea,
      },
      meta,
      queue: volumeQueueState,
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'VOLUME_SURFACE_DISABLED',
      fallbackStatus: error?.code === 'BAD_REQUEST' ? 400 : 500,
    });
  } finally {
    if (payloadPath && fs.existsSync(payloadPath)) {
      try { fs.unlinkSync(payloadPath); } catch { }
    }
    if (volumeSlotAcquired) releaseVolumeComputeSlot();
  }
});

app.get('/api/download-volume-surface', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vsurf', { code: 'SURFACE_BAD_JOB_ID' });
    const fmt = String(req.query.fmt || 'obj').toLowerCase();
    const jobDir = path.join(VOLUME_SURFACE_DIR, jobId);

    let filePath;
    let filename;
    let mimeType;
    if (fmt === 'obj') {
      filePath = path.join(jobDir, 'surface.obj');
      filename = `${jobId}_surface.obj`;
      mimeType = 'text/plain; charset=utf-8';
    } else if (fmt === 'json') {
      filePath = path.join(jobDir, 'surface_mesh.json');
      filename = `${jobId}_surface_mesh.json`;
      mimeType = 'application/json';
    } else if (fmt === 'grid') {
      filePath = path.join(jobDir, 'surface_grid.json');
      filename = `${jobId}_surface_grid.json`;
      mimeType = 'application/json';
    } else {
      const error = new Error('Invalid volume surface download format');
      error.code = 'INVALID_FORMAT';
      throw error;
    }

    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume surface file not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', mimeType);
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.get('/api/volume-surface-mesh', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vsurf', { code: 'SURFACE_BAD_JOB_ID' });
    const filePath = path.join(VOLUME_SURFACE_DIR, jobId, 'surface_mesh.json');
    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume surface mesh not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.get('/api/volume-surface-grid', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vsurf', { code: 'SURFACE_BAD_JOB_ID' });
    const filePath = path.join(VOLUME_SURFACE_DIR, jobId, 'surface_grid.json');
    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume surface grid not found');
      error.code = 'SURFACE_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'SURFACE_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

app.use('/volume-surface-jobs', createGuardedStaticDirectory(VOLUME_SURFACE_DIR));

app.post('/api/volume-jobs', async (req, res) => {
  let volumeSlotAcquired = false;
  try {
    const lasPath = ensureExistingAbsoluteFile(req.body?.lasPath, {
      fieldName: 'lasPath',
      missingCode: 'FILE_NOT_FOUND',
      enforceStorageBounds: true,
    });
    assertVolumeSourceWithinLimits(lasPath);
    const validation = validateVolumeJobRequest({
      polygon: req.body?.polygon,
      resolution: req.body?.resolution,
    });

    const scenarioMode = String(req.body?.scenarioMode || 'stockpile_boundary').trim() || 'stockpile_boundary';
    const rawHoleFillMode = String(req.body?.holeFillMode || req.body?.holeMode || 'interpolate').toLowerCase();
    const holeFillMode = rawHoleFillMode === 'reference'
      ? 'fixed'
      : (rawHoleFillMode === 'ignore' ? 'leave' : rawHoleFillMode);
    if (!['leave', 'interpolate', 'fixed'].includes(holeFillMode)) {
      const error = new Error('Unsupported hole fill mode for volume job generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const analysisSurface = {
      surfaceType: String(req.body?.analysisSurface?.surfaceType || req.body?.surfaceType || 'stockpile').toLowerCase(),
      aggregateMode: String(req.body?.analysisSurface?.aggregateMode || req.body?.aggregateMode || 'p80').toLowerCase(),
      pointFilterMode: String(req.body?.analysisSurface?.pointFilterMode || 'none').toLowerCase(),
      spikeThreshold: parseOptionalFiniteNumber(
        req.body?.analysisSurface?.spikeThreshold ?? req.body?.spikeThreshold,
        {
          fieldName: 'analysisSurface.spikeThreshold',
          errorMessage: 'Invalid spike threshold for volume job generation.',
        }
      ),
    };
    if (!['stockpile', 'dsm', 'dtm'].includes(analysisSurface.surfaceType)) {
      const error = new Error('Unsupported analysis surface type for volume job generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }
    if (!['none', 'all', 'exclude_vegetation', 'exclude_vegetation_buildings', 'ground_only'].includes(analysisSurface.pointFilterMode)) {
      const error = new Error('Unsupported point filter mode for volume job generation.');
      error.code = 'BAD_REQUEST';
      throw error;
    }

    const baseSurface = {
      mode: normalizeVolumeBaseMode(req.body?.baseSurface?.mode, scenarioMode),
      referenceHeight: parseOptionalFiniteNumber(
        req.body?.baseSurface?.referenceHeight ?? req.body?.referenceHeight,
        {
          fieldName: 'baseSurface.referenceHeight',
          errorMessage: 'Invalid base surface reference height for volume job generation.',
        }
      ),
    };

    const fixedHeight = parseOptionalFiniteNumber(req.body?.fixedHeight, {
      fieldName: 'fixedHeight',
      errorMessage: 'Invalid fixed height for volume job generation.',
    });

    const volumeQueueState = await acquireVolumeComputeSlot();
    volumeSlotAcquired = true;

    const jobId = createTimestampJobId('vol');
    const outputDir = path.join(VOLUME_JOB_DIR, jobId);
    fs.mkdirSync(outputDir, { recursive: true });

    const payloadPath = path.join(outputDir, 'request_payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({
      jobId,
      outputDir,
      lasPath,
      regionName: String(req.body?.regionName || 'Volume Region'),
      pointcloudName: String(req.body?.pointcloudName || req.body?.cloudName || 'Point Cloud'),
      polygon: validation.polygon,
      resolution: validation.resolution,
      scenarioMode,
      analysisSurface,
      baseSurface,
      holeFillMode,
      fixedHeight,
    }, null, 2), 'utf8');

    const pythonResult = await runPython(
      EFFECTIVE_TERRAIN_PYTHON_BIN,
      [VOLUME_ANALYSIS_SCRIPT, payloadPath],
      VOLUME_SURFACE_LIMITS.timeoutMs
    );

    const requiredOutputs = [
      path.join(outputDir, 'result.json'),
      path.join(outputDir, 'analysis_surface_mesh.json'),
      path.join(outputDir, 'analysis_surface_grid.json'),
      path.join(outputDir, 'base_surface_mesh.json'),
      path.join(outputDir, 'base_surface_grid.json'),
    ];
    if (requiredOutputs.some(filePath => !fs.existsSync(filePath))) {
      const error = new Error('Volume job generation did not produce the expected output files.');
      error.code = 'INTERNAL_ERROR';
      throw error;
    }

    let result = {};
    try {
      result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
    } catch {
      result = {};
    }

    return sendApiSuccess(res, {
      jobId,
      result,
      resultUrl: `/api/volume-results?jobId=${encodeURIComponent(jobId)}`,
      reportPdfUrl: `/api/download-volume-job?jobId=${encodeURIComponent(jobId)}&artifact=report-pdf`,
      analysisMeshUrl: `/api/volume-mesh?jobId=${encodeURIComponent(jobId)}&surface=analysis`,
      baseMeshUrl: `/api/volume-mesh?jobId=${encodeURIComponent(jobId)}&surface=base`,
      analysisGridUrl: `/api/volume-grid?jobId=${encodeURIComponent(jobId)}&surface=analysis`,
      baseGridUrl: `/api/volume-grid?jobId=${encodeURIComponent(jobId)}&surface=base`,
      previewAnalysisUrl: `/volume-jobs/${encodeURIComponent(jobId)}/preview_analysis.png`,
      previewBaseUrl: `/volume-jobs/${encodeURIComponent(jobId)}/preview_base.png`,
      stats: pythonResult?.stats || result?.stats || {},
      volume: pythonResult?.volume || result?.volume || {},
      diagnostic: pythonResult?.diagnostic || result?.diagnostic || {},
      queue: volumeQueueState,
      limits: {
        estimatedCells: validation.estimatedCells,
        estimatedRows: validation.estimatedRows,
        estimatedCols: validation.estimatedCols,
        polygonArea: validation.polygonArea,
      },
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'VOLUME_JOB_FAILED',
      fallbackStatus: error?.code === 'BAD_REQUEST' ? 400 : 500,
    });
  } finally {
    if (volumeSlotAcquired) releaseVolumeComputeSlot();
  }
});

app.get('/api/volume-results', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vol', { code: 'VOLUME_BAD_JOB_ID' });
    const filePath = path.join(VOLUME_JOB_DIR, jobId, 'result.json');
    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume result not found');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'VOLUME_FILE_NOT_FOUND',
      fallbackStatus: error?.code === 'VOLUME_BAD_JOB_ID' ? 400 : 404,
    });
  }
});

app.get('/api/volume-mesh', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vol', { code: 'VOLUME_BAD_JOB_ID' });
    const surface = requireVolumeJobSurface(req.query.surface);
    const filePath = path.join(VOLUME_JOB_DIR, jobId, `${surface}_surface_mesh.json`);
    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume mesh not found');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'VOLUME_FILE_NOT_FOUND',
      fallbackStatus: error?.code === 'BAD_REQUEST' || error?.code === 'VOLUME_BAD_JOB_ID' ? 400 : 404,
    });
  }
});

app.get('/api/volume-grid', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vol', { code: 'VOLUME_BAD_JOB_ID' });
    const surface = requireVolumeJobSurface(req.query.surface);
    const filePath = path.join(VOLUME_JOB_DIR, jobId, `${surface}_surface_grid.json`);
    if (!fs.existsSync(filePath)) {
      const error = new Error('Volume grid not found');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'VOLUME_FILE_NOT_FOUND',
      fallbackStatus: error?.code === 'BAD_REQUEST' || error?.code === 'VOLUME_BAD_JOB_ID' ? 400 : 404,
    });
  }
});

app.post('/api/volume-report-view-snapshot', async (req, res) => {
  try {
    const jobId = requireJobId(req.body?.jobId, 'vol', { code: 'VOLUME_BAD_JOB_ID' });
    const jobDir = path.join(VOLUME_JOB_DIR, jobId);
    if (!fs.existsSync(jobDir)) {
      const error = new Error('Volume job not found');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }

    const resultPath = path.join(jobDir, 'result.json');
    const analysisPreviewPath = path.join(jobDir, 'preview_analysis.png');
    const basePreviewPath = path.join(jobDir, 'preview_base.png');
    if (!fs.existsSync(resultPath) || !fs.existsSync(analysisPreviewPath) || !fs.existsSync(basePreviewPath)) {
      const error = new Error('Volume job artifacts are incomplete, cannot rebuild report.');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }

    const viewportPreviewPath = path.join(jobDir, 'viewer_snapshot.png');
    writePngDataUrlToFile(req.body?.imageDataUrl, viewportPreviewPath);

    const payloadPath = path.join(jobDir, 'report_refresh_payload.json');
    const outputPath = path.join(jobDir, 'volume_report.pdf');
    fs.writeFileSync(payloadPath, JSON.stringify({
      reportOnly: true,
      outputPath,
      resultPath,
      analysisPreviewPath,
      basePreviewPath,
      viewportPreviewPath,
    }, null, 2), 'utf8');

    await runPython(
      EFFECTIVE_TERRAIN_PYTHON_BIN,
      [VOLUME_ANALYSIS_SCRIPT, payloadPath],
      VOLUME_SURFACE_LIMITS.timeoutMs
    );

    if (!fs.existsSync(outputPath)) {
      const error = new Error('Volume report rebuild did not produce a PDF file.');
      error.code = 'INTERNAL_ERROR';
      throw error;
    }

    return sendApiSuccess(res, {
      jobId,
      reportPdfUrl: `/api/download-volume-job?jobId=${encodeURIComponent(jobId)}&artifact=report-pdf`,
      viewportPreviewUrl: `/volume-jobs/${encodeURIComponent(jobId)}/viewer_snapshot.png`,
    });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: error?.code || 'VOLUME_JOB_FAILED',
      fallbackStatus: error?.code === 'BAD_REQUEST' ? 400 : 500,
    });
  }
});

app.get('/api/download-volume-job', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'vol', { code: 'VOLUME_BAD_JOB_ID' });
    const artifact = String(req.query.artifact || 'result').toLowerCase();
    const descriptor = getVolumeJobArtifactPath(jobId, artifact);
    if (!descriptor) {
      const error = new Error('Invalid volume job artifact');
      error.code = 'INVALID_FORMAT';
      throw error;
    }
    if (!fs.existsSync(descriptor.filePath)) {
      const error = new Error('Volume job artifact not found');
      error.code = 'VOLUME_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${descriptor.filename}"`);
    res.setHeader('Content-Type', descriptor.mimeType);
    return res.sendFile(descriptor.filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'VOLUME_FILE_NOT_FOUND',
      fallbackStatus: error?.code === 'INVALID_FORMAT' || error?.code === 'VOLUME_BAD_JOB_ID' ? 400 : 404,
    });
  }
});

app.use('/volume-jobs', createGuardedStaticDirectory(VOLUME_JOB_DIR));

// POST /api/generate-contours
app.post('/api/generate-contours', async (_req, res) => {
  const error = new Error('Contour generation is disabled on the production server to protect stability.');
  error.code = 'CONTOURS_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'CONTOURS_DISABLED',
    fallbackStatus: 503,
  });
});

// GET /api/download-contours?jobId=xxx&fmt=geojson
app.get('/api/download-contours', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'cnt', { code: 'DTM_BAD_JOB_ID' });
    const fmt = String(req.query.fmt || 'geojson');
    const jobDir = path.join(CONTOUR_DIR, jobId);
  let filePath, filename, mimeType;

  if (fmt === 'geojson') {
    filePath = path.join(jobDir, 'contours.geojson');
    filename = `${jobId}_contours.geojson`;
    mimeType = 'application/geo+json';
  } else if (fmt === 'dxf') {
    filePath = path.join(jobDir, 'contours.dxf');
    filename = `${jobId}_contours.dxf`;
    mimeType = 'application/dxf';
  } else {
      const error = new Error('Invalid format');
      error.code = 'INVALID_FORMAT';
      throw error;
  }

  if (!fs.existsSync(filePath)) {
      const error = new Error(`${fmt} file not found`);
      error.code = 'DTM_FILE_NOT_FOUND';
      throw error;
  }

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', mimeType);
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'DTM_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

// GET /api/contour-geojson?jobId=xxx — return GeoJSON data for 3D viewer (no attachment)
app.get('/api/contour-geojson', (req, res) => {
  try {
    const jobId = requireJobId(req.query.jobId, 'cnt', { code: 'DTM_BAD_JOB_ID' });
    const filePath = path.join(CONTOUR_DIR, jobId, 'contours.geojson');
    if (!fs.existsSync(filePath)) {
      const error = new Error('GeoJSON not found');
      error.code = 'DTM_FILE_NOT_FOUND';
      throw error;
    }
    res.setHeader('Content-Type', 'application/json');
    return res.sendFile(filePath);
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'DTM_FILE_NOT_FOUND',
      fallbackStatus: 404,
    });
  }
});

// ═══════════════════════════════════════════════════════════
// Ground Classification API
// ═══════════════════════════════════════════════════════════

const CLASSIFY_SCRIPT = path.join(__dirname, 'scripts', 'classify_ground.py');
const HAG_SCRIPT = path.join(__dirname, 'scripts', 'generate_hag.py');
const GEOMETRY_SCRIPT = path.join(__dirname, 'scripts', 'compute_geometric_features.py');
const RULE_CLASSIFY_SCRIPT = path.join(__dirname, 'scripts', 'classify_rule_based.py');
const TREE_SEGMENT_SCRIPT = path.join(__dirname, 'scripts', 'segment_individual_trees.py');
const SANITIZE_FOR_POTREE_SCRIPT = path.join(__dirname, 'scripts', 'sanitize_for_potree.py');
const FORESTRY_DETECT_SCRIPT = path.join(__dirname, 'scripts', 'forestry_detect_stems.py');
const FORESTRY_SEGMENT_SCRIPT = path.join(__dirname, 'scripts', 'forestry_segment.py');
const FORESTRY_EXPORT_SCRIPT = path.join(__dirname, 'scripts', 'forestry_export.py');

// POST /api/classify-ground
// Body: {
//   lasPath,
//   clothResolution?,
//   classThreshold?,
//   rigidness?,
//   iterations?,
//   slopeSmooth?,
//   outputPath?
// }
app.post('/api/classify-ground', async (_req, res) => {
  const error = new Error('Ground classification is disabled on the production server to protect stability.');
  error.code = 'CLASSIFY_GROUND_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'CLASSIFY_GROUND_DISABLED',
    fallbackStatus: 503,
  });
});

// ── Delete a converted cloud (password-protected) ──────────────────
// Removes: pointclouds/{name}/, original upload file (if any), and
// scanner project folder (if this was a ZIP project upload).
// POST /api/generate-hag
// Body: {
//   lasPath,
//   outputPath?,
//   neighborCount?,
//   groundClass?,
//   weightPower?,
//   heightDimension?
// }
app.post('/api/generate-hag', async (_req, res) => {
  const error = new Error('Height-above-ground generation is disabled on the production server to protect stability.');
  error.code = 'HAG_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'HAG_DISABLED',
    fallbackStatus: 503,
  });
});

// POST /api/compute-geometric-features
// Body: { lasPath, outputPath?, neighborCount? }
app.post('/api/compute-geometric-features', async (_req, res) => {
  const error = new Error('Geometric feature computation is disabled on the production server to protect stability.');
  error.code = 'GEOMETRY_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'GEOMETRY_DISABLED',
    fallbackStatus: 503,
  });
});

// POST /api/classify-rule-based
// Body: { lasPath, outputPath?, groundClass?, hagDimension? }
app.post('/api/classify-rule-based', async (_req, res) => {
  const error = new Error('Rule-based classification is disabled on the production server to protect stability.');
  error.code = 'CLASSIFY_RULE_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'CLASSIFY_RULE_DISABLED',
    fallbackStatus: 503,
  });
});

// POST /api/segment-individual-trees
// Body: { lasPath, outputPath?, seedMinHeight?, seedMaxHeight?, clusterRadius?, maxCrownRadius?, chmResolution? }
app.post('/api/segment-individual-trees', async (_req, res) => {
  const error = new Error('Individual tree segmentation is disabled on the production server to protect stability.');
  error.code = 'TREE_SEGMENT_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'TREE_SEGMENT_DISABLED',
    fallbackStatus: 503,
  });
});

// POST /api/run-semantic-pipeline
// Body: {
//   lasPath,
//   outputPath?,
//   groundClass?,
//   hagNeighborCount?,
//   hagWeightPower?,
//   geometryNeighborCount?,
//   hagDimension?
// }
app.get('/api/terrain-jobs/:jobId', (req, res) => {
  try {
    pruneTerrainAsyncJobs();
    const jobId = requireNonEmptyString(req.params.jobId, 'jobId', { code: 'BAD_REQUEST' });
    const job = TERRAIN_ASYNC_JOBS.get(jobId);
    if (!job) {
      return sendApiError(res, new Error('Terrain job not found'), {
        fallbackCode: 'JOB_NOT_FOUND',
        fallbackStatus: 404,
      });
    }
    return sendApiSuccess(res, { job });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'BAD_REQUEST',
      fallbackStatus: 400,
    });
  }
});

app.get('/api/jobs/:jobId', (req, res) => {
  try {
    pruneTerrainAsyncJobs();
    pruneForestryAsyncJobs();
    const jobId = requireNonEmptyString(req.params.jobId, 'jobId', { code: 'BAD_REQUEST' });
    const job = getAnyAsyncJob(jobId);
    if (!job) {
      return sendApiError(res, new Error('Job not found'), {
        fallbackCode: 'JOB_NOT_FOUND',
        fallbackStatus: 404,
      });
    }
    return sendApiSuccess(res, { job });
  } catch (error) {
    return sendApiError(res, error, {
      fallbackCode: 'BAD_REQUEST',
      fallbackStatus: 400,
    });
  }
});

app.post('/api/run-semantic-pipeline', async (_req, res) => {
  const error = new Error('Semantic pipeline is disabled on the production server to protect stability.');
  error.code = 'SEMANTIC_PIPELINE_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'SEMANTIC_PIPELINE_DISABLED',
    fallbackStatus: 503,
  });
});

app.post('/api/forestry/prepare', async (_req, res) => {
  const error = new Error('Forestry prepare is disabled on the production server to protect stability.');
  error.code = 'FORESTRY_PREPARE_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'FORESTRY_PREPARE_DISABLED',
    fallbackStatus: 503,
  });
});

app.post('/api/forestry/detect-stems', async (_req, res) => {
  const error = new Error('Forestry stem detection is disabled on the production server to protect stability.');
  error.code = 'FORESTRY_STEMS_DISABLED';
  error.status = 503;
  return sendApiError(res, error, {
    fallbackCode: 'FORESTRY_STEMS_DISABLED',
    fallbackStatus: 503,
  });
});

app.post('/api/forestry/update-seeds', async (req, res) => {
  try {
    const { runId, projectPath, projectId, seeds = [] } = req.body || {};
    const normalizedRunId = requireNonEmptyString(runId, 'runId', { code: 'BAD_REQUEST' });
    const projectContext = resolveForestryProjectContext(projectPath, projectId);
    const runPaths = getForestryRunPaths(projectContext, normalizedRunId);
    ensureForestryRunDir(runPaths);
    const payload = persistForestrySeeds(
      runPaths,
      normalizedRunId,
      runPaths.projectDir,
      readJsonFileSafe(runPaths.stemsPath, {})?.algorithm || 'treeiso',
      seeds
    );
    payload.projectId = projectContext.projectId;
    fs.writeFileSync(runPaths.stemsPath, JSON.stringify(payload, null, 2), 'utf8');
    return sendApiSuccess(res, {
      runId: normalizedRunId,
      projectId: projectContext.projectId,
      stemsPath: runPaths.stemsPath,
      seedCount: payload.seeds.length,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_UPDATE_SEEDS_FAILED', fallbackStatus: 500 });
  }
});

app.post('/api/forestry/update-tree-review', async (req, res) => {
  try {
    const { runId, projectPath, projectId, reviews = [] } = req.body || {};
    const normalizedRunId = requireNonEmptyString(runId, 'runId', { code: 'BAD_REQUEST' });
    const projectContext = resolveForestryProjectContext(projectPath, projectId);
    const runPaths = getForestryRunPaths(projectContext, normalizedRunId);
    ensureForestryRunDir(runPaths);
    const payload = {
      runId: normalizedRunId,
      projectId: projectContext.projectId,
      projectPath: runPaths.projectDir,
      reviews: Array.isArray(reviews) ? reviews
        .map(review => ({
          treeId: Number(review?.treeId || 0),
          status: String(review?.status || 'auto'),
          note: String(review?.note || ''),
          edited: Boolean(review?.edited ?? true),
          updatedAt: String(review?.updatedAt || new Date().toISOString()),
        }))
        .filter(review => review.treeId > 0) : [],
    };
    fs.writeFileSync(runPaths.treeReviewPath, JSON.stringify(payload, null, 2), 'utf8');
    return sendApiSuccess(res, {
      runId: normalizedRunId,
      projectId: projectContext.projectId,
      treeReviewPath: runPaths.treeReviewPath,
      reviewCount: payload.reviews.length,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_UPDATE_TREE_REVIEW_FAILED', fallbackStatus: 500 });
  }
});

app.post('/api/forestry/segment', async (req, res) => {
  try {
    const {
      runId,
      projectPath,
      projectId,
      algorithm = 'treeiso',
      async: asyncMode = true,
    } = req.body || {};
    const normalizedRunId = requireNonEmptyString(runId, 'runId', { code: 'BAD_REQUEST' });
    const projectContext = resolveForestryProjectContext(projectPath, projectId);
    const runPaths = getForestryRunPaths(projectContext, normalizedRunId);
    ensureForestryRunDir(runPaths);
    ensureExistingAbsoluteFile(runPaths.preparedPath, { fieldName: 'preparedPath', missingMessage: 'Prepare step must run first' });
    ensureExistingAbsoluteFile(runPaths.stemsPath, { fieldName: 'stemsPath', missingMessage: 'Detect stems step must run first' });

    if (asyncMode) {
      const job = createForestryAsyncJob('frseg', {
        runId: normalizedRunId,
        projectId: projectContext.projectId,
        projectPath: runPaths.projectDir,
        inputPath: runPaths.preparedPath,
        outputPath: runPaths.segmentedPath,
        message: 'Queued forestry segmentation',
      });
      const updateJob = (patch = {}) => updateForestryAsyncJob(job.jobId, patch);
      setImmediate(async () => {
        try {
          if (fs.existsSync(runPaths.treeReviewPath)) {
            fs.unlinkSync(runPaths.treeReviewPath);
          }
          updateJob({ status: 'running', stage: 'segment', progress: 10, message: `Segmenting trees (${algorithm})` });
          const segmentResult = await runPythonStreaming(
            PYTHON_BIN,
            [FORESTRY_SEGMENT_SCRIPT, runPaths.preparedPath, runPaths.stemsPath, runPaths.segmentedPath, normalizedRunId, runPaths.projectDir, String(algorithm)],
            {
              timeoutMs: 3600000,
              onStdoutLine: line => updateJob({ stage: 'segment', progress: 70, message: line.slice(0, 240) }),
            }
          );
          if (Array.isArray(segmentResult?.seeds) && segmentResult.seeds.length) {
            persistForestrySeeds(runPaths, normalizedRunId, runPaths.projectDir, algorithm, segmentResult.seeds);
          }
          updateJob({ status: 'running', stage: 'export', progress: 85, message: 'Building forestry exports' });
          const exportResult = await runTerrainPythonJob(
            FORESTRY_EXPORT_SCRIPT,
            [runPaths.segmentedPath, runPaths.stemsPath, runPaths.csvPath, runPaths.geojsonPath, normalizedRunId, '[]', runPaths.treeReviewPath],
            { timeoutMs: 1800000, errorCode: 'FORESTRY_EXPORT_FAILED', logLabel: 'ForestryExport' }
          );
          updateJob({
            status: 'completed',
            stage: 'completed',
            progress: 100,
            message: 'Forestry segmentation completed',
            result: {
              runId: normalizedRunId,
              projectId: projectContext.projectId,
              segmentedPath: runPaths.segmentedPath,
              csvPath: exportResult.csvPath || runPaths.csvPath,
              geojsonPath: exportResult.geojsonPath || runPaths.geojsonPath,
              stats: segmentResult.stats || {},
              trees: parseSimpleCsv(runPaths.csvPath),
            },
          });
        } catch (error) {
          updateJob({ status: 'failed', stage: 'failed', message: error.message, error: error.message });
        }
      });
      return sendApiSuccess(res, { jobId: job.jobId, async: true, runId: normalizedRunId });
    }

    if (fs.existsSync(runPaths.treeReviewPath)) {
      fs.unlinkSync(runPaths.treeReviewPath);
    }
    const segmentResult = await runTerrainPythonJob(
      FORESTRY_SEGMENT_SCRIPT,
      [runPaths.preparedPath, runPaths.stemsPath, runPaths.segmentedPath, normalizedRunId, runPaths.projectDir, String(algorithm)],
      { timeoutMs: 3600000, errorCode: 'FORESTRY_SEGMENT_FAILED', logLabel: 'ForestrySegment' }
    );
    if (Array.isArray(segmentResult?.seeds) && segmentResult.seeds.length) {
      persistForestrySeeds(runPaths, normalizedRunId, runPaths.projectDir, algorithm, segmentResult.seeds);
    }
    const exportResult = await runTerrainPythonJob(
      FORESTRY_EXPORT_SCRIPT,
      [runPaths.segmentedPath, runPaths.stemsPath, runPaths.csvPath, runPaths.geojsonPath, normalizedRunId, '[]', runPaths.treeReviewPath],
      { timeoutMs: 1800000, errorCode: 'FORESTRY_EXPORT_FAILED', logLabel: 'ForestryExport' }
    );
    return sendApiSuccess(res, {
      runId: normalizedRunId,
      projectId: projectContext.projectId,
      segmentedPath: runPaths.segmentedPath,
      csvPath: exportResult.csvPath || runPaths.csvPath,
      geojsonPath: exportResult.geojsonPath || runPaths.geojsonPath,
      stats: segmentResult.stats || {},
      trees: parseSimpleCsv(runPaths.csvPath),
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_SEGMENT_FAILED', fallbackStatus: 500 });
  }
});

app.get('/api/forestry/results/:runId', async (req, res) => {
  try {
    const runId = requireNonEmptyString(req.params.runId, 'runId', { code: 'BAD_REQUEST' });
    const projectContext = resolveForestryProjectContext(req.query.projectPath, req.query.projectId);
    const runPaths = getForestryRunPaths(projectContext, runId);
    const stems = readJsonFileSafe(runPaths.stemsPath, { seeds: [] });
    const geojson = readJsonFileSafe(runPaths.geojsonPath, { features: [] });
    const reviewPayload = readJsonFileSafe(runPaths.treeReviewPath, { reviews: [] });
    const reviewMap = new Map(
      Array.isArray(reviewPayload?.reviews)
        ? reviewPayload.reviews
          .map(review => [Number(review?.treeId || 0), review])
          .filter(([treeId]) => treeId > 0)
        : []
    );
    const trees = (Array.isArray(geojson?.features)
      ? geojson.features.map(feature => feature.properties || {})
      : parseSimpleCsv(runPaths.csvPath))
      .map(tree => {
        const treeId = Number(tree?.treeId || 0);
        const review = reviewMap.get(treeId) || null;
        return {
          ...tree,
          reviewStatus: review?.status || '',
          reviewNote: review?.note || '',
          edited: Boolean(review?.edited || false),
          reviewUpdatedAt: review?.updatedAt || '',
        };
      });
    return sendApiSuccess(res, {
      runId,
      projectId: projectContext.projectId,
      projectPath: runPaths.projectDir,
      files: {
        preparedPath: fs.existsSync(runPaths.preparedPath) ? runPaths.preparedPath : null,
        stemsPath: fs.existsSync(runPaths.stemsPath) ? runPaths.stemsPath : null,
        segmentedPath: fs.existsSync(runPaths.segmentedPath) ? runPaths.segmentedPath : null,
        csvPath: fs.existsSync(runPaths.csvPath) ? runPaths.csvPath : null,
        geojsonPath: fs.existsSync(runPaths.geojsonPath) ? runPaths.geojsonPath : null,
      },
      seeds: Array.isArray(stems?.seeds) ? stems.seeds : [],
      trees,
      treeReviews: Array.isArray(reviewPayload?.reviews) ? reviewPayload.reviews : [],
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_RESULTS_FAILED', fallbackStatus: 500 });
  }
});

app.get('/api/forestry/runs/latest', async (req, res) => {
  try {
    const projectContext = resolveForestryProjectContext(req.query.projectPath, req.query.projectId);
    const runs = listForestryRuns(projectContext);
    const latest = runs[0] || null;
    return sendApiSuccess(res, {
      projectId: projectContext.projectId,
      projectPath: projectContext.projectDir,
      latestRun: latest,
      runCount: runs.length,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_RESULTS_FAILED', fallbackStatus: 500 });
  }
});

app.post('/api/forestry/export', async (req, res) => {
  try {
    const { runId, projectPath, projectId, treeIds = null } = req.body || {};
    const normalizedRunId = requireNonEmptyString(runId, 'runId', { code: 'BAD_REQUEST' });
    const projectContext = resolveForestryProjectContext(projectPath, projectId);
    const runPaths = getForestryRunPaths(projectContext, normalizedRunId);
    ensureExistingAbsoluteFile(runPaths.segmentedPath, { fieldName: 'segmentedPath', missingMessage: 'Segment step must run first' });
    ensureExistingAbsoluteFile(runPaths.stemsPath, { fieldName: 'stemsPath', missingMessage: 'Stem file missing' });

    const exportTag = Array.isArray(treeIds) && treeIds.length ? `selected_${Date.now()}` : 'all';
    const csvPath = path.join(runPaths.runDir, `trees_${exportTag}.csv`);
    const geojsonPath = path.join(runPaths.runDir, `trees_${exportTag}.geojson`);
    const exportResult = await runTerrainPythonJob(
      FORESTRY_EXPORT_SCRIPT,
      [runPaths.segmentedPath, runPaths.stemsPath, csvPath, geojsonPath, normalizedRunId, JSON.stringify(Array.isArray(treeIds) ? treeIds : []), runPaths.treeReviewPath],
      { timeoutMs: 1800000, errorCode: 'FORESTRY_EXPORT_FAILED', logLabel: 'ForestryExport' }
    );
    return sendApiSuccess(res, {
      runId: normalizedRunId,
      projectId: projectContext.projectId,
      csvPath: exportResult.csvPath || csvPath,
      geojsonPath: exportResult.geojsonPath || geojsonPath,
      segmentedPath: runPaths.segmentedPath,
    });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'FORESTRY_EXPORT_FAILED', fallbackStatus: 500 });
  }
});

app.post('/api/delete-cloud', (req, res) => {
  try {
    const deletePassword = process.env.DELETE_CLOUD_PASSWORD;
    if (!deletePassword) {
      const error = new Error('Delete password not configured on server');
      error.code = 'DELETE_PASSWORD_NOT_CONFIGURED';
      throw error;
    }

    if (String(req.body?.password || '') !== String(deletePassword)) {
      const error = new Error('Wrong password');
      error.code = 'WRONG_PASSWORD';
      throw error;
    }

    const cloudName = requireSafeCloudName(req.body?.cloudName);
    const resourceType = String(req.body?.resourceType || '').trim().toLowerCase();
    const gaussianDir = path.join(GAUSSIANS_DIR, cloudName);

    if (resourceType === 'gaussian') {
      if (!fs.existsSync(gaussianDir)) {
        const error = new Error('Cloud not found');
        error.code = 'NOT_FOUND';
        throw error;
      }

      const deleted = [];
      const errors = [];
      try {
        fs.rmSync(gaussianDir, { recursive: true, force: true });
        deleted.push(`gaussians/${cloudName}/`);
      } catch (e) {
        errors.push(`gaussians/${cloudName}/: ${e.message}`);
      }

      console.log(`[Delete] Gaussian '${cloudName}' deleted. Items: [${deleted.join(', ')}]`);
      return sendApiSuccess(res, { cloudName, deleted, errors, resourceType: 'gaussian' });
    }

    const localEntry = getLocalImportEntry(cloudName);
    const cloudDir = path.join(POINTCLOUDS_DIR, cloudName);
    if (!fs.existsSync(cloudDir) && !localEntry) {
      const error = new Error('Cloud not found');
      error.code = 'NOT_FOUND';
      throw error;
    }

    let manifest = localEntry;
    try { manifest = readUploadSourceManifest(cloudName) || localEntry; } catch { }

    const deleted = [];
    const errors = [];

    if (localEntry) {
      removeLocalImportEntry(cloudName);
      deleted.push(`registry:${cloudName}`);
    } else {
      try {
        fs.rmSync(cloudDir, { recursive: true, force: true });
        deleted.push(`pointclouds/${cloudName}/`);
      } catch (e) {
        errors.push(`pointclouds/${cloudName}/: ${e.message}`);
      }
    }

    if (!localEntry && manifest?.uploadFilename) {
      const uploadPath = path.join(UPLOADS_DIR, manifest.uploadFilename);
      if (fs.existsSync(uploadPath)) {
        try {
          fs.unlinkSync(uploadPath);
          deleted.push(`uploads/${manifest.uploadFilename}`);
        } catch (e) {
          errors.push(`uploads/${manifest.uploadFilename}: ${e.message}`);
        }
      }
    }

    if (!localEntry && manifest?.projectDir) {
      const projDir = path.resolve(manifest.projectDir);
      const projectsRoot = path.resolve(PROJECTS_DIR);
      if (projDir.startsWith(projectsRoot + path.sep) && fs.existsSync(projDir)) {
        try {
          fs.rmSync(projDir, { recursive: true, force: true });
          deleted.push(`projects/${path.basename(projDir)}/`);
        } catch (e) {
          errors.push(`projects/${path.basename(projDir)}/: ${e.message}`);
        }
      }
    }

    discoverScanProjects();
    console.log(`[Delete] Cloud '${cloudName}' deleted. Items: [${deleted.join(', ')}]`);
    return sendApiSuccess(res, { cloudName, deleted, errors, resourceType: 'pointcloud' });
  } catch (error) {
    return sendApiError(res, error, { fallbackCode: 'INTERNAL_ERROR' });
  }
});

app.use((error, req, res, next) => {
  if (!error) return next();
  if (res.headersSent) return next(error);
  console.error('[API] Unhandled request error:', error);
  return sendApiError(res, error, {
    fallbackCode: error?.code || 'INTERNAL_ERROR',
    fallbackStatus: 500,
  });
});

if (process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN !== '1') {
  // ── Initial project discovery ──
  const initialProjects = discoverScanProjects();
  cleanupOldExports();
  cleanupOldVolumeJobs();
  setInterval(() => cleanupOldVolumeJobs(), VOLUME_JOB_CLEANUP_INTERVAL_MS).unref?.();
  ensureBuiltinGridsRegistered().catch(error => {
    console.warn('[Grid] Failed to preload built-in grids:', error.message);
  });
  console.log(`[Scanner] Discovered ${initialProjects.length} scanner project(s):`,
    initialProjects.map(p => p.name).join(', ') || 'none');

  const server = app.listen(PORT, HOST, () => {
    console.log(`Potree local uploader running: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });

  server.on('error', (error) => {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  });
}

export {
  app,
  assertPathWithinCloudStudioBounds,
  UPLOAD_LIMITS,
  GAUSSIAN_UPLOAD_EXTENSIONS,
  ZIP_MAX_FILE_BYTES,
  ZIP_MAX_FILES,
  ZIP_MAX_TOTAL_BYTES,
  buildGaussianCloudListEntry,
  buildGaussianEditorUrl,
  buildPreconvertedZipExtractScript,
  buildScannerProjectZipExtractScript,
  createGaussianDirectManifest,
  createUploadFileFilter,
  ensureExistingBoundedPath,
  getUploadPasswordCandidate,
  isPathWithinCloudStudioBounds,
  requiresExplicitUploadPasswordEnv,
  resolveGaussianViewerRotation,
  resolveUploadPasswordHash,
  uploadCredentialJsonPrecheck,
  verifyUploadPassword,
  verifyPreMulterUploadCredential,
  verifyUploadCredentialFromRequest,
};
