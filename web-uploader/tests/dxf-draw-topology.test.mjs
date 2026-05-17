import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAW_SNAP_THRESHOLD_PX,
  EDIT_SNAP_THRESHOLD_PX,
  ENDPOINT_LINK_EPSILON,
  computeLineEndpoints,
  positionsCoincide,
  dedupeLinkEntries,
  clusterLinkEntries,
} from '../assets/app/features/dxf-draw/topology.js';

test('uses separate snap thresholds for drawing and editing', () => {
  assert.equal(DRAW_SNAP_THRESHOLD_PX, 14);
  assert.equal(EDIT_SNAP_THRESHOLD_PX, 14);
});

test('computes horizontal constrained endpoints using dragged point height', () => {
  const result = computeLineEndpoints(
    'horizontal',
    { x: 1, y: 2, z: 10 },
    { x: 5, y: 6, z: 14 },
    1
  );

  assert.deepEqual(result, {
    p1: { x: 1, y: 2, z: 14 },
    p2: { x: 5, y: 6, z: 14 },
  });
});

test('computes vertical constrained endpoints using dragged point XY', () => {
  const result = computeLineEndpoints(
    'vertical',
    { x: 1, y: 2, z: 10 },
    { x: 5, y: 6, z: 14 },
    1
  );

  assert.deepEqual(result, {
    p1: { x: 5, y: 6, z: 10 },
    p2: { x: 5, y: 6, z: 14 },
  });
});

test('treats nearly identical positions as connected', () => {
  assert.equal(
    positionsCoincide(
      { x: 0, y: 0, z: 0 },
      { x: ENDPOINT_LINK_EPSILON / 2, y: 0, z: 0 }
    ),
    true
  );

  assert.equal(
    positionsCoincide(
      { x: 0, y: 0, z: 0 },
      { x: ENDPOINT_LINK_EPSILON * 2, y: 0, z: 0 }
    ),
    false
  );
});

test('dedupes repeated link entries by sphere uuid', () => {
  const sphere = { uuid: 'shared' };
  const entries = dedupeLinkEntries([
    { sphere, measure: { id: 'a' }, index: 0 },
    { sphere, measure: { id: 'b' }, index: 1 },
  ]);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].measure.id, 'a');
});

test('splits stale link groups after constrained endpoints move apart', () => {
  const positions = new Map([
    ['a0', { x: 0, y: 0, z: 0 }],
    ['b1', { x: 0, y: 0, z: 0 }],
    ['c0', { x: 5, y: 0, z: 0 }],
  ]);
  const entries = [
    { sphere: { uuid: 'a0' }, measure: { id: 'a' }, index: 0 },
    { sphere: { uuid: 'b1' }, measure: { id: 'b' }, index: 1 },
    { sphere: { uuid: 'c0' }, measure: { id: 'c' }, index: 0 },
  ];

  let clusters = clusterLinkEntries(entries, entry => positions.get(entry.sphere.uuid));
  assert.deepEqual(clusters.map(cluster => cluster.map(entry => entry.sphere.uuid).sort()), [
    ['a0', 'b1'],
    ['c0'],
  ]);

  positions.set('b1', { x: 10, y: 0, z: 0 });
  clusters = clusterLinkEntries(entries, entry => positions.get(entry.sphere.uuid));
  assert.deepEqual(clusters.map(cluster => cluster.map(entry => entry.sphere.uuid).sort()), [
    ['a0'],
    ['b1'],
    ['c0'],
  ]);
});

test('breaks a shared horizontal endpoint after dragging the other endpoint to a new height', () => {
  const horizontal = computeLineEndpoints(
    'horizontal',
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 3 },
    1
  );
  const otherLine = computeLineEndpoints(
    'free',
    { x: 0, y: 0, z: 0 },
    { x: -2, y: 0, z: 0 },
    -1
  );

  const entries = [
    { sphere: { uuid: 'horizontal-start' }, measure: { id: 'horizontal' }, index: 0 },
    { sphere: { uuid: 'other-start' }, measure: { id: 'other' }, index: 0 },
  ];
  const positions = new Map([
    ['horizontal-start', horizontal.p1],
    ['other-start', otherLine.p1],
  ]);

  const clusters = clusterLinkEntries(entries, entry => positions.get(entry.sphere.uuid));
  assert.deepEqual(clusters.map(cluster => cluster.map(entry => entry.sphere.uuid).sort()), [
    ['horizontal-start'],
    ['other-start'],
  ]);
});

test('keeps a shared endpoint linked when dragging the shared point itself', () => {
  const horizontal = computeLineEndpoints(
    'horizontal',
    { x: 0, y: 0, z: 5 },
    { x: 4, y: 0, z: 2 },
    0
  );
  const otherLine = computeLineEndpoints(
    'free',
    { x: 0, y: 0, z: 5 },
    { x: -2, y: 0, z: 5 },
    -1
  );

  const entries = [
    { sphere: { uuid: 'horizontal-start' }, measure: { id: 'horizontal' }, index: 0 },
    { sphere: { uuid: 'other-start' }, measure: { id: 'other' }, index: 0 },
  ];
  const positions = new Map([
    ['horizontal-start', horizontal.p1],
    ['other-start', otherLine.p1],
  ]);

  const clusters = clusterLinkEntries(entries, entry => positions.get(entry.sphere.uuid));
  assert.deepEqual(clusters.map(cluster => cluster.map(entry => entry.sphere.uuid).sort()), [
    ['horizontal-start', 'other-start'],
  ]);
});
