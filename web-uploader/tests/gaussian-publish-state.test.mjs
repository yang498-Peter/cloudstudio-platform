import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN = '1';

const serverModule = await import('../server.js');
const {
  buildGaussianCloudListEntry,
  buildGaussianEditorUrl,
  createGaussianDirectManifest,
  resolveGaussianViewerRotation,
} = serverModule;

function editorParams(url) {
  return new URL(url, 'http://cloudstudio.test').searchParams;
}

test('manifest viewerRotation overrides SuperSplat URL rotation params', () => {
  const manifest = {
    fileName: 'scene.splat',
    viewerRotation: { rx: 12, ry: -4, rz: 33 },
    publish: {
      viewerRotation: { rx: 90, ry: 0, rz: 180 },
      rotationBaked: false,
    },
  };

  const params = editorParams(buildGaussianEditorUrl('cramo_scene', manifest, manifest.publish));
  assert.equal(params.get('rx'), '12');
  assert.equal(params.get('ry'), '-4');
  assert.equal(params.get('rz'), '33');
});

test('SuperSplat URL carries requested CloudStudio locale', () => {
  const params = editorParams(buildGaussianEditorUrl(
    'cramo_scene',
    { fileName: 'scene.ply' },
    { directBrowseStatus: 'ready' },
    { locale: 'zh-CN' },
  ));

  assert.equal(params.get('lng'), 'zh-CN');
});

test('non-default publish viewerRotation is preserved when top-level rotation is the old default', () => {
  const rotation = resolveGaussianViewerRotation({
    viewerRotation: { rx: 90, ry: 0, rz: 180 },
    publish: { viewerRotation: { rx: 88, ry: 2, rz: 179 } },
  });

  assert.deepEqual(rotation, { rx: 88, ry: 2, rz: 179 });
});

test('non-PLY direct 3DGS manifests do not enter SOG pending state', () => {
  const manifest = createGaussianDirectManifest('ready_splat', {
    originalName: 'ready.splat',
    targetName: 'scene.splat',
    sourceBytes: 1234,
    uploadedAt: '2026-05-17T00:00:00.000Z',
  });
  const listEntry = buildGaussianCloudListEntry('ready_splat', manifest);

  assert.equal(manifest.publish.status, 'direct-ready');
  assert.equal(manifest.publish.directBrowseStatus, 'ready');
  assert.equal(manifest.publish.optimizationStatus, 'not-applicable');
  assert.equal(manifest.publish.optimizationEligible, false);
  assert.equal(listEntry.gaussianDirectBrowseStatus, 'ready');
  assert.equal(listEntry.gaussianOptimizationStatus, 'not-applicable');
  assert.equal(listEntry.gaussianOptimizationEligible, false);
});

test('PLY direct manifests expose direct browse ready and SOG optimization pending separately', () => {
  const manifest = createGaussianDirectManifest('pending_ply', {
    originalName: 'pending.ply',
    targetName: 'scene.ply',
    sourceBytes: 5678,
    uploadedAt: '2026-05-17T00:00:00.000Z',
  });
  const listEntry = buildGaussianCloudListEntry('pending_ply', manifest);

  assert.equal(manifest.publish.status, 'direct-ready');
  assert.equal(manifest.publish.directBrowseStatus, 'ready');
  assert.equal(manifest.publish.optimizationStatus, 'pending');
  assert.equal(manifest.publish.optimizationEligible, true);
  assert.deepEqual(manifest.viewerRotation, { rx: 90, ry: 0, rz: 180 });
  assert.deepEqual(manifest.publish.viewerRotation, { rx: 90, ry: 0, rz: 180 });
  assert.equal(listEntry.gaussianPublishStatus, 'direct-ready');
  assert.equal(listEntry.gaussianDirectBrowseStatus, 'ready');
  assert.equal(listEntry.gaussianOptimizationStatus, 'pending');
});
