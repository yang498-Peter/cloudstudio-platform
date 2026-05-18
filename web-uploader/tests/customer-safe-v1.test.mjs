import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-customer-safe-v1-'));
process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN = '1';
process.env.CLOUDSTUDIO_DATA_DIR = runtimeRoot;

const serverModule = await import('../server.js');
const {
  appendDeleteAuditRecord,
  assertDatasetNameAvailable,
  createGaussianDirectManifest,
  getDatasetNameConflicts,
  getGaussianReadableStatus,
  getPotreeRuntimeHealth,
  moveRuntimePathToTrash,
} = serverModule;

test('dataset name conflicts return a customer-safe 409 error shape', () => {
  fs.mkdirSync(path.join(runtimeRoot, 'pointclouds', 'site-a'), { recursive: true });

  assert.deepEqual(getDatasetNameConflicts('site-a', { includeLocalImports: false }), ['pointcloud']);
  assert.throws(
    () => assertDatasetNameAvailable('site-a', { includeLocalImports: false }),
    error => {
      assert.equal(error.code, 'DATASET_NAME_CONFLICT');
      assert.equal(error.datasetName, 'site-a');
      assert.equal(error.suggestedName, 'site-a-2');
      assert.deepEqual(error.conflicts, ['pointcloud']);
      return true;
    },
  );
});

test('delete helper moves runtime data to trash and writes JSONL audit', () => {
  const sourceDir = path.join(runtimeRoot, 'pointclouds', 'delete-me');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'metadata.json'), '{"points":1}', 'utf8');

  const moved = moveRuntimePathToTrash(sourceDir, {
    auditId: 'del_test',
    category: 'pointclouds',
    displayPath: 'pointclouds/delete-me/',
    trashRoot: path.join(runtimeRoot, 'trash'),
  });

  assert.equal(fs.existsSync(sourceDir), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'trash', 'del_test', 'pointclouds', 'delete-me', 'metadata.json')), true);
  assert.equal(moved.from, 'pointclouds/delete-me/');

  const auditLog = path.join(runtimeRoot, 'cache', 'audit-test.jsonl');
  appendDeleteAuditRecord({
    auditId: 'del_test',
    action: 'soft-delete-cloud',
    moved: [moved],
    errors: [],
  }, auditLog);
  const line = fs.readFileSync(auditLog, 'utf8').trim();
  assert.equal(JSON.parse(line).auditId, 'del_test');
});

test('Potree runtime health reports missing build assets explicitly', () => {
  const potreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-potree-runtime-'));
  const missing = getPotreeRuntimeHealth(potreeRoot);
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.missing.sort(), [
    'build/potree/potree.css',
    'build/potree/potree.js',
    'build/potree/workers/BinaryDecoderWorker.js',
    'build/potree/workers/LASLAZWorker.js',
    'build/potree/workers/laz-perf.wasm',
  ]);

  fs.mkdirSync(path.join(potreeRoot, 'build', 'potree'), { recursive: true });
  fs.mkdirSync(path.join(potreeRoot, 'build', 'potree', 'workers'), { recursive: true });
  fs.writeFileSync(path.join(potreeRoot, 'build', 'potree', 'potree.js'), '', 'utf8');
  fs.writeFileSync(path.join(potreeRoot, 'build', 'potree', 'potree.css'), '', 'utf8');
  fs.writeFileSync(path.join(potreeRoot, 'build', 'potree', 'workers', 'BinaryDecoderWorker.js'), '', 'utf8');
  fs.writeFileSync(path.join(potreeRoot, 'build', 'potree', 'workers', 'LASLAZWorker.js'), '', 'utf8');
  fs.writeFileSync(path.join(potreeRoot, 'build', 'potree', 'workers', 'laz-perf.wasm'), '', 'utf8');
  const ready = getPotreeRuntimeHealth(potreeRoot);
  assert.equal(ready.ok, true);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.missing, []);
});

test('PLY 3DGS status is readable without claiming optimization is complete', () => {
  const manifest = createGaussianDirectManifest('scene', {
    originalName: 'scene.ply',
    targetName: 'scene.ply',
    sourceBytes: 10,
    uploadedAt: '2026-05-18T00:00:00.000Z',
  });

  assert.equal(manifest.publish.optimizationStatus, 'pending');
  assert.equal(
    getGaussianReadableStatus(manifest),
    '3DGS upload is browseable now. Optimization is still running.',
  );
});
