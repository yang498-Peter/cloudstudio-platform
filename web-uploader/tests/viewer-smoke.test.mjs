import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { resolvePlaywrightModule, startViewerServer } from './helpers/viewer-test-utils.mjs';
import { createExportLasFeature } from '../assets/app/features/export-las/index.js';

const ROOT = process.cwd();

async function launchChromiumOrSkip(t, chromium, options = {}) {
  try {
    return await chromium.launch(options);
  } catch (error) {
    if (/Executable doesn't exist|playwright install/i.test(String(error?.message || error))) {
      t.skip('Playwright Chromium is not installed in this local environment.');
      return null;
    }
    throw error;
  }
}

test('viewer loads in headless chromium with swiftshader WebGL fallback', async t => {
  const server = await startViewerServer({ rootDir: ROOT });
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolvePlaywrightModule(ROOT));

  let browser = null;

  try {
    browser = await launchChromiumOrSkip(t, chromium, {
      headless: true,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    if (!browser) return;

    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', err => errors.push(`pageerror:${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`console:${msg.text()}`);
    });

    await page.goto(`${server.baseUrl}/viewer`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });

    const title = await page.title();
    const status = await page.locator('#st-status .st-val').textContent();

    assert.match(title, /CloudStudio/i);
    assert.ok(status && status.trim().length > 0, 'viewer status bar should be populated');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
});

test('home page does not expose customer delete controls', async t => {
  const server = await startViewerServer({ rootDir: ROOT });
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolvePlaywrightModule(ROOT));
  let browser = null;

  try {
    browser = await launchChromiumOrSkip(t, chromium, { headless: true });
    if (!browser) return;

    const page = await browser.newPage();
    await page.goto(server.baseUrl, { waitUntil: 'networkidle', timeout: 60000 });
    assert.equal(await page.locator('.btn-delete').count(), 0);
  } finally {
    if (browser) await browser.close();
    await server.stop();
  }
});

test('export modal reflects selected format and success state', async () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const elements = new Map();
  const makeElement = (id, props = {}) => {
    const classes = new Set();
    const element = {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      disabled: false,
      checked: false,
      style: {},
      dataset: {},
      classList: {
        add: cls => classes.add(cls),
        remove: cls => classes.delete(cls),
        toggle: (cls, force) => {
          const next = force === undefined ? !classes.has(cls) : Boolean(force);
          if (next) classes.add(cls);
          else classes.delete(cls);
          return next;
        },
        contains: cls => classes.has(cls),
      },
      addEventListener: () => {},
      querySelectorAll: () => [],
      setAttribute: () => {},
      ...props,
    };
    elements.set(id, element);
    return element;
  };

  makeElement('modal-export-las');
  makeElement('export-dataset-summary');
  makeElement('sel-export-source', { value: 'source.las' });
  makeElement('inp-export-filename', { value: 'result.laz' });
  makeElement('export-las-submit');
  makeElement('export-las-cancel');
  makeElement('export-las-note');
  makeElement('sel-export-format', { value: 'laz' });
  makeElement('sel-export-ply-encoding', { value: 'binary' });
  makeElement('sel-export-transform-mode', { value: 'current' });
  makeElement('chk-export-crs', { checked: true });
  makeElement('chk-export-vlr', { checked: true });

  let clickedDownload = false;
  globalThis.document = {
    getElementById: id => elements.get(id) || null,
    createElement: () => ({
      href: '',
      download: '',
      click: () => { clickedDownload = true; },
      remove: () => {},
    }),
    body: { appendChild: () => {} },
  };
  globalThis.window = {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };

  try {
    let statusDuringFetch = '';
    let exportJobStarted = false;
    const feature = createExportLasFeature({
      fetchImpl: async (url) => {
        statusDuringFetch = elements.get('export-las-note').textContent;
        if (url === '/api/export-pointcloud/jobs') {
          exportJobStarted = true;
          return {
            ok: true,
            json: async () => ({
              ok: true,
              jobId: 'export-job-1',
              statusUrl: '/api/jobs/export-job-1',
            }),
          };
        }
        assert.equal(url, '/api/jobs/export-job-1');
        return {
          ok: true,
          json: async () => ({
            ok: true,
            job: {
              status: 'completed',
              progress: 100,
              result: {
                ok: true,
                format: 'laz',
                downloadUrl: '/exports/result.laz',
                outputFilename: 'result.laz',
                sizeLabel: '1 MB',
              },
            },
          }),
        };
      },
      translate: (key, vars = {}, fallback = '') => fallback.replace('{{format}}', vars.format || '').replace('{{message}}', vars.message || ''),
      translateText: text => text,
      translateError: (_code, fallback) => fallback,
      toast: () => {},
      getActiveDatasetContext: () => ({ type: 'cloud', cloudName: 'demo' }),
      getExportContextQuery: () => 'cloudName=demo',
      getExportSourceOptions: () => [{ relPath: 'source.las', name: 'source.las' }],
      setExportSourceOptions: () => {},
      buildDefaultExportFilename: () => 'result.laz',
      updateExportUnitModeVisibility: () => {},
      updateExportLasNote: () => {},
      getCoordConfig: () => ({}),
      createDefaultCoordinateConfig: () => ({}),
      getCurrentResolvedCoordinateSystem: () => null,
      serializeDeleteRegions: () => [],
      resolveSelectedExportLinearUnit: () => ({ mode: 'native' }),
      escapeHtml: value => String(value ?? ''),
      formatNumber: value => String(value),
    });

    await feature.submitExportLas();

    assert.match(statusDuringFetch, /Exporting LAZ/);
    assert.equal(exportJobStarted, true);
    assert.equal(clickedDownload, true);
    assert.match(elements.get('export-las-note').className, /ok/);
    assert.match(elements.get('export-las-note').innerHTML, /result\.laz/);
    assert.match(elements.get('export-las-note').innerHTML, /1 MB/);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
