export function getAppEnv(page) {
  return {
    page,
    origin: window.location.origin,
    pathname: window.location.pathname,
    assetsBaseUrl: '/assets/app',
    apiBaseUrl: '/',
    potreeBaseUrl: '/potree',
    startedAt: Date.now(),
  };
}
