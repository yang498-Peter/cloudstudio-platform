# Measurement Split Plan

Last updated: 2026-03-09

Scope:
- preparation for extracting `measurement`
- no CRS / multi-scanner / profile rewrite in this phase

Current baseline:
- minimal pre-cleanup already completed:
  - explicit `uiState.toolMode`
  - single selected-project source:
    - `scannerGlobalState.selectedProjectId`
  - shared coordinate context helper:
    - `getCurrentCoordinateProjectContext(...)`

---

## Goal

Extract `measurement` in the same incremental style used for:
- `open-modal`
- `scene-tree`
- `display-settings`
- `minimap`
- `scanner-info`

Without:
- rewriting Potree measurement logic
- touching CRS internals
- touching multi-scanner placement

---

## Recommended Split Order

### Phase M1: Measurement UI shell

Move out:
- measurement panel rendering shell
- measurement detail card rendering
- measurement tree wiring for measurement rows only
- tool button UI state sync for measurement buttons

Keep in legacy:
- `viewer.measuringTool.startInsertion(...)`
- Potree measurement lifecycle
- coordinate conversion logic
- `syncMeasurementCoordinateLabels()`

Target module:
- `assets/app/features/measurement/index.js`

Expected interface:
- `createMeasurementFeature({ viewer, getMeasurements, removeMeasurement, refreshSceneTree, translateText, ... })`

### Phase M2: Measurement orchestration shell

Move out:
- `startMeasurement(type)` wrapper only
- config assembly for point/distance/height/area/angle
- measurement-related status/toast calls
- measure-tab activation

Keep in legacy:
- direct Potree object handling
- event bridge to coordinate labels
- any CRS-sensitive point conversion

Important rule:
- orchestration module can call legacy helpers, but must not own coordinate math yet

### Phase M3: Measurement label/format bridge

Move out only after M1/M2 are stable:
- `getMeasIcon`
- `getMeasurementDisplayName`
- `getMeasDetails`
- formatting wrappers that only depend on:
  - `formatLinearMeasurement`
  - `formatAreaMeasurement`
  - translation helpers

Keep in legacy:
- `syncMeasurementCoordinateLabels()` until CRS/module boundaries are safer

---

## Explicit Dependencies Measurement Module Will Need

### Stable dependencies to inject
- `viewer`
- `translate`
- `translateText`
- `toast`
- `setStatus`
- `refreshSceneTree`
- `formatLinearMeasurement`
- `formatAreaMeasurement`
- `getCurrentCoordinateProjectContext`
- `convertLocalPointToCurrentSystem`
- `pointToLocalCoordinates`
- `setToolMode` or `setTool`

### Potree-owned runtime to treat as external
- `viewer.scene.measurements`
- `viewer.measuringTool`

### Shared cancellation hooks
Measurement start currently cancels other tools. Keep this as injected callbacks:
- `stopCapture`
- `cancelVolumeSelection`
- `cancelDeletePolygonSelection`
- `hideAllVolumeRegionOverlays`

---

## What Not To Touch During Measurement Extraction

- `resolveCoordinateSystem(...)`
- native transform queue/cache logic
- scanner registry structure
- project selection logic
- `profile` panel and profile window lifecycle
- multi-scanner placement / containers

---

## Acceptance Criteria For Measurement Extraction

Before calling measurement extraction complete:

1. `/viewer` still opens
2. real scanner project still loads
3. point/distance/height/area/angle tools still start and finish
4. measurement cards still render
5. scene tree measurement count still updates
6. coordinate point measurement still uses the correct selected project context
7. no new logic is pushed into `viewer-entry.js`

