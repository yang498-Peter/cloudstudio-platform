import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

import { resolvePlaywrightModule, startViewerServer } from './helpers/viewer-test-utils.mjs';

const ROOT = process.cwd();

test('viewer loads in headless chromium with swiftshader WebGL fallback', async () => {
  const server = await startViewerServer({ rootDir: ROOT });
  const require = createRequire(import.meta.url);
  const { chromium } = require(resolvePlaywrightModule(ROOT));

  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });

  try {
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
    await browser.close();
    await server.stop();
  }
});
