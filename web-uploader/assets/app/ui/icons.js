const APP_ICON_PALETTES = {
  file: ['#2563eb', '#dbeafe', '#93c5fd'],
  nav: ['#2563eb', '#eff6ff', '#bfdbfe'],
  measure: ['#ea580c', '#ffedd5', '#fed7aa'],
  cloud: ['#0891b2', '#cffafe', '#67e8f9'],
  color: ['#7c3aed', '#ede9fe', '#c4b5fd'],
  good: ['#16a34a', '#dcfce7', '#86efac'],
  danger: ['#dc2626', '#fee2e2', '#fca5a5'],
  neutral: ['#64748b', '#f8fafc', '#cbd5e1'],
  light: ['#94a3b8', '#ffffff', '#e2e8f0'],
};

const APP_ICON_FAMILY = {
  open: 'file', folder: 'file', file: 'neutral', export: 'file', upload: 'good', screenshot: 'file', copy: 'file',
  fit: 'nav', 'orbit-center': 'nav', 'orbit-pick': 'nav', fly: 'cloud', perspective: 'nav', orthographic: 'nav',
  top: 'nav', bottom: 'nav', left: 'nav', right: 'nav', 'double-left': 'nav', 'double-right': 'nav', home: 'nav', fullscreen: 'nav', expand: 'nav', menu: 'neutral',
  point: 'danger', distance: 'measure', height: 'measure', area: 'measure', angle: 'measure', measure: 'measure',
  volume: 'cloud', capture: 'color', 'clip-box': 'cloud', clip: 'cloud', 'delete-region': 'danger', profile: 'color',
  clear: 'danger', trash: 'danger', close: 'neutral', refresh: 'file',
  rgb: 'color', elevation: 'good', intensity: 'measure', classification: 'color', lod: 'neutral', edl: 'color', xray: 'cloud',
  map: 'good', basemap: 'good', scanner: 'file', register: 'good', 'crs-convert': 'file', 'mvp-s1': 'cloud',
  appearance: 'color', dxf: 'color', ground: 'good', model: 'cloud', contour: 'cloud', semantic: 'color', tree: 'good',
  search: 'file', plus: 'good', edit: 'measure', info: 'file', view: 'cloud', chart: 'good', location: 'danger',
  skybox: 'cloud', 'blue-sky': 'measure', sunset: 'measure', twilight: 'color', moonlit: 'neutral', cloud: 'cloud',
  gradient: 'color', black: 'neutral', white: 'light', magnifier: 'file',
};

function resolveAppIconPalette(iconName) {
  const key = APP_ICON_FAMILY[iconName] || 'file';
  return APP_ICON_PALETTES[key] || APP_ICON_PALETTES.file;
}

export function buildAppIconSvg(iconName) {
  const normalized = String(iconName || '').trim();
  if (!normalized) return '';
  const symbol = document.getElementById(`cs-i-${normalized}`);
  if (!symbol) return '';
  const [fg, bg, accent] = resolveAppIconPalette(normalized);
  return `<svg class="cs-colored-icon" viewBox="${symbol.getAttribute('viewBox') || '0 0 24 24'}" aria-hidden="true" focusable="false" style="--cs-icon-fg:${fg};--cs-icon-bg:${bg};--cs-icon-accent:${accent};"><rect class="cs-icon-bg" x="3" y="3" width="18" height="18" rx="5"></rect><g class="cs-icon-glyph">${symbol.innerHTML}</g></svg>`;
}

export function setIconElement(target, iconName) {
  if (!target) return;
  target.dataset.csIcon = iconName;
  target.innerHTML = buildAppIconSvg(iconName);
}

export function renderAppIcons(root = document) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll('[data-cs-icon]').forEach((el) => {
    setIconElement(el, el.dataset.csIcon);
  });
}
