import fs from 'fs';
import path from 'path';

const STORAGE_DIR_NAMES = Object.freeze({
  uploads: 'uploads',
  pointclouds: 'pointclouds',
  gaussians: 'gaussians',
  projects: 'projects',
  exports: 'exports',
  cache: 'cache',
});

function uniqPaths(paths = []) {
  const seen = new Set();
  const result = [];
  for (const candidate of paths) {
    if (!candidate) continue;
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveConfiguredStorageRoot(appDir, env = {}) {
  const entries = [
    ['CLOUDSTUDIO_DATA_DIR', env.CLOUDSTUDIO_DATA_DIR],
    ['CLOUDSTUDIO_STORAGE_ROOT', env.CLOUDSTUDIO_STORAGE_ROOT],
  ];

  for (const [envName, rawValue] of entries) {
    const value = String(rawValue || '').trim();
    if (!value) continue;
    return {
      root: path.isAbsolute(value) ? path.resolve(value) : path.resolve(appDir, value),
      envName,
    };
  }

  return {
    root: null,
    envName: null,
  };
}

function buildDirConfig(appDir, rootDir, key) {
  const dirName = STORAGE_DIR_NAMES[key];
  const primary = path.join(rootDir, dirName);
  const legacy = path.join(appDir, dirName);
  return {
    key,
    name: dirName,
    primary,
    legacy,
    candidates: uniqPaths([primary, legacy]),
  };
}

export function buildRuntimeStorageLayout({ appDir, env = process.env } = {}) {
  if (!appDir) {
    throw new Error('appDir is required to build runtime storage layout.');
  }

  const legacyRoot = path.resolve(appDir);
  const configured = resolveConfiguredStorageRoot(legacyRoot, env);
  const configuredRoot = configured.root;
  const storageRoot = configuredRoot || legacyRoot;
  const usesExternalStorage = Boolean(configuredRoot && configuredRoot !== legacyRoot);

  const uploads = buildDirConfig(legacyRoot, storageRoot, 'uploads');
  const pointclouds = buildDirConfig(legacyRoot, storageRoot, 'pointclouds');
  const gaussians = buildDirConfig(legacyRoot, storageRoot, 'gaussians');
  const projects = buildDirConfig(legacyRoot, storageRoot, 'projects');
  const exportsDir = buildDirConfig(legacyRoot, storageRoot, 'exports');
  const cache = buildDirConfig(legacyRoot, storageRoot, 'cache');

  return {
    appDir: legacyRoot,
    storageRoot,
    configuredStorageRoot: configuredRoot,
    configuredStorageEnv: configured.envName,
    usesExternalStorage,
    uploads,
    pointclouds,
    gaussians,
    projects,
    exports: exportsDir,
    cache,
    gridStorage: {
      primary: path.join(cache.primary, 'grids'),
      legacy: path.join(cache.legacy, 'grids'),
      candidates: uniqPaths([
        path.join(cache.primary, 'grids'),
        path.join(cache.legacy, 'grids'),
      ]),
    },
  };
}

export function ensureRuntimeStorageLayout(layout) {
  const directories = [
    layout?.uploads?.primary,
    layout?.pointclouds?.primary,
    layout?.gaussians?.primary,
    layout?.projects?.primary,
    layout?.exports?.primary,
    layout?.cache?.primary,
    layout?.gridStorage?.primary,
  ];

  for (const dirPath of uniqPaths(directories)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function getExistingDirectories(candidates = []) {
  return uniqPaths(candidates).filter(candidate => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  });
}

export function resolveFirstExistingPath(paths = []) {
  return uniqPaths(paths).find(candidate => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

export function resolveRuntimePath(candidates = [], ...segments) {
  return resolveFirstExistingPath(
    getExistingDirectories(candidates).map(dirPath => path.join(dirPath, ...segments))
  );
}

export function listDirectoryEntries(candidates = [], { type = null } = {}) {
  const entriesByName = new Map();
  for (const dirPath of getExistingDirectories(candidates)) {
    let dirents = [];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (entriesByName.has(dirent.name)) continue;
      if (type === 'dir' && !dirent.isDirectory()) continue;
      if (type === 'file' && !dirent.isFile()) continue;
      entriesByName.set(dirent.name, {
        name: dirent.name,
        absPath: path.join(dirPath, dirent.name),
        dirPath,
        dirent,
      });
    }
  }
  return Array.from(entriesByName.values());
}

export function getStaticRequestPathInfo(req) {
  const rawPath = String(req?.url || '').split('?')[0] || '/';
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  const normalizedPath = decodedPath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  const basename = segments.at(-1) || '';
  return {
    rawPath,
    decodedPath,
    normalizedPath,
    segments,
    basename,
    basenameLower: basename.toLowerCase(),
    ext: path.posix.extname(basename).toLowerCase(),
    hasDotSegment: segments.some(segment => segment === '.' || segment === '..'),
    hasDotfile: segments.some(segment => segment.startsWith('.')),
    hasNulByte: decodedPath.includes('\0'),
  };
}

const DEFAULT_BLOCKED_STATIC_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.staging',
  'source.json',
  'scan_roots.json',
  'request_payload.json',
  'log.txt',
  'npm-debug.log',
  'package-lock.json',
  'package.json',
]);

const DEFAULT_BLOCKED_STATIC_EXTENSIONS = new Set([
  '.bak',
  '.backup',
  '.crt',
  '.key',
  '.log',
  '.old',
  '.orig',
  '.pem',
  '.tmp',
]);

export function isSafePublicStaticRequest(req, options = {}) {
  const info = getStaticRequestPathInfo(req);
  if (!info) return false;
  if (!info.segments.length) return false;
  if (info.hasNulByte || info.hasDotSegment || info.hasDotfile) return false;

  const blockedBasenames = options.blockedBasenames || DEFAULT_BLOCKED_STATIC_BASENAMES;
  const blockedExtensions = options.blockedExtensions || DEFAULT_BLOCKED_STATIC_EXTENSIONS;
  const allowedExtensions = options.allowedExtensions || null;

  if (blockedBasenames.has(info.basenameLower)) return false;
  if (blockedExtensions.has(info.ext)) return false;
  if (info.basenameLower.endsWith('~')) return false;
  if (allowedExtensions && !allowedExtensions.has(info.ext)) return false;
  return true;
}

export function createStaticFallbackMiddleware(expressModule, candidates = [], options = {}) {
  const {
    allowRequest = null,
    denyStatus = 404,
    staticOptions = {},
  } = options;
  const effectiveStaticOptions = {
    dotfiles: 'deny',
    fallthrough: true,
    index: false,
    redirect: false,
    ...staticOptions,
  };
  const handlers = getExistingDirectories(candidates).map(dirPath => expressModule.static(dirPath, effectiveStaticOptions));
  if (!handlers.length) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    if (typeof allowRequest === 'function' && !allowRequest(req)) {
      return res.sendStatus(denyStatus);
    }

    let index = 0;
    const run = (error) => {
      if (error) return next(error);
      const handler = handlers[index];
      index += 1;
      if (!handler) return next();
      handler(req, res, run);
    };
    run();
  };
}

function findStatTarget(targetPath) {
  let current = path.resolve(targetPath);
  while (current && !fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.existsSync(current) ? current : null;
}

export function getDiskUsageSummary(targetPath) {
  if (!targetPath || typeof fs.statfsSync !== 'function') return null;
  try {
    const statTarget = findStatTarget(targetPath);
    if (!statTarget) return null;
    const stats = fs.statfsSync(statTarget);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    if (!blockSize) return null;
    const totalBytes = Number(stats.blocks || 0) * blockSize;
    const freeBytes = Number(stats.bavail || 0) * blockSize;
    const usedBytes = Math.max(0, totalBytes - (Number(stats.bfree || 0) * blockSize));
    const usageRatio = totalBytes > 0 ? usedBytes / totalBytes : null;
    return {
      targetPath: statTarget,
      totalBytes,
      usedBytes,
      freeBytes,
      usageRatio,
    };
  } catch {
    return null;
  }
}
