export function createAppShell({ page, env, services = {} }) {
  const state = {
    page,
    env,
    services: { ...services },
    globals: new Map(),
    domains: new Map(),
  };

  function ensureStateDomain(key, initialValue = {}) {
    if (!state.domains.has(key)) {
      state.domains.set(key, { ...initialValue });
    }
    return state.domains.get(key);
  }

  function getState(key) {
    return state.domains.get(key);
  }

  function patchState(key, patch) {
    const current = ensureStateDomain(key);
    const nextPatch = typeof patch === 'function' ? patch({ ...current }) : patch;
    if (!nextPatch || typeof nextPatch !== 'object') {
      return current;
    }
    Object.assign(current, nextPatch);
    return current;
  }

  return {
    get page() {
      return state.page;
    },
    get env() {
      return state.env;
    },
    get services() {
      return state.services;
    },
    setGlobal(key, value) {
      state.globals.set(key, value);
      return value;
    },
    getGlobal(key) {
      return state.globals.get(key);
    },
    hasGlobal(key) {
      return state.globals.has(key);
    },
    ensureStateDomain,
    getState,
    patchState,
  };
}
