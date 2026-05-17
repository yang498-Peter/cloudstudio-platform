import { getAppEnv } from '../core/env.js';
import { getSharedI18n, initSharedLocale } from '../core/i18n.js';
import { createAppShell } from '../core/state.js';
import { createApiClient } from '../services/api-client.js';
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

const env = getAppEnv('viewer');
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
    apiClient: createApiClient(),
    i18n,
  },
});

window.__APP_ENV = env;
window.__APP_SHELL = appShell;
window.__APP_SERVICES = appShell.services;
window.__APP_UI = feedback;
window.__APP_ACTIVE_LOCALE = locale;
window.__APP_VIEWER_FEATURES = {
  createOpenModalFeature,
  createSceneTreeFeature,
  createDisplaySettingsFeature,
  createScannerInfoPanelFeature,
  createMinimapFeature,
  createCaptureFeature,
  createDxfFeature,
  createDxfDrawFeature,
  createOpenLoadOrchestrationFeature,
  createMeasurementFeature,
  createProfileFeature,
  createExportLasFeature,
  createTerrainFeature,
  createVolumeFeature,
  createDeleteRegionFeature,
  createClipBoxFeature,
  createPhotoFeature,
  createScannerRuntimeFeature,
  createMagnifierFeature,
};

await loadLegacyInlineModule('viewer-legacy-module-source', {
  sourceURL: '/assets/app/entry/viewer-legacy.inline.js',
});
