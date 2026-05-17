#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const i18nDir = path.join(appRoot, 'assets', 'i18n');
const locales = ['en', 'zh-CN', 'fr', 'ko-KR', 'de', 'es', 'it', 'fi', 'sv'];
const scanRoots = [
  path.join(appRoot, 'index.html'),
  path.join(appRoot, 'viewer.html'),
  path.join(appRoot, 'assets', 'app'),
];

const allowedSameValues = new Set([
  'CloudStudio', 'SuperSplat', 'Potree',
  'LAS', 'LAZ', 'PLY', 'DXF', 'OBJ', 'CSV', 'CRS', 'EPSG', 'UTM', 'UPS', 'WGS84',
  'EDL', 'RGB', 'X-Ray', 'PROJ / WKT', 'GeoTIFF',
  'm', 'km', 'cm', 'mm', 'ft', 'us-ft', 'yd', 'in', 's', 'pts',
  'English', 'Français',
  'Mode', 'Source', 'Photos', 'Scanner', 'Point', 'Distance', 'Angle', 'Volume',
  'Screenshot', 'Status', 'Code', 'Horizontal', 'Gradient', 'Format', 'Datum',
  'Ellipsoid', 'Name', 'Projection', 'Ortho', 'Skybox', 'Navigation', 'Pause',
  'Yards', 'Inches', 'Rendering', 'Color', 'Geo', 'Position', 'Orientation',
  'Timestamp', 'Meter',
  'Plasma', 'Inferno', 'Viridis', 'Spectral', '1B+', '0.25m',
  'points', 'points.', ' points', 'segments', 'Longitude', 'Latitude', 'Altitude',
  'Minimum (m)', 'Maximum (m)', 'Radius', 'Yards (yd)', 'LAS Export',
  'CHM Res', 'seconds', 'Zoom in', 'EPSG / alias', 'Color:', 'Transverse Mercator (TM)',
  'Easting offset', 'Volume Measurement', 'Scan Trajectory', 'Seed Min H', 'Seed Max H',
  'Park', 'Urban', 'Central meridian', 'Grid', 'Northing offset', 'SLAM Scan Support',
  'Orbit navigation', 'Eye Dome Lighting (EDL)',
  'CloudStudio - Professional Point Cloud Platform',
  'CloudStudio - Professional Point Cloud Processing and Analysis Platform',
  '🌐 Terrain Analysis Workbench (beta)',
]);

const allowedSamePatterns = [
  /^\s*$/,
  /^[A-Z0-9_./:+-]+$/,
  /^e\.g\./i,
  /^\/.+/,
  /^.*\{\{[a-zA-Z0-9_]+\}\}.*$/,
  /^.*\.(las|laz|ply|dxf|obj|zip|json|csv|txt|wkt|prj)$/i,
  /^.*(Plasma|Inferno|Viridis|Scanner|Distance|Volume Measurement|Scan Trajectory).*$/,
  /^.*Pause$/,
  /^m\)\.\.\.$/,
  /^📂 Open Point Cloud$/,
  /^CloudStudio Point Cloud Processing Platform · Powered by$/,
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function flatten(object, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(object || {})) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of flatten(value, next)) out.set(childKey, childValue);
    } else {
      out.set(next, value);
    }
  }
  return out;
}

function placeholderSet(value) {
  const matches = String(value || '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g);
  return new Set([...matches].map(match => match[1]));
}

function setDiff(a, b) {
  return [...a].filter(item => !b.has(item));
}

function isAllowedSameValue(value, key) {
  if (key.startsWith('common.locale.')) return true;
  if (key.includes('.symbol')) return true;
  if (allowedSameValues.has(value)) return true;
  return allowedSamePatterns.some(pattern => pattern.test(value));
}

function walkFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of fs.readdirSync(target)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(target, entry);
    const childStat = fs.statSync(full);
    if (childStat.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(html|js)$/.test(entry)) out.push(full);
  }
  return out;
}

