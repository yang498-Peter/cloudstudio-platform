export function getSharedI18n() {
  return window.PotreeLocalI18n || null;
}

export async function initSharedLocale({ pageTitleSource = '' } = {}) {
  const i18n = getSharedI18n();
  if (!i18n) {
    throw new Error('PotreeLocalI18n is not available.');
  }
  const locale = await i18n.init();
  if (pageTitleSource) {
    document.title = i18n.translateText(pageTitleSource, locale);
  }
  return { i18n, locale };
}
