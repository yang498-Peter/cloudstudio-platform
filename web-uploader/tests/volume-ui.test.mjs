import test from 'node:test';
import assert from 'node:assert/strict';

import { applyScenarioDefaultsToRegion } from '../assets/app/features/volume/index.js';

test('ground-fitted preset syncs base mode, point filter, and surface type', () => {
  const region = {
    scenarioMode: 'stockpile_boundary',
    baseSurfaceMode: 'boundary',
    pointFilterMode: 'all',
    surfaceType: 'dsm',
  };

  applyScenarioDefaultsToRegion(region, 'ground_fit_volume');

  assert.equal(region.scenarioMode, 'ground_fit_volume');
  assert.equal(region.baseSurfaceMode, 'ground');
  assert.equal(region.pointFilterMode, 'exclude_vegetation');
  assert.equal(region.surfaceType, 'stockpile');
});

test('plane cut/fill preset keeps explicit point filter but defaults empty filter to all points', () => {
  const explicitRegion = {
    scenarioMode: 'stockpile_boundary',
    baseSurfaceMode: 'boundary',
    pointFilterMode: 'exclude_vegetation',
    surfaceType: 'stockpile',
  };

  applyScenarioDefaultsToRegion(explicitRegion, 'plane_cut_fill');

  assert.equal(explicitRegion.scenarioMode, 'plane_cut_fill');
  assert.equal(explicitRegion.baseSurfaceMode, 'fixed');
  assert.equal(explicitRegion.pointFilterMode, 'exclude_vegetation');

  const emptyRegion = {
    scenarioMode: 'stockpile_boundary',
    baseSurfaceMode: 'boundary',
    pointFilterMode: 'none',
    surfaceType: 'stockpile',
  };

  applyScenarioDefaultsToRegion(emptyRegion, 'plane_cut_fill');

  assert.equal(emptyRegion.baseSurfaceMode, 'fixed');
  assert.equal(emptyRegion.pointFilterMode, 'all');
});
