import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  getDisabledFeatureForPath,
  resolveServerCapabilities,
} from '../lib/server-capabilities.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-capabilities-'));
process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN = '1';
process.env.CLOUDSTUDIO_DATA_DIR = runtimeRoot;
process.env.PYTHON_BIN = path.join(runtimeRoot, 'private-python', 'bin', 'python');

const { app, SERVER_CAPABILITIES } = await import('../server.js');

function listen() {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJobUntilTerminal(baseUrl, statusUrl, attempts = 20) {
  let lastResponse = null;
  for (let index = 0; index < attempts; index += 1) {
    const response = await fetch(`${baseUrl}${statusUrl}`);
    assert.equal(response.status, 200);
    lastResponse = await response.json();
    const status = String(lastResponse?.job?.status || '').toLowerCase();
    if (['completed', 'failed', 'cancelled'].includes(status)) return lastResponse;
    await delay(25);
  }
  return lastResponse;
}

test('server capabilities default to lightweight public-server features', () => {
  const capabilities = resolveServerCapabilities({});

  assert.equal(capabilities.mode, 'server');
  assert.equal(capabilities.features.viewerUiV2, true);
  assert.equal(capabilities.features.measurement, true);
  assert.equal(capabilities.features.clipBox, true);
  assert.equal(capabilities.features.deleteRegion, true);
  assert.equal(capabilities.features.profile, true);
  assert.equal(capabilities.features.capture, true);
  assert.equal(capabilities.features.crs, true);
  assert.equal(capabilities.features.export, true);
  assert.equal(capabilities.features.sceneTree, true);
  assert.equal(capabilities.features.scannerRuntime, true);
  assert.equal(capabilities.features.datasetManagement, false);
  assert.equal(capabilities.features.volumeJobs, false);
  assert.equal(capabilities.features.terrainProcessing, false);
  assert.equal(capabilities.features.desktopLocalImport, false);
  assert.equal(capabilities.features.mvpSolver, false);
  assert.equal(capabilities.features.forestry, false);
  assert.equal(capabilities.features.pointcloudRegistration, false);
  assert.equal(capabilities.features.orthoImage, false);
});

test('server capabilities can be enabled or disabled with explicit env flags', () => {
  const capabilities = resolveServerCapabilities({
    CLOUDSTUDIO_ENABLE_VOLUME_JOBS: '1',
    CLOUDSTUDIO_FEATURE_FORESTRY: 'true',
    CLOUDSTUDIO_DISABLE_EXPORT: 'yes',
  });

  assert.equal(capabilities.features.volumeJobs, true);
  assert.equal(capabilities.features.forestry, true);
  assert.equal(capabilities.features.export, false);
});

test('disabled feature routing maps heavy API paths to feature names', () => {
  const capabilities = resolveServerCapabilities({});

  assert.equal(getDisabledFeatureForPath('/api/delete-cloud', capabilities), 'datasetManagement');
  assert.equal(getDisabledFeatureForPath('/api/clouds/remove', capabilities), 'datasetManagement');
  assert.equal(getDisabledFeatureForPath('/api/scan-projects/remove', capabilities), 'datasetManagement');
  assert.equal(getDisabledFeatureForPath('/api/upload-by-path', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/grids/import-dialog', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/import/local/jobs', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/import/local/jobs/job-1/cancel', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/scan-roots', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/scan-projects/register', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/upload-project', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/upload-preconverted', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/export-pointcloud/jobs', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/crs/transform', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/volume-jobs', capabilities), 'volumeJobs');
  assert.equal(getDisabledFeatureForPath('/api/volume-jobs/job-1', capabilities), 'volumeJobs');
  assert.equal(getDisabledFeatureForPath('/api/generate-volume-surface', capabilities), 'volumeJobs');
  assert.equal(getDisabledFeatureForPath('/api/classify-ground', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/find-las', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/terrain-jobs/job-1', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/mesh-file', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/project-dir', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/forestry/prepare', capabilities), 'forestry');
  assert.equal(getDisabledFeatureForPath('/api/clouds', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/upload-gaussian', capabilities), null);

  const exportDisabled = resolveServerCapabilities({ CLOUDSTUDIO_DISABLE_EXPORT: '1' });
  assert.equal(getDisabledFeatureForPath('/api/export-pointcloud', exportDisabled), 'export');
  assert.equal(getDisabledFeatureForPath('/api/export-pointcloud/jobs', exportDisabled), 'export');
  assert.equal(getDisabledFeatureForPath('/api/export-sources?cloudName=x', exportDisabled), 'export');

  const crsDisabled = resolveServerCapabilities({ CLOUDSTUDIO_DISABLE_CRS: '1' });
  assert.equal(getDisabledFeatureForPath('/api/crs/transform', crsDisabled), 'crs');
  assert.equal(getDisabledFeatureForPath('/api/grids/import', crsDisabled), 'crs');
  assert.equal(getDisabledFeatureForPath('/api/scan-projects/crs', crsDisabled), 'crs');
});

test('/api/capabilities reports the resolved server capability matrix', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.capabilities, SERVER_CAPABILITIES);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('disabled heavy and desktop-local API routes return FEATURE_DISABLED before reaching handlers', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/volume-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.errorCode, 'FEATURE_DISABLED');
    assert.equal(body.feature, 'volumeJobs');

    const terrainJobResponse = await fetch(`${baseUrl}/api/terrain-jobs/job-1`);
    assert.equal(terrainJobResponse.status, 403);
    const terrainJobBody = await terrainJobResponse.json();
    assert.equal(terrainJobBody.ok, false);
    assert.equal(terrainJobBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(terrainJobBody.feature, 'terrainProcessing');

    const scanRootsResponse = await fetch(`${baseUrl}/api/scan-roots`);
    assert.equal(scanRootsResponse.status, 403);
    const scanRootsBody = await scanRootsResponse.json();
    assert.equal(scanRootsBody.ok, false);
    assert.equal(scanRootsBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(scanRootsBody.feature, 'desktopLocalImport');

    const deleteResponse = await fetch(`${baseUrl}/api/delete-cloud`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudName: 'anything', password: 'anything' }),
    });
    assert.equal(deleteResponse.status, 403);
    const deleteBody = await deleteResponse.json();
    assert.equal(deleteBody.ok, false);
    assert.equal(deleteBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(deleteBody.feature, 'datasetManagement');

    const removeCloudResponse = await fetch(`${baseUrl}/api/clouds/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudName: 'anything' }),
    });
    assert.equal(removeCloudResponse.status, 403);
    const removeCloudBody = await removeCloudResponse.json();
    assert.equal(removeCloudBody.ok, false);
    assert.equal(removeCloudBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(removeCloudBody.feature, 'datasetManagement');

    const removeProjectResponse = await fetch(`${baseUrl}/api/scan-projects/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'anything' }),
    });
    assert.equal(removeProjectResponse.status, 403);
    const removeProjectBody = await removeProjectResponse.json();
    assert.equal(removeProjectBody.ok, false);
    assert.equal(removeProjectBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(removeProjectBody.feature, 'datasetManagement');

    const registerResponse = await fetch(`${baseUrl}/api/scan-projects/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dirPath: runtimeRoot }),
    });
    assert.equal(registerResponse.status, 403);
    const registerBody = await registerResponse.json();
    assert.equal(registerBody.ok, false);
    assert.equal(registerBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(registerBody.feature, 'desktopLocalImport');

    const gridDialogResponse = await fetch(`${baseUrl}/api/grids/import-dialog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(gridDialogResponse.status, 403);
    const gridDialogBody = await gridDialogResponse.json();
    assert.equal(gridDialogBody.ok, false);
    assert.equal(gridDialogBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(gridDialogBody.feature, 'desktopLocalImport');

    const localImportResponse = await fetch(`${baseUrl}/api/import/local/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryPath: path.join(runtimeRoot, 'private', 'scan.las') }),
    });
    assert.equal(localImportResponse.status, 403);
    const localImportBody = await localImportResponse.json();
    assert.equal(localImportBody.ok, false);
    assert.equal(localImportBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(localImportBody.feature, 'desktopLocalImport');

    const cancelResponse = await fetch(`${baseUrl}/api/import/local/jobs/job-1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelResponse.status, 403);
    const cancelBody = await cancelResponse.json();
    assert.equal(cancelBody.ok, false);
    assert.equal(cancelBody.errorCode, 'FEATURE_DISABLED');
    assert.equal(cancelBody.feature, 'desktopLocalImport');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('static artifacts for disabled heavy features are blocked', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/volume-jobs/example/preview.png`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.errorCode, 'FEATURE_DISABLED');
    assert.equal(body.feature, 'volumeJobs');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('scanner static serving blocks disabled heavy feature subdirectories', async () => {
  const projectId = 'scan-heavy-feature-output';
  const projectDir = path.join(runtimeRoot, 'projects', projectId);
  fs.mkdirSync(path.join(projectDir, 'forestry'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'scan.las'), 'fake-las');
  fs.writeFileSync(path.join(projectDir, 'forestry', 'result.json'), JSON.stringify({ ok: true }));

  const { server, baseUrl } = await listen();
  try {
    const projectsResponse = await fetch(`${baseUrl}/api/scan-projects`);
    assert.equal(projectsResponse.status, 200);

    const response = await fetch(`${baseUrl}/scan-data/${encodeURIComponent(projectId)}/forestry/result.json`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.errorCode, 'FEATURE_DISABLED');
    assert.equal(body.feature, 'forestry');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('CRS project writes require upload credentials', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/scan-projects/crs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'anything', config: {} }),
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.errorCode, 'UPLOAD_PASSWORD_REQUIRED');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Open modal data endpoint returns server-safe list payloads', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/open-modal/data?mode=quick`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.desktopDialogs, false);
    assert.ok(Array.isArray(body.projects));
    assert.ok(Array.isArray(body.clouds));
    assert.deepEqual(body.capabilities, SERVER_CAPABILITIES);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('export job endpoint is wired to the generic job status route', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/export-pointcloud/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cloudName: 'missing-cloud' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.type, 'export-pointcloud');
    assert.match(body.statusUrl, /^\/api\/jobs\//);

    const statusBody = await fetchJobUntilTerminal(baseUrl, body.statusUrl);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.job.type, 'export-pointcloud');
    const serializedJob = JSON.stringify(statusBody.job);
    assert.doesNotMatch(serializedJob, /"stack"/i);
    assert.doesNotMatch(serializedJob, /\/(?:Users|tmp|var|Volumes|home|root|workspace)\//);
    assert.doesNotMatch(serializedJob, /[A-Za-z]:[\\/]/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('/api/export-sources redacts local source paths by default', async () => {
  const cloudName = 'capabilities-leak-check';
  const pointcloudDir = path.join(runtimeRoot, 'pointclouds', cloudName);
  const uploadsDir = path.join(runtimeRoot, 'uploads');
  fs.mkdirSync(pointcloudDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(pointcloudDir, 'metadata.json'), JSON.stringify({ points: 1 }));
  fs.writeFileSync(path.join(uploadsDir, 'source.las'), 'fake-las');
  fs.writeFileSync(path.join(pointcloudDir, 'source.json'), JSON.stringify({
    type: 'upload',
    uploadFilename: 'source.las',
    originalName: 'source.las',
  }));

  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/export-sources?cloudName=${encodeURIComponent(cloudName)}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.sources));
    assert.equal(body.sources.length, 1);
    assert.equal(Object.hasOwn(body.sources[0], 'absPath'), false);
    assert.equal(Object.hasOwn(body.sources[0], 'path'), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('default-enabled API error responses redact absolute server paths', async () => {
  const { server, baseUrl } = await listen();
  try {
    const response = await fetch(`${baseUrl}/api/crs/transform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pointsWgs84: [[0, 0, 0]] }),
    });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.errorCode, 'EXPORT_ENV_MISSING');
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/);
    assert.doesNotMatch(serialized, /\/(?:Users|home|mnt|Volumes|tmp|var|opt|workspace|root|srv)\b/);
    assert.match(serialized, /<server-path:python>/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
