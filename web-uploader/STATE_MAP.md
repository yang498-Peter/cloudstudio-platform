# CloudStudio Viewer State Map

Last reviewed: 2026-06-03

Scope:

- `web-uploader/viewer.html`
- `web-uploader/assets/app/entry/viewer-entry.js`
- `web-uploader/assets/app/features/*`

Purpose:

- Provide a maintainable map of the current viewer state model.
- Distinguish explicit state domains, legacy local state, compatibility proxies, Potree runtime objects, and feature-private state.
- Help new developers identify the correct layer before fixing viewer bugs or refactoring feature behavior.

This document describes the current implementation. It is not a target architecture.

---

## 1. Mental Model

Viewer state is not stored in a single source. It is layered across five areas:

1. **`APP_SHELL` state domains**
   - Created through `APP_SHELL.ensureStateDomain(...)`.
   - These are the closest thing to formal application state.

2. **Legacy state inside `viewer.html`**
   - Local variables and objects still defined directly in the page.
   - Many workflows still read or mutate these values.

3. **Compatibility proxy or bridge state**
   - Transitional state used to keep older code and newer feature modules working together.
   - This is a common source of confusing cross-feature behavior.

4. **Potree runtime state**
   - State owned by the Potree viewer, scene, measurements, profiles, volumes, and input handlers.
   - Do not treat this as ordinary application state; it is engine-owned runtime state.

5. **Feature-private state**
   - State owned by an extracted module under `assets/app/features/*`.
   - Prefer this for new feature-local behavior when it does not need to be shared.

The most common debugging mistake is treating these layers as one unified object.

---

## 2. Explicit `APP_SHELL` State Domains

Known domains include:

| Domain | Purpose |
| --- | --- |
| `viewer.ui` | Tool mode, navigation pivot mode, active right pane, and right panel collapsed state. |
| `viewer.datasetContext` | Active dataset/cloud/project context used by viewer workflows. |
| `viewer.scannerSelection` | Scanner/project selection state. |
| `viewer.displaySettings` | Display settings that can be shared with feature modules. |
| `viewer.crsCatalog` | CRS/grid catalog state. |
| `viewer.scannerRegistry` | Registered scanner roots and project metadata. |

When adding shared state, prefer a named state domain over a new global variable.

---

## 3. Legacy State in `viewer.html`

Examples of legacy local state include:

- `profileState`
- `deleteSelectionState`
- `volumeMeasureState`
- `clipBoxState`
- `captureActive`
- `capturePoints`
- legacy helper aliases for selected dataset/project context

Rules when touching legacy state:

1. Identify every reader and writer before changing field shape.
2. Check whether a feature module receives the state through a factory argument.
3. Avoid replacing legacy state with a new object unless all compatibility references are updated.
4. Prefer incremental extraction over large rewrites.

---

## 4. Compatibility Bridges and Proxies

Bridge state exists because the viewer is being migrated from page-local logic to modules.

Common bridge patterns:

- `scannerGlobalState`
- `scannerState` proxy-style compatibility access
- local aliases for active dataset context
- globals exposed through `window.__APP_*`
- callbacks passed from `viewer.html` into feature factories

These bridges are useful but risky. A bug may occur because a module updates formal state while legacy code reads an older alias, or vice versa.

Before changing bridge behavior:

1. Search for all references to the bridge object.
2. Confirm whether the object is read synchronously by Potree event callbacks.
3. Confirm whether the value is also mirrored into an `APP_SHELL` domain.
4. Add a focused regression test if pure logic can be isolated.

---

## 5. Potree Runtime State

Potree owns runtime objects such as:

- `viewer.scene.pointclouds`
- `viewer.scene.measurements`
- `viewer.scene.volumes`
- `viewer.scene.profiles`
- `viewer.profileWindow`
- `viewer.profileWindowController`
- `viewer.inputHandler`
- Potree measurement/profile/volume objects

Guidelines:

- Do not mutate Potree collections without understanding Potree event lifecycle.
- After adding or removing Potree scene objects, refresh any CloudStudio scene tree or UI panels that mirror them.
- Measurement and profile behavior may depend on Potree object identity, not only serialized values.
- Engine-level Potree changes should be tested against viewer smoke flows.

---

## 6. Feature-Private State

Feature modules may keep private state when it is not needed globally.

Recommended pattern:

```js
export function createExampleFeature(deps) {
  const state = {
    active: false,
    selectedId: null,
  };

  function setActive(nextActive) {
    state.active = Boolean(nextActive);
  }

  return {
    setActive,
  };
}
```

Rules:

- Keep private state private unless another module genuinely needs it.
- Expose methods rather than mutable objects where possible.
- Use `APP_SHELL` domains for shared viewer state.
- Keep DOM-specific state close to the feature that owns the DOM.

---

## 7. Debugging Cross-Feature State Bugs

Use this checklist:

1. Identify the user action and the expected state transition.
2. Determine whether the state lives in:
   - `APP_SHELL`
   - `viewer.html`
   - a compatibility bridge
   - Potree runtime
   - feature-private state
3. Search for all readers and writers.
4. Check whether the UI is a mirror of Potree state or the source of truth.
5. Verify whether a feature factory receives stale references during initialization.
6. Confirm whether any event listener mutates state after the UI has already rendered.
7. Add a regression test for extracted pure logic when possible.

---

## 8. Practical Ownership Guide

| Area | Likely State Owner |
| --- | --- |
| Active toolbar mode | `viewer.ui` plus legacy compatibility updates. |
| Selected scanner project | scanner selection domain and scanner compatibility state. |
| Point cloud list | Potree scene plus server-provided dataset context. |
| Measurement objects | Potree scene; CloudStudio UI mirrors details. |
| Profile objects | Potree scene/profile window; CloudStudio UI coordinates orchestration. |
| Volume workflow | feature module state, legacy volume state, Python job result state. |
| Clip box | legacy clip state plus Potree volume/clip objects. |
| Display settings | `viewer.displaySettings` plus Potree material updates. |
| CRS/grid selection | `viewer.crsCatalog`, backend CRS endpoints, and feature-local UI state. |

---

## 9. Refactoring Guidance

When migrating legacy state into modules:

1. Move read-only formatting/helpers first.
2. Move UI rendering next.
3. Move orchestration wrappers after UI is stable.
4. Move Potree object lifecycle last.
5. Keep a compatibility shim until all legacy references are removed.
6. Update this document when ownership changes.

Avoid large rewrites that simultaneously change state ownership, Potree lifecycle, and UI rendering.

