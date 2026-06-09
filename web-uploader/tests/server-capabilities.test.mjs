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
  assert.equal(capabilities.features.crs, true);
  assert.equal(capabilities.features.export, true);
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

  assert.equal(getDisabledFeatureForPath('/api/upload-by-path', capabilities), 'desktopLocalImport');
  assert.equal(getDisabledFeatureForPath('/api/export-pointcloud/jobs', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/crs/transform', capabilities), null);
  assert.equal(getDisabledFeatureForPath('/api/volume-jobs', capabilities), 'volumeJobs');
  assert.equal(getDisabledFeatureForPath('/api/generate-volume-surface', capabilities), 'volumeJobs');
  assert.equal(getDisabledFeatureForPath('/api/classify-ground', capabilities), 'terrainProcessing');
  assert.equal(getDisabledFeatureForPath('/api/find-las', capabilities), 'terrainProcessing');
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

test('disabled heavy API routes return FEATURE_DISABLED before reaching handlers', async () => {
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
