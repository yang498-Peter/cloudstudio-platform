import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { buildRuntimeStorageLayout } from '../lib/runtime-storage.js';

test('runtime storage defaults to the application directory', () => {
  const appDir = path.resolve('/tmp/cloudstudio/web-uploader');
  const layout = buildRuntimeStorageLayout({ appDir, env: {} });

  assert.equal(layout.storageRoot, appDir);
  assert.equal(layout.configuredStorageRoot, null);
  assert.equal(layout.configuredStorageEnv, null);
  assert.equal(layout.usesExternalStorage, false);
  assert.equal(layout.uploads.primary, path.join(appDir, 'uploads'));
});

test('CLOUDSTUDIO_DATA_DIR configures external runtime storage', () => {
  const appDir = path.resolve('/tmp/cloudstudio/web-uploader');
  const dataDir = path.resolve('/srv/cloudstudio-data');
  const layout = buildRuntimeStorageLayout({
    appDir,
    env: { CLOUDSTUDIO_DATA_DIR: dataDir },
  });

  assert.equal(layout.storageRoot, dataDir);
  assert.equal(layout.configuredStorageRoot, dataDir);
  assert.equal(layout.configuredStorageEnv, 'CLOUDSTUDIO_DATA_DIR');
  assert.equal(layout.usesExternalStorage, true);
  assert.equal(layout.projects.primary, path.join(dataDir, 'projects'));
  assert.deepEqual(layout.projects.candidates, [
    path.join(dataDir, 'projects'),
    path.join(appDir, 'projects'),
  ]);
});

test('legacy CLOUDSTUDIO_STORAGE_ROOT remains supported as a fallback', () => {
  const appDir = path.resolve('/tmp/cloudstudio/web-uploader');
  const storageRoot = path.resolve('/srv/cloudstudio-storage');
  const layout = buildRuntimeStorageLayout({
    appDir,
    env: { CLOUDSTUDIO_STORAGE_ROOT: storageRoot },
  });

  assert.equal(layout.storageRoot, storageRoot);
  assert.equal(layout.configuredStorageEnv, 'CLOUDSTUDIO_STORAGE_ROOT');
});

test('CLOUDSTUDIO_DATA_DIR takes precedence over legacy storage root', () => {
  const appDir = path.resolve('/tmp/cloudstudio/web-uploader');
  const dataDir = path.resolve('/srv/cloudstudio-data');
  const storageRoot = path.resolve('/srv/cloudstudio-storage');
  const layout = buildRuntimeStorageLayout({
    appDir,
    env: {
      CLOUDSTUDIO_DATA_DIR: dataDir,
      CLOUDSTUDIO_STORAGE_ROOT: storageRoot,
    },
  });

  assert.equal(layout.storageRoot, dataDir);
  assert.equal(layout.configuredStorageEnv, 'CLOUDSTUDIO_DATA_DIR');
});
