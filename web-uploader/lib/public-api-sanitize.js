import path from 'node:path';

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

export function shouldExposeServerPaths(env = process.env) {
  return isTruthyEnv(env.CLOUDSTUDIO_EXPOSE_SERVER_PATHS);
}

export function redactServerPath(value, {
  expose = shouldExposeServerPaths(),
  fallback = null,
  basename = false,
} = {}) {
  if (!value) return fallback;
  if (expose) return value;
  return basename ? path.basename(String(value)) : fallback;
}

export function sanitizeSourceFileForClient(file = {}, options = {}) {
  const expose = options.expose ?? shouldExposeServerPaths(options.env);
  const sanitized = { ...file };
  if (!expose) {
    delete sanitized.absPath;
    delete sanitized.filePath;
    delete sanitized.sourcePath;
    delete sanitized.originalPath;
  }
  return sanitized;
}

export function sanitizeManifestForClient(manifest = {}, options = {}) {
  const expose = options.expose ?? shouldExposeServerPaths(options.env);
  if (!manifest || typeof manifest !== 'object') return manifest;
  const sanitized = { ...manifest };
  if (!expose) {
    delete sanitized.absPath;
    delete sanitized.filePath;
    delete sanitized.sourcePath;
    delete sanitized.originalPath;
    delete sanitized.projectDir;
    delete sanitized.dirPath;
    delete sanitized.metadataPath;
    if (sanitized.convertedInputPath) {
      sanitized.convertedInputFile = path.basename(String(sanitized.convertedInputPath));
      delete sanitized.convertedInputPath;
    }
  }
  if (Array.isArray(sanitized.sourceFiles)) {
    sanitized.sourceFiles = sanitized.sourceFiles.map(file => sanitizeSourceFileForClient(file, { expose }));
  }
  return sanitized;
}
