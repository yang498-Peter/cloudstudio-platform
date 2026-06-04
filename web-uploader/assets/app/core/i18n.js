export function getSharedI18n() {
  return window.PotreeLocalI18n || null;
}

export async function initSharedLocale({ pageTitleSource = '' } = {}) {
  const i18n = getSharedI18n();
  if (!i18n) {
    document.body.dataset.i18nReady = '1';
    return {
      i18n: {
        t: (_key, _vars = {}, fallback = '') => fallback,
        translateText: text => text,
        applyTranslations: async () => {},
        init: async () => 'en',
      },
      locale: 'en',
    };
  }
  try {
    const locale = await i18n.init();
    if (pageTitleSource) {
      document.title = i18n.translateText(pageTitleSource, locale);
    }
    return { i18n, locale };
  } catch (error) {
    console.warn('[i18n] Locale bootstrap failed. Continuing with original DOM text.', error);
    document.body.dataset.i18nReady = '1';
    return { i18n, locale: i18n.getCurrentLocale?.() || 'en' };
  }
}
