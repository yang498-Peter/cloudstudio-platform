import { getAppEnv } from '../core/env.js';
import { getSharedI18n, initSharedLocale } from '../core/i18n.js';
import { createAppShell } from '../core/state.js';
import { createApiClient } from '../services/api-client.js';
import { addFeatureIfEnabled, loadServerCapabilities } from '../services/capabilities.js';
import { loadLegacyInlineModule } from './load-legacy-inline-module.js';
import { createFeedbackUi } from '../ui/feedback.js';
import { createOpenModalFeature } from '../features/open/open-modal.js';
import { createSceneTreeFeature } from '../features/scene-tree/index.js';
import { createDisplaySettingsFeature } from '../features/display-settings/index.js';
import { createScannerInfoPanelFeature } from '../features/scanner-info/index.js';
import { createMinimapFeature } from '../features/minimap/index.js';
import { createCaptureFeature } from '../features/capture/index.js';
import { createDxfFeature } from '../features/dxf/index.js';
import { createDxfDrawFeature } from '../features/dxf-draw/index.js';
import { createOpenLoadOrchestrationFeature } from '../features/open-load-orchestration/index.js';
import { createMeasurementFeature } from '../features/measurement/index.js';
import { createProfileFeature } from '../features/profile/index.js';
import { createExportLasFeature } from '../features/export-las/index.js';
import { createTerrainFeature } from '../features/terrain/index.js';
import { createVolumeFeature } from '../features/volume/index.js';
import { createDeleteRegionFeature } from '../features/delete-region/index.js';
import { createClipBoxFeature } from '../features/clip-box/index.js';
import { createPhotoFeature } from '../features/photo/index.js';
import { createScannerRuntimeFeature } from '../features/scanner-runtime/index.js';
import { createMagnifierFeature } from '../features/magnifier/index.js';

function installViewerCapture() {
  if (window.__CLOUDSTUDIO_VIEWER_CAPTURE_INSTALLED) {
    return;
  }

  const potree = window.Potree;
  if (!potree?.Viewer || potree.Viewer.__cloudstudioWrapped) {
    return;
  }

  const OriginalViewer = potree.Viewer;
  const WrappedViewer = new Proxy(OriginalViewer, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget);
      window.__CLOUDSTUDIO_VIEWER = instance;
      return instance;
    },
  });

  WrappedViewer.__cloudstudioWrapped = true;
  potree.Viewer = WrappedViewer;
  window.__CLOUDSTUDIO_VIEWER_CAPTURE_INSTALLED = true;
}

const env = getAppEnv('viewer');
const apiClient = createApiClient();
const capabilities = await loadServerCapabilities(apiClient);
const { i18n, locale } = await initSharedLocale({
  pageTitleSource: document.body.dataset.pageTitle || document.title,
});
const feedback = createFeedbackUi({
  getTranslator: () => ({
    translateText: (text) => i18n.translateText(text, window.__APP_ACTIVE_LOCALE || locale),
  }),
  getLocale: () => window.__APP_ACTIVE_LOCALE || locale,
  toastContainerId: 'toasts',
  statusElementId: 'st-status',
  statusValueSelector: '.st-val',
});
const appShell = createAppShell({
  page: 'viewer',
  env,
  services: {
    apiClient,
    capabilities,
    i18n,
  },
});

window.__APP_ENV = env;
window.__APP_SHELL = appShell;
window.__APP_SERVICES = appShell.services;
window.__APP_UI = feedback;
window.__APP_ACTIVE_LOCALE = locale;
window.__APP_CAPABILITIES = capabilities;
const viewerFeatures = {
  createOpenModalFeature,
  createDisplaySettingsFeature,
  createScannerInfoPanelFeature,
  createMinimapFeature,
  createDxfFeature,
  createDxfDrawFeature,
  createOpenLoadOrchestrationFeature,
  createPhotoFeature,
  createMagnifierFeature,
};
addFeatureIfEnabled(viewerFeatures, capabilities, 'sceneTree', 'createSceneTreeFeature', createSceneTreeFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'capture', 'createCaptureFeature', createCaptureFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'measurement', 'createMeasurementFeature', createMeasurementFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'profile', 'createProfileFeature', createProfileFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'export', 'createExportLasFeature', createExportLasFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'terrainProcessing', 'createTerrainFeature', createTerrainFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'volumeJobs', 'createVolumeFeature', createVolumeFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'deleteRegion', 'createDeleteRegionFeature', createDeleteRegionFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'clipBox', 'createClipBoxFeature', createClipBoxFeature);
addFeatureIfEnabled(viewerFeatures, capabilities, 'scannerRuntime', 'createScannerRuntimeFeature', createScannerRuntimeFeature);
window.__APP_VIEWER_FEATURES = viewerFeatures;

installViewerCapture();
await loadLegacyInlineModule('viewer-legacy-module-source', {
  sourceURL: '/assets/app/entry/viewer-legacy.inline.js',
});