function collectKeyRefs(file, text) {
  const refs = [];
  const add = (key, kind, index) => refs.push({ key, kind, index });

  for (const match of text.matchAll(/\b(?:data-i18n|data-i18n-html|data-i18n-title|data-i18n-placeholder|data-i18n-aria-label|data-i18n-value)=["']([^"']+)["']/g)) {
    add(match[1], 'data-i18n', match.index);
  }
  for (const match of text.matchAll(/\b(?:tr|translate)\(\s*(['"`])([^'"`]+)\1/g)) {
    if (match[2].includes('${')) continue;
    add(match[2], 'tr', match.index);
  }
  for (const match of text.matchAll(/\b(?:translateText|tt)\(\s*(['"`])([^'"`]+)\1/g)) {
    add(`phrases.${match[2]}`, 'phrase', match.index);
  }
  return refs;
}

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

let failed = false;
const warn = [];

const resources = new Map();
const flatResources = new Map();
for (const locale of locales) {
  const file = path.join(i18nDir, `${locale}.json`);
  try {
    const parsed = readJson(file);
    resources.set(locale, parsed);
    flatResources.set(locale, flatten(parsed));
  } catch (error) {
    failed = true;
    console.error(`[i18n] ${locale}.json is invalid: ${error.message}`);
  }
}

const enFlat = flatResources.get('en') || new Map();
for (const locale of locales.filter(item => item !== 'en')) {
  const flat = flatResources.get(locale) || new Map();
  const missing = [...enFlat.keys()].filter(key => !flat.has(key));
  const extra = [...flat.keys()].filter(key => !enFlat.has(key));
  if (missing.length) {
    failed = true;
    console.error(`[i18n] ${locale} missing ${missing.length} key(s): ${missing.slice(0, 20).join(', ')}`);
  }
  if (extra.length) warn.push(`[i18n] ${locale} has ${extra.length} extra key(s): ${extra.slice(0, 10).join(', ')}`);

  const same = [];
  for (const [key, enValue] of enFlat) {
    const value = flat.get(key);
    if (typeof enValue !== 'string' || typeof value !== 'string') continue;
    if (!/[A-Za-z]/.test(enValue) || value !== enValue) continue;
    if (!isAllowedSameValue(value, key)) same.push(`${key}="${value}"`);
  }
  if (same.length) {
    failed = true;
    console.error(`[i18n] ${locale} has unapproved same-as-English customer text (${same.length}): ${same.slice(0, 30).join(', ')}`);
  }

  for (const [key, enValue] of enFlat) {
    if (typeof enValue !== 'string' || typeof flat.get(key) !== 'string') continue;
    const enVars = placeholderSet(enValue);
    const localeVars = placeholderSet(flat.get(key));
    const missingVars = setDiff(enVars, localeVars);
    if (missingVars.length) {
      failed = true;
      console.error(`[i18n] ${locale}.${key} missing placeholder(s): ${missingVars.join(', ')}`);
    }
  }
}

const files = scanRoots.flatMap(walkFiles);
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (/[\u4e00-\u9fff]/.test(text)) {
    failed = true;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (/[\u4e00-\u9fff]/.test(line)) {
        console.error(`[i18n] hardcoded Han text: ${path.relative(appRoot, file)}:${index + 1}: ${line.trim().slice(0, 180)}`);
      }
    });
  }

  for (const ref of collectKeyRefs(file, text)) {
    if (!enFlat.has(ref.key)) {
      failed = true;
      console.error(`[i18n] missing referenced key ${ref.key} (${ref.kind}) at ${path.relative(appRoot, file)}:${lineNumber(text, ref.index)}`);
    }
  }
}

for (const item of warn) console.warn(item);

if (failed) {
  console.error('[i18n] check failed');
  process.exit(1);
}

console.log(`[i18n] OK: ${locales.length} locale files, ${enFlat.size} keys, ${files.length} UI source files checked.`);
