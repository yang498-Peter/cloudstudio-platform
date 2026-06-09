import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SERVER_CAPABILITIES, isCapabilityEnabled } from '../assets/app/services/capabilities.js';
import { toolbarGroups } from '../assets/app/ui/toolbar-groups.js';

function visibleActions(capabilities = DEFAULT_SERVER_CAPABILITIES) {
  return toolbarGroups
    .flatMap(group => group.items || [])
    .filter(item => {
      return !item.capability || isCapabilityEnabled(capabilities, item.capability);
    })
    .map(item => item.action);
}

test('server default toolbar keeps lightweight viewer tools and hides heavy workflows', () => {
  const actions = new Set(visibleActions());

  assert.equal(actions.has('open'), true);
  assert.equal(actions.has('export'), true);
  assert.equal(actions.has('coordinate-convert'), true);
  assert.equal(actions.has('screenshot'), true);
  assert.equal(actions.has('measure-distance'), true);
  assert.equal(actions.has('clip-box'), true);
  assert.equal(actions.has('delete-region'), true);
  assert.equal(actions.has('profile'), true);

  assert.equal(actions.has('ortho-image'), false);
  assert.equal(actions.has('mvp-s1'), false);
  assert.equal(actions.has('volume'), false);
  assert.equal(actions.has('terrain-gc'), false);
  assert.equal(actions.has('terrain-dtm'), false);
  assert.equal(actions.has('terrain-contour'), false);
});

test('toolbar hides capture-family actions when capture is disabled', () => {
  const actions = new Set(visibleActions({
    ...DEFAULT_SERVER_CAPABILITIES,
    features: {
      ...DEFAULT_SERVER_CAPABILITIES.features,
      capture: false,
    },
  }));

  assert.equal(actions.has('screenshot'), false);
  assert.equal(actions.has('capture'), false);
  assert.equal(actions.has('open'), true);
});
