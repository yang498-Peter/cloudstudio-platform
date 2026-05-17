(function (global) {
  const STORAGE_KEY = 'potree-local:locale';
  const SUPPORTED_LOCALES = ['en', 'zh-CN', 'fr', 'ko-KR', 'de', 'es', 'it', 'fi', 'sv'];
  const POTREE_LOCALE_MAP = {
    en: 'en',
    'zh-CN': 'zh',
    fr: 'fr',
    'ko-KR': 'en',
    de: 'de',
    es: 'es',
    it: 'it',
    fi: 'en',
    sv: 'en',
  };

  let currentLocale = 'en';
  let resources = {};
  let isInitialized = false;
  const listeners = new Set();

  function normalizeLocale(locale) {
    return SUPPORTED_LOCALES.includes(locale) ? locale : 'en';
  }

  function getStoredLocale() {
    try {
      return normalizeLocale(global.localStorage.getItem(STORAGE_KEY) || 'en');
    } catch {
      return 'en';
    }
  }

  function setStoredLocale(locale) {
    try {
      global.localStorage.setItem(STORAGE_KEY, normalizeLocale(locale));
    } catch {
      // Ignore storage failures in locked-down browsers.
    }
  }

  function getByPath(obj, path) {
    return String(path || '')
      .split('.')
      .reduce((acc, part) => (acc && Object.prototype.hasOwnProperty.call(acc, part) ? acc[part] : undefined), obj);
  }

  function interpolate(template, vars) {
    if (typeof template !== 'string') return template;
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
      const value = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
      return value == null ? '' : String(value);
    });
  }

  function createEmptyLocaleResource(locale) {
    return {
      meta: {
        locale: normalizeLocale(locale),
        label: normalizeLocale(locale),
      },
      phrases: {},
    };
  }

  async function fetchLocale(locale) {
    const response = await global.fetch(`/assets/i18n/${encodeURIComponent(locale)}.json?v=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load locale ${locale} (${response.status})`);
    }
    const text = await response.text();
    try {
      return JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
    } catch (error) {
      console.warn(`[i18n] Failed to parse locale ${locale}. Falling back to raw UI text.`, error);
      return createEmptyLocaleResource(locale);
    }
  }

  async function loadLocaleResources(locale) {
    const normalized = normalizeLocale(locale);
    if (!resources.en) {
      try {
        resources.en = await fetchLocale('en');
      } catch (error) {
        console.warn('[i18n] English locale unavailable. Falling back to raw UI text.', error);
        resources.en = createEmptyLocaleResource('en');
      }
    }
    if (!resources[normalized]) {
      try {
        resources[normalized] = await fetchLocale(normalized);
      } catch (error) {
        console.warn('[i18n] Falling back to English/raw UI text:', error);
        resources[normalized] = resources.en;
      }
    }
    return resources[normalized];
  }

  function translateText(text, locale = currentLocale) {
    const raw = String(text || '');
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const active = resources[locale] || resources.en || {};
    const enResources = resources.en || {};
    // Look up the phrase in the active locale first, then fall back to
    // English. This matters for locales (de/es/it/fi/sv) that don't ship
    // their own `phrases` map yet — without the fallback, untranslated
    // phrases would leak through as the original Chinese source string.
    function lookupPhrase(phrase) {
      const fromActive = active.phrases && active.phrases[phrase];
      if (fromActive) return fromActive;
      if (active !== enResources) {
        const fromEn = enResources.phrases && enResources.phrases[phrase];
        if (fromEn) return fromEn;
      }
      return undefined;
    }
    const translated = lookupPhrase(trimmed);
    if (!translated) {
      for (const separator of [':', '：']) {
        const index = trimmed.indexOf(separator);
        if (index > 0) {
          const prefix = trimmed.slice(0, index).trim();
          const translatedPrefix = lookupPhrase(prefix);
          if (translatedPrefix) {
            return raw.replace(prefix, translatedPrefix);
          }
        }
      }

      const parenMatch = trimmed.match(/^(.+?)\s*\(([^)]+)\)$/);
      if (parenMatch) {
        const prefix = parenMatch[1].trim();
        const translatedPrefix = lookupPhrase(prefix);
        if (translatedPrefix) {
          return raw.replace(prefix, translatedPrefix);
        }
      }

      return raw;
    }
    if (raw === trimmed) return translated;
    return raw.replace(trimmed, translated);
  }

  function t(key, vars = {}, fallback = '') {
    const active = resources[currentLocale] || {};
    const base = resources.en || {};
    const resolved = getByPath(active, key);
    if (resolved != null) return interpolate(resolved, vars);
    const fallbackResolved = getByPath(base, key);
    if (fallbackResolved != null) return interpolate(fallbackResolved, vars);
    return interpolate(fallback || key, vars);
  }

  function applyTextTranslations(root = global.document) {
    if (!root || !root.querySelectorAll) return;

    root.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      const fallback = el.getAttribute('data-i18n-fallback') || el.dataset.i18nOriginalText || el.textContent;
      if (!el.dataset.i18nOriginalText) el.dataset.i18nOriginalText = fallback;
      el.textContent = t(key, {}, fallback || '');
    });

    root.querySelectorAll('[data-i18n-html]').forEach((el) => {
      const key = el.getAttribute('data-i18n-html');
      const fallback = el.getAttribute('data-i18n-html-fallback') || el.dataset.i18nOriginalHtml || el.innerHTML;
      if (!el.dataset.i18nOriginalHtml) el.dataset.i18nOriginalHtml = fallback;
      el.innerHTML = t(key, {}, fallback || '');
    });

    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      const fallback = el.getAttribute('data-i18n-title-fallback') || el.dataset.i18nOriginalTitle || el.getAttribute('title') || '';
      if (!el.dataset.i18nOriginalTitle) el.dataset.i18nOriginalTitle = fallback;
      el.setAttribute('title', t(key, {}, fallback));
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      const fallback = el.getAttribute('data-i18n-placeholder-fallback') || el.dataset.i18nOriginalPlaceholder || el.getAttribute('placeholder') || '';
      if (!el.dataset.i18nOriginalPlaceholder) el.dataset.i18nOriginalPlaceholder = fallback;
      el.setAttribute('placeholder', t(key, {}, fallback));
    });

    root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria-label');
      const fallback = el.getAttribute('data-i18n-aria-label-fallback') || el.dataset.i18nOriginalAriaLabel || el.getAttribute('aria-label') || '';
      if (!el.dataset.i18nOriginalAriaLabel) el.dataset.i18nOriginalAriaLabel = fallback;
      el.setAttribute('aria-label', t(key, {}, fallback));
    });

    root.querySelectorAll('[data-i18n-value]').forEach((el) => {
      const key = el.getAttribute('data-i18n-value');
      const fallback = el.dataset.i18nOriginalValue || el.getAttribute('value') || '';
      if (!el.dataset.i18nOriginalValue) el.dataset.i18nOriginalValue = fallback;
      el.setAttribute('value', t(key, {}, fallback));
    });

    root.querySelectorAll('[title]').forEach((el) => {
      const value = el.dataset.i18nGenericTitle || el.getAttribute('title');
      if (!el.dataset.i18nGenericTitle) el.dataset.i18nGenericTitle = value || '';
      const translated = translateText(value);
      if (translated !== value) el.setAttribute('title', translated);
      else if (value != null) el.setAttribute('title', value);
    });

    root.querySelectorAll('[placeholder]').forEach((el) => {
      const value = el.dataset.i18nGenericPlaceholder || el.getAttribute('placeholder');
      if (!el.dataset.i18nGenericPlaceholder) el.dataset.i18nGenericPlaceholder = value || '';
      const translated = translateText(value);
      if (translated !== value) el.setAttribute('placeholder', translated);
      else if (value != null) el.setAttribute('placeholder', value);
    });

    root.querySelectorAll('[aria-label]').forEach((el) => {
      const value = el.dataset.i18nGenericAriaLabel || el.getAttribute('aria-label');
      if (!el.dataset.i18nGenericAriaLabel) el.dataset.i18nGenericAriaLabel = value || '';
      const translated = translateText(value);
      if (translated !== value) el.setAttribute('aria-label', translated);
      else if (value != null) el.setAttribute('aria-label', value);
    });

    root.querySelectorAll('[data-i18n-auto]').forEach((el) => {
      el.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim()) {
          if (node.__i18nOriginalText == null) node.__i18nOriginalText = node.textContent;
          node.textContent = translateText(node.__i18nOriginalText);
        }
      });
    });

    root.querySelectorAll('[data-i18n-auto-root]').forEach((el) => {
      const walker = global.document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node || !node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest('[data-i18n]') || parent.closest('[data-i18n-html]')) return NodeFilter.FILTER_REJECT;
          if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        if (node.__i18nOriginalText == null) node.__i18nOriginalText = node.textContent;
        node.textContent = translateText(node.__i18nOriginalText);
      });
    });
  }

  async function applyTranslations(root = global.document) {
    try {
      await loadLocaleResources(currentLocale);
      applyTextTranslations(root);
      if (global.document && global.document.documentElement) {
        global.document.documentElement.lang = currentLocale;
      }
    } catch (error) {
      console.warn('[i18n] Failed to apply translations. Keeping original UI text.', error);
    } finally {
      if (global.document && global.document.body) {
        global.document.body.dataset.i18nReady = '1';
      }
    }
  }

  async function setLocale(locale, { persist = true } = {}) {
    const normalized = normalizeLocale(locale);
    await loadLocaleResources(normalized);
    currentLocale = normalized;
    if (persist) setStoredLocale(normalized);
    await applyTranslations(global.document);
    listeners.forEach((listener) => {
      try {
        listener(normalized);
      } catch (error) {
        console.error('[i18n] Locale listener failed:', error);
      }
    });
    return normalized;
  }

  function onLocaleChange(listener) {
    if (typeof listener !== 'function') return function noop() { };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function init() {
    if (isInitialized) return currentLocale;
    currentLocale = getStoredLocale();
    try {
      await loadLocaleResources(currentLocale);
    } catch (error) {
      console.warn('[i18n] Locale init failed. Keeping original UI text.', error);
    }
    isInitialized = true;
    if (global.document && global.document.body) {
      global.document.body.dataset.i18nReady = '1';
    }
    return currentLocale;
  }

  const api = {
    STORAGE_KEY,
    getSupportedLocales() {
      return SUPPORTED_LOCALES.slice();
    },
    getCurrentLocale() {
      return currentLocale;
    },
    getPotreeLocale(appLocale) {
      return POTREE_LOCALE_MAP[normalizeLocale(appLocale)] || 'en';
    },
    loadLocaleResources,
    onLocaleChange,
    t,
    translateText,
    applyTranslations,
    setLocale,
    init,
  };

  global.PotreeLocalI18n = api;
})(window);
