import { getAppEnv } from '../core/env.js';
import { initSharedLocale } from '../core/i18n.js';
import { createAppShell } from '../core/state.js';
import { createApiClient } from '../services/api-client.js';
import { loadLegacyInlineModule } from './load-legacy-inline-module.js';
import { createFeedbackUi } from '../ui/feedback.js';

const env = getAppEnv('index');
const { i18n, locale } = await initSharedLocale({
  pageTitleSource: document.body.dataset.pageTitle || document.title,
});
const feedback = createFeedbackUi({
  getTranslator: () => ({
    translateText: (text) => i18n.translateText(text, window.__APP_ACTIVE_LOCALE || locale),
  }),
  getLocale: () => window.__APP_ACTIVE_LOCALE || locale,
  toastContainerId: 'toasts',
  statusElementId: 'statusEl',
  statusClassName: 'status-bar',
});
const appShell = createAppShell({
  page: 'index',
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

await loadLegacyInlineModule('index-legacy-script-source', {
  sourceURL: '/assets/app/entry/index-legacy.inline.js',
});
