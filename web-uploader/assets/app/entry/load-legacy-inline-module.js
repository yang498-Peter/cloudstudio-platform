const legacyModuleCache = new Map();

export async function loadLegacyInlineModule(sourceElementId, { sourceURL = '', globals = {} } = {}) {
  if (!sourceElementId) {
    throw new Error('sourceElementId is required.');
  }

  const cacheKey = `${sourceElementId}::${sourceURL}`;
  if (legacyModuleCache.has(cacheKey)) {
    return legacyModuleCache.get(cacheKey);
  }

  const sourceEl = document.getElementById(sourceElementId);
  if (!sourceEl) {
    throw new Error(`Legacy source element not found: ${sourceElementId}`);
  }

  Object.assign(window, globals);

  const sourceText = sourceEl.textContent || '';
  const moduleText = `${sourceText}\n${sourceURL ? `//# sourceURL=${sourceURL}` : ''}\n`;
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.dataset.legacySourceId = sourceElementId;
    script.textContent = moduleText;
    script.addEventListener('error', (event) => reject(event.error || new Error(`Failed to load legacy module: ${sourceElementId}`)));
    document.head.appendChild(script);
    window.setTimeout(() => resolve(), 0);
  });

  legacyModuleCache.set(cacheKey, promise);
  return promise;
}
