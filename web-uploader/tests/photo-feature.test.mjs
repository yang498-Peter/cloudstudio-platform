import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createPhotoFeature } from '../assets/app/features/photo/index.js';

const viewerHtmlPath = new URL('../viewer.html', import.meta.url);

function createClassList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach(item => values.add(item)),
    remove: (...items) => items.forEach(item => values.delete(item)),
    contains: item => values.has(item),
  };
}

function createElement(id) {
  return {
    id,
    src: '',
    textContent: '',
    style: {},
    dataset: {},
    classList: createClassList(),
    addEventListener() {},
  };
}

function installPhotoDom() {
  const elements = new Map([
    'modal-photo',
    'photo-img',
    'photo-label',
    'photo-info',
  ].map(id => [id, createElement(id)]));

  globalThis.document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
  };
  return elements;
}

test('showPhoto renders the selected image onto the active camera photo plane', () => {
  const elements = installPhotoDom();
  const disposedTextures = [];
  let renderRequests = 0;

  const THREE = {
    TextureLoader: class TextureLoader {
      load(url, onLoad) {
        const texture = {
          url,
          dispose() {
            disposedTextures.push(url);
          },
        };
        onLoad?.();
        return texture;
      }
    },
  };

  const plane = {
    visible: false,
    material: {
      map: null,
      needsUpdate: false,
    },
    userData: {},
  };
  const leftCamera = {
    x: 1,
    y: 2,
    z: 3,
    yaw: 4,
    pitch: 5,
    timestamp: '100',
    side: 'left',
    photoPlane: plane,
  };
  const rightCamera = {
    x: 1,
    y: 2,
    z: 3,
    yaw: 4,
    pitch: 5,
    timestamp: '100',
    side: 'right',
  };
  const state = { photoIndex: 0, photoSide: 'left' };

  const feature = createPhotoFeature({
    viewer: {
      setRepRender() {
        renderRequests += 1;
      },
    },
    THREE,
    getScannerState: () => state,
    getBasePath: () => '/scan',
    getPhotoFrameAtIndex: (_index, side) => ({
      index: 0,
      total: 1,
      side,
      camera: side === 'right' ? rightCamera : leftCamera,
      leftCamera,
      filename: side === 'right' ? 'right.jpg' : 'left.jpg',
    }),
    translate: (_key, _params, fallback) => fallback,
  });

  feature.showPhoto(0, 'right');

  assert.equal(elements.get('photo-img').src, '/scan/undistort/right/right.jpg');
  assert.equal(elements.get('photo-label').textContent, '1 / 1');
  assert.equal(elements.get('modal-photo').classList.contains('open'), true);
  assert.equal(plane.visible, true);
  assert.equal(plane.material.map.url, '/scan/undistort/right/right.jpg');
  assert.equal(plane.material.needsUpdate, true);
  assert.equal(plane.userData.photoSide, 'right');
  assert.equal(plane.userData.photoIndex, 0);
  assert.equal(renderRequests > 0, true);

  feature.showPhoto(0, 'left');

  assert.deepEqual(disposedTextures, ['/scan/undistort/right/right.jpg']);
  assert.equal(plane.visible, true);
  assert.equal(plane.material.map.url, '/scan/undistort/left/left.jpg');
  assert.equal(plane.userData.photoSide, 'left');

  feature.closeModal();

  assert.equal(elements.get('modal-photo').classList.contains('open'), false);
  assert.equal(plane.visible, false);
});

test('viewer keeps scanner camera marker hooks wired', () => {
  const html = fs.readFileSync(viewerHtmlPath, 'utf8');

  assert.match(html, /id="chk-cameras"/);
  assert.match(html, /id="r-cam-size"/);
  assert.match(html, /id="chk-frustum"/);
  assert.match(html, /function buildCameraMarkers\(/);
  assert.match(html, /function buildCameraPhotoPlane\(/);
  assert.match(html, /camera\.photoPlane = photoPlane/);
  assert.match(html, /if \(projectState\.cameras\.length\) buildCameraMarkers\(projectId\)/);
});
