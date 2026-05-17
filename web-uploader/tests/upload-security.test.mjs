import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN = '1';
process.env.UPLOAD_REVIEW_PASSWORD_SHA256 = createHash('sha256').update('test-secret').digest('hex');

const serverModule = await import('../server.js');
const {
  GAUSSIAN_UPLOAD_EXTENSIONS,
  UPLOAD_LIMITS,
  buildPreconvertedZipExtractScript,
  buildScannerProjectZipExtractScript,
  createUploadFileFilter,
  getUploadPasswordCandidate,
  verifyPreMulterUploadCredential,
  verifyUploadCredentialFromRequest,
} = serverModule;

const PYTHON = process.env.PYTHON3_BIN || 'python3';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-upload-security-'));
}

function createZip(zipPath, entries) {
  const payload = JSON.stringify(entries);
  const result = spawnSync(PYTHON, ['-c', `
import json, sys, zipfile
zip_path = sys.argv[1]
entries = json.loads(sys.argv[2])
with zipfile.ZipFile(zip_path, 'w') as zf:
    for entry in entries:
        name = entry['name']
        data = entry.get('data', '')
        external_attr = entry.get('external_attr')
        if external_attr is None:
            zf.writestr(name, data)
        else:
            info = zipfile.ZipInfo(name)
            info.external_attr = external_attr
            zf.writestr(info, data)
`, zipPath, payload], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function runExtractScript(script, zipPath, destRoot, nameOverride = '') {
  const result = spawnSync(PYTHON, ['-c', script, zipPath, destRoot, nameOverride], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'cloudstudio-pycache') },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('scanner project ZIP rejects Zip Slip entries before extraction', () => {
  const root = makeTempDir();
  const zipPath = path.join(root, 'scanner.zip');
  createZip(zipPath, [
    { name: 'scan/odom.csv', data: 't,x,y,z\n' },
    { name: '../evil.txt', data: 'owned' },
  ]);

  const result = runExtractScript(buildScannerProjectZipExtractScript(), zipPath, path.join(root, 'projects'));
  assert.equal(result.errorCode, 'UNSAFE_ZIP_ENTRY');
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
});

test('scanner project ZIP safely extracts normal rooted archives', () => {
  const root = makeTempDir();
  const zipPath = path.join(root, 'scanner.zip');
  const projectsDir = path.join(root, 'projects');
  createZip(zipPath, [
    { name: 'scan/odom.csv', data: 't,x,y,z\n' },
    { name: 'scan/colorized.las', data: 'las bytes' },
  ]);

  const result = runExtractScript(buildScannerProjectZipExtractScript(), zipPath, projectsDir);
  assert.equal(result.projectName, 'scan');
  assert.equal(result.bestLas, 'colorized.las');
  assert.equal(fs.readFileSync(path.join(projectsDir, 'scan', 'odom.csv'), 'utf8'), 't,x,y,z\n');
});

test('preconverted Potree ZIP rejects path traversal even when metadata exists', () => {
  const root = makeTempDir();
  const zipPath = path.join(root, 'cloud.zip');
  createZip(zipPath, [
    { name: 'cloud/metadata.json', data: '{"points":42}' },
    { name: 'cloud/../../evil.txt', data: 'owned' },
  ]);

  const result = runExtractScript(buildPreconvertedZipExtractScript(), zipPath, path.join(root, 'pointclouds'));
  assert.equal(result.errorCode, 'UNSAFE_ZIP_ENTRY');
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
});

test('preconverted Potree ZIP safely extracts normal archives', () => {
  const root = makeTempDir();
  const zipPath = path.join(root, 'cloud.zip');
  const pointcloudsDir = path.join(root, 'pointclouds');
  createZip(zipPath, [
    { name: 'cloud/metadata.json', data: '{"points":42}' },
    { name: 'cloud/octree.bin', data: 'octree' },
  ]);

  const result = runExtractScript(buildPreconvertedZipExtractScript(), zipPath, pointcloudsDir);
  assert.equal(result.cloudName, 'cloud');
  assert.equal(result.points, 42);
  assert.equal(fs.readFileSync(path.join(pointcloudsDir, 'cloud', 'metadata.json'), 'utf8'), '{"points":42}');
});

test('ZIP extraction rejects special-file entries when external attributes expose file type', () => {
  const root = makeTempDir();
  const zipPath = path.join(root, 'special.zip');
  const fifoExternalAttr = 0o010777 << 16;
  createZip(zipPath, [
    { name: 'cloud/metadata.json', data: '{"points":1}' },
    { name: 'cloud/pipe', data: 'target', external_attr: fifoExternalAttr },
  ]);

  const result = runExtractScript(buildPreconvertedZipExtractScript(), zipPath, path.join(root, 'pointclouds'));
  assert.equal(result.errorCode, 'UNSAFE_ZIP_ENTRY');
});

test('upload credential helpers prefer pre-multer header/query credentials', () => {
  const headerReq = {
    headers: { 'x-cloudstudio-upload-password': 'test-secret' },
    query: { uploadPassword: 'wrong' },
    body: { uploadPassword: 'wrong' },
  };
  assert.deepEqual(getUploadPasswordCandidate(headerReq), { source: 'header', value: 'test-secret' });
  assert.deepEqual(verifyUploadCredentialFromRequest(headerReq), { source: 'header', value: 'test-secret' });

  const queryReq = { headers: {}, query: { uploadPassword: 'test-secret' }, body: {} };
  assert.deepEqual(getUploadPasswordCandidate(queryReq, { includeBody: false }), { source: 'query', value: 'test-secret' });
});

test('pre-multer credential check rejects missing header/query credentials', () => {
  assert.throws(
    () => verifyPreMulterUploadCredential({
      headers: {},
      query: {},
      body: { uploadPassword: 'test-secret' },
    }),
    { code: 'UPLOAD_PASSWORD_REQUIRED' },
  );
});

test('pre-multer credential check accepts correct header credentials', () => {
  assert.deepEqual(
    verifyPreMulterUploadCredential({
      headers: { 'x-cloudstudio-upload-password': 'test-secret' },
      query: {},
      body: {},
    }),
    { source: 'header', value: 'test-secret' },
  );
});

test('multer upload helpers enforce explicit limits and extension filters', () => {
  assert.equal(UPLOAD_LIMITS.files, 1);
  assert.equal(UPLOAD_LIMITS.fields > 0, true);
  assert.equal(UPLOAD_LIMITS.parts >= UPLOAD_LIMITS.files + UPLOAD_LIMITS.fields, true);
  assert.equal(UPLOAD_LIMITS.fileSize > 0, true);

  const filter = createUploadFileFilter({ pointcloud: new Set(['.las', '.laz']) });
  filter({}, { fieldname: 'pointcloud', originalname: 'scan.las' }, (error, accepted) => {
    assert.equal(error, null);
    assert.equal(accepted, true);
  });
  filter({}, { fieldname: 'pointcloud', originalname: 'scan.exe' }, (error) => {
    assert.equal(error.code, 'INVALID_UPLOAD_FILE_TYPE');
  });
});

test('gaussian upload file filter allows supported 3DGS formats only', () => {
  const filter = createUploadFileFilter({ gaussianFile: GAUSSIAN_UPLOAD_EXTENSIONS });
  for (const originalname of ['scene.ply', 'scene.splat', 'scene.ksplat']) {
    filter({}, { fieldname: 'gaussianFile', originalname }, (error, accepted) => {
      assert.equal(error, null);
      assert.equal(accepted, true);
    });
  }
  filter({}, { fieldname: 'gaussianFile', originalname: 'scene.exe' }, (error) => {
    assert.equal(error.code, 'INVALID_UPLOAD_FILE_TYPE');
  });
});
