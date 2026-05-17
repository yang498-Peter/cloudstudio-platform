import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeVolumeHoleFillMode,
  normalizeSurfaceBuildHoleMode,
  resolveVolumeSurfaceProfile,
  computeNetVolume,
  createVolumeCellAccumulator,
  addVolumeCellSample,
  getVolumeCellSurfaceElevation,
  resolveVolumeRegionPointCloud,
  resolveVolumeRegionAttachObject,
} from '../assets/app/features/volume/compute.js';

test('normalizes volume hole-fill modes for sampling compute', () => {
  assert.equal(normalizeVolumeHoleFillMode('leave'), 'ignore');
  assert.equal(normalizeVolumeHoleFillMode('ignore'), 'ignore');
  assert.equal(normalizeVolumeHoleFillMode('reference'), 'reference');
  assert.equal(normalizeVolumeHoleFillMode('fixed'), 'reference');
  assert.equal(normalizeVolumeHoleFillMode('interpolate'), 'interpolate');
});

test('normalizes surface build hole-fill modes for server mesh jobs', () => {
  assert.equal(normalizeSurfaceBuildHoleMode('leave'), 'leave');
  assert.equal(normalizeSurfaceBuildHoleMode('ignore'), 'leave');
  assert.equal(normalizeSurfaceBuildHoleMode('reference'), 'fixed');
  assert.equal(normalizeSurfaceBuildHoleMode('fixed'), 'fixed');
});

test('resolves canonical surface profiles from UI settings', () => {
  assert.deepEqual(resolveVolumeSurfaceProfile('stockpile', 'p85'), { profile: 'p85', usesGroundOnly: false });
  assert.deepEqual(resolveVolumeSurfaceProfile('dsm', 'p80'), { profile: 'max', usesGroundOnly: false });
  assert.deepEqual(resolveVolumeSurfaceProfile('dtm', 'median'), { profile: 'ground', usesGroundOnly: true });
});

test('computes net volume as fill minus cut', () => {
  assert.equal(computeNetVolume(12.5, 30.0), 17.5);
});

test('uses requested stockpile percentile for cell elevation', () => {
  const cell = createVolumeCellAccumulator({ profile: 'p80' });
  [1, 2, 3, 4, 5].forEach((z, index) => {
    addVolumeCellSample(cell, { x: index, y: 0, z });
  });
  assert.equal(Number(getVolumeCellSurfaceElevation(cell, { profile: 'p80' }).toFixed(3)), 4.2);
});

test('uses max aggregation for dsm cells', () => {
  const cell = createVolumeCellAccumulator({ profile: 'max' });
  [1, 5, 3].forEach((z, index) => {
    addVolumeCellSample(cell, { x: index, y: 0, z });
  });
  assert.equal(getVolumeCellSurfaceElevation(cell, { profile: 'max' }), 5);
});

test('uses ground-only quantile for dtm when class-2 samples exist', () => {
  const cell = createVolumeCellAccumulator({ profile: 'ground' });
  addVolumeCellSample(cell, { x: 0, y: 0, z: 10, isGround: false });
  addVolumeCellSample(cell, { x: 1, y: 0, z: 20, isGround: false });
  addVolumeCellSample(cell, { x: 2, y: 0, z: 1, isGround: true });
  addVolumeCellSample(cell, { x: 3, y: 0, z: 2, isGround: true });

  assert.equal(
    Number(getVolumeCellSurfaceElevation(cell, { profile: 'ground', useGroundSamples: true }).toFixed(3)),
    1.2
  );
});

test('falls back to all-point p20 when dtm has no class-2 samples', () => {
  const cell = createVolumeCellAccumulator({ profile: 'ground' });
  addVolumeCellSample(cell, { x: 0, y: 0, z: 10, isGround: false });
  addVolumeCellSample(cell, { x: 1, y: 0, z: 20, isGround: false });

  assert.equal(
    Number(getVolumeCellSurfaceElevation(cell, { profile: 'ground', useGroundSamples: false }).toFixed(3)),
    12
  );
});

test('resolves region-bound pointcloud instead of always taking the primary cloud', () => {
  const primary = { uuid: 'pc-a', name: 'A' };
  const target = { uuid: 'pc-b', name: 'B' };
  const region = { pointcloudUuid: 'pc-b' };

  assert.equal(resolveVolumeRegionPointCloud(region, [primary, target], primary), target);
});

test('resolves region attach object from region metadata before falling back', () => {
  const parent = { uuid: 'attach-parent' };
  const pointcloud = { uuid: 'pc-b', parent };
  const region = { attachParentUuid: 'attach-parent' };
  const found = resolveVolumeRegionAttachObject(region, {
    pointcloud,
    scenePointCloud: { uuid: 'scene-pointcloud' },
    scene: { uuid: 'scene-root' },
    findObjectByUuid: uuid => (uuid === 'attach-parent' ? parent : null),
  });

  assert.equal(found, parent);
});
