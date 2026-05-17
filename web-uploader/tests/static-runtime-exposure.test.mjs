import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getStaticRequestPathInfo,
  isSafePublicStaticRequest,
} from '../lib/runtime-storage.js';

function req(url) {
  return { url };
}

test('static request parser normalizes decoded request paths', () => {
  const info = getStaticRequestPathInfo(req('/scan%20data/metadata.json?cache=1'));

  assert.equal(info.decodedPath, '/scan data/metadata.json');
  assert.equal(info.basename, 'metadata.json');
  assert.equal(info.ext, '.json');
  assert.deepEqual(info.segments, ['scan data', 'metadata.json']);
});

test('public static guard allows required point cloud and scanner assets', () => {
  assert.equal(isSafePublicStaticRequest(req('/metadata.json')), true);
  assert.equal(isSafePublicStaticRequest(req('/octree.bin')), true);
  assert.equal(isSafePublicStaticRequest(req('/geo_info.csv')), true);
  assert.equal(isSafePublicStaticRequest(req('/ImgPose.txt')), true);
  assert.equal(isSafePublicStaticRequest(req('/undistort/left/frame_001.jpg')), true);
  assert.equal(isSafePublicStaticRequest(req('/scene.sog')), true);
  assert.equal(isSafePublicStaticRequest(req('/scene.ply')), true);
  assert.equal(isSafePublicStaticRequest(req('/volume_report.pdf')), true);
});

test('public static guard blocks private manifests and config-like files', () => {
  assert.equal(isSafePublicStaticRequest(req('/source.json')), false);
  assert.equal(isSafePublicStaticRequest(req('/scan_roots.json')), false);
  assert.equal(isSafePublicStaticRequest(req('/request_payload.json')), false);
  assert.equal(isSafePublicStaticRequest(req('/log.txt')), false);
  assert.equal(isSafePublicStaticRequest(req('/.env')), false);
  assert.equal(isSafePublicStaticRequest(req('/cert/server.key')), false);
  assert.equal(isSafePublicStaticRequest(req('/metadata.json.bak')), false);
});

test('public static guard blocks traversal, dotfiles, nul bytes, and directory index requests', () => {
  assert.equal(isSafePublicStaticRequest(req('/../source.json')), false);
  assert.equal(isSafePublicStaticRequest(req('/%2e%2e/source.json')), false);
  assert.equal(isSafePublicStaticRequest(req('/.cache/cache1/odom.csv')), false);
  assert.equal(isSafePublicStaticRequest(req('/safe%00name.bin')), false);
  assert.equal(isSafePublicStaticRequest(req('/')), false);
});
