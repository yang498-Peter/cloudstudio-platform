import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { resolvePlaywrightModule, startViewerServer } from './helpers/viewer-test-utils.mjs';

const ROOT = process.cwd();

function createFakeSurface(role = 'analysis') {
  const z = role === 'base' ? 0.0 : 0.45;
  const color = role === 'base' ? [0.67, 0.72, 0.79] : [0.20, 0.56, 0.98];
  const polygon = [
    { x: 0, y: 0, z },
    { x: 2, y: 0, z },
    { x: 2, y: 2, z },
    { x: 0, y: 2, z },
  ];
  return {
    mesh: {
      meta: {
        type: role === 'base' ? 'volume_base_surface' : 'volume_analysis_surface',
        surfaceRole: role,
        rows: 2,
        cols: 2,
        resolutionX: 1,
        resolutionY: 1,
        polygon,
      },
      vertices: [
        [0, 0, z],
        [2, 0, z],
        [2, 2, z],
        [0, 2, z],
      ],
      colors: [color, color, color, color],
      faces: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    },
    grid: {
      meta: {
        surfaceRole: role,
        rows: 2,
        cols: 2,
        resolutionX: 1,
        resolutionY: 1,
        polygon,
      },
      grid: [
        [z, z],
        [z, z],
      ],
    },
  };
}

async function openBelJoelVolumePanel(page, baseUrl) {
  await page.goto(`${baseUrl}/viewer`, { waitUntil: 'networkidle', timeout: 60000 });

  const disclaimerClose = page.locator('#disclaimer-close');
  if (await disclaimerClose.isVisible().catch(() => false)) {
    await disclaimerClose.click();
    await page.locator('#modal-disclaimer').waitFor({ state: 'hidden', timeout: 10000 });
  }

  await page.locator('#tb-open').click();
  await page.locator('#modal-open').waitFor({ state: 'visible', timeout: 15000 });

  const belJoelItem = page.locator('.cloud-list-item').filter({ hasText: 'BEL-JOEL' }).first();
  await belJoelItem.waitFor({ state: 'visible', timeout: 20000 });
  await belJoelItem.getByRole('button', { name: /open/i }).click();

  await page.locator('#modal-open').waitFor({ state: 'hidden', timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('cnt-clouds');
    return el && Number(el.textContent || '0') >= 1;
  }, null, { timeout: 60000 });

  await page.locator('[data-pane="measure"]').click();
  await page.locator('#pane-measure').waitFor({ state: 'visible', timeout: 10000 });
}

async function drawVolumeRegion(page) {
  const points = [
    { x: 560, y: 710 },
    { x: 780, y: 700 },
    { x: 820, y: 820 },
    { x: 580, y: 860 },
  ];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.locator('#btn-volume-start').click();
    await page.waitForFunction(() => {
      const meta = document.getElementById('volume-panel-meta');
      return meta && /Drawing|正在绘制/.test(meta.textContent || '');
    }, null, { timeout: 10000 });
    await page.waitForTimeout(attempt === 0 ? 6000 : 9000);

    for (const point of points.slice(0, -1)) {
      await page.mouse.click(point.x, point.y);
      await page.waitForTimeout(250);
    }
    const last = points[points.length - 1];
    await page.mouse.dblclick(last.x, last.y);

    try {
      await page.waitForFunction(() => {
        const meta = document.getElementById('volume-panel-meta');
        return meta && /Volume jobs|体积评估项/.test(meta.textContent || '');
      }, null, { timeout: 6000 });
      return;
    } catch {
      if (attempt === 1) throw new Error('Volume region drawing did not finalize after retry.');
      await page.locator('#btn-volume-cancel').click();
      await page.waitForTimeout(1000);
    }
  }
}

function buildFakeVolumeResult(jobId, requestedResolution = 0.25) {
  const resolution = Number.isFinite(Number(requestedResolution)) ? Number(requestedResolution) : 0.25;
  return {
    jobId,
    scenarioMode: 'stockpile_boundary',
    stats: {
      filteredPointCount: 128,
      effectiveCellCount: 4,
      coverageRatio: 1,
      polygonArea: 4,
    },
    volume: {
      cutVolume: 12.3,
      fillVolume: 0.4,
      netVolume: -11.9,
    },
    diagnostic: {
      confidence: 'high',
      warnings: [],
      baseSourceUsed: 'boundary_fit',
      resolutionRecommendation: {
        recommendedResolution: resolution,
        recommendedMinResolution: resolution,
        recommendedMaxResolution: resolution,
        targetCellCount: 1200,
      },
    },
  };
}

function installFakeVolumeRoutes(page) {
  const jobId = 'vol_fake_ui_job';
  const analysis = createFakeSurface('analysis');
  const base = createFakeSurface('base');
  let result = buildFakeVolumeResult(jobId);

  page.route('**/api/volume-jobs', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    result = buildFakeVolumeResult(jobId, body.resolution);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        jobId,
        result,
        resultUrl: `/api/volume-results?jobId=${jobId}`,
        reportPdfUrl: `/api/download-volume-job?jobId=${jobId}&artifact=report-pdf`,
        analysisMeshUrl: `/api/volume-mesh?jobId=${jobId}&surface=analysis`,
        baseMeshUrl: `/api/volume-mesh?jobId=${jobId}&surface=base`,
        analysisGridUrl: `/api/volume-grid?jobId=${jobId}&surface=analysis`,
        baseGridUrl: `/api/volume-grid?jobId=${jobId}&surface=base`,
      }),
    });
  });

  page.route('**/api/volume-grid?*surface=analysis*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analysis.grid) });
  });
  page.route('**/api/volume-grid?*surface=base*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(base.grid) });
  });
  page.route('**/api/volume-mesh?*surface=analysis*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analysis.mesh) });
  });
  page.route('**/api/volume-mesh?*surface=base*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(base.mesh) });
  });
  page.route('**/api/volume-report-view-snapshot', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        jobId,
        reportPdfUrl: `/api/download-volume-job?jobId=${jobId}&artifact=report-pdf`,
      }),
    });
  });
  page.route('**/api/download-volume-job?*artifact=report-pdf*', async route => {
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="fake-volume-report.pdf"',
      },
      body: '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF',
    });
  });
}

function createBrowser(require) {
  return require(resolvePlaywrightModule(ROOT)).chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

test('viewer can open BEL-JOEL project and enter boundary drawing mode', async () => {
  const server = await startViewerServer({ rootDir: ROOT });
  const require = createRequire(import.meta.url);
  const browser = await createBrowser(require);

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const pageErrors = [];
    const resourceErrors = [];
    page.on('pageerror', err => pageErrors.push(`pageerror:${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        pageErrors.push(`console:${msg.text()}`);
      }
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      const url = response.url();
      if (/favicon\.ico|apple-touch-icon|\/scan-data\/.+\/(params|transforms)\.json/i.test(url)) return;
      resourceErrors.push(`${response.status()}:${url}`);
    });

    await openBelJoelVolumePanel(page, server.baseUrl);
    await page.locator('#btn-volume-start').click();
    await page.waitForFunction(() => {
      const meta = document.getElementById('volume-panel-meta');
      return meta && /Drawing|正在绘制/.test(meta.textContent || '');
    }, null, { timeout: 10000 });

    const note = await page.locator('#volume-panel-note').textContent();
    const meta = await page.locator('#volume-panel-meta').textContent();
    const cloudCount = await page.locator('#cnt-clouds').textContent();

    assert.ok(Number(cloudCount) >= 1, 'expected at least one cloud after opening BEL-JOEL');
    assert.match(meta || '', /Drawing|正在绘制/);
    assert.match(note || '', /boundary|工作区|workspace/i);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(resourceErrors, []);
  } finally {
    await browser.close();
    await server.stop();
  }
});

test('volume workspace renders the simplified inspector and preserves surface/tree actions', async () => {
  const server = await startViewerServer({ rootDir: ROOT });
  const require = createRequire(import.meta.url);
  const browser = await createBrowser(require);

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const pageErrors = [];
    const resourceErrors = [];
    page.on('pageerror', err => pageErrors.push(`pageerror:${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        pageErrors.push(`console:${msg.text()}`);
      }
    });
    page.on('response', response => {
      if (response.status() < 400) return;
      const url = response.url();
      if (/favicon\.ico|apple-touch-icon|\/scan-data\/.+\/(params|transforms)\.json/i.test(url)) return;
      resourceErrors.push(`${response.status()}:${url}`);
    });

    installFakeVolumeRoutes(page);
    await openBelJoelVolumePanel(page, server.baseUrl);
    await drawVolumeRegion(page);

    await page.locator('.volume-workspace-card-v2').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(() => {
      const status = document.querySelector('.volume-status-badge');
      const reportBtn = document.querySelector('[data-action="export-report"]');
      return status && /Ready/i.test(status.textContent || '') && reportBtn && !reportBtn.disabled;
    }, null, { timeout: 30000 });

    const workspaceTitle = await page.locator('.volume-ws-title').textContent();
    const primaryLabel = await page.locator('.volume-primary-label').textContent();
    const drawerTitles = await page.locator('.volume-drawer-title').allTextContents();
    const cellSizeHint = await page.locator('.volume-inline-hint').textContent();
    const volumeSurfaceCountBeforeHide = await page.locator('.ti-name').filter({ hasText: 'Volume Surface' }).count();

    assert.match(workspaceTitle || '', /Volume Region/i);
    assert.match(primaryLabel || '', /Measured/i);
    assert.match(cellSizeHint || '', /Using recommended/i);
    assert.deepEqual(drawerTitles.slice(-2), ['Advanced settings', 'Contours']);
    assert.ok(volumeSurfaceCountBeforeHide >= 2, 'expected auto-loaded volume surfaces in the scene tree');

    await page.locator('[data-drawer="surfaces"] > summary').click();
    await page.locator('[data-action="hide-all-surfaces"]').click();
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('.ti-name')].filter(node => /Volume Surface/.test(node.textContent || '')).length === 0;
    }, null, { timeout: 10000 });

    await page.locator('[data-action="show-primary-surface"]').click();
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('.ti-name')].filter(node => /Volume Surface/.test(node.textContent || '')).length >= 1;
    }, null, { timeout: 10000 });

    await page.locator('[data-action="show-both-surfaces"]').click();
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('.ti-name')].filter(node => /Volume Surface/.test(node.textContent || '')).length >= 2;
    }, null, { timeout: 10000 });

    await page.locator('[data-action="toggle-overlay"]').click();
    await page.locator('[data-drawer="advanced"] > summary').click();
    await page.locator('[data-drawer="contours"] > summary').click();
    await page.locator('[data-action="set-contour-source"][data-role="base"]').click();
    await page.locator('[data-action="gen-contours"]').click();
    await page.locator('[data-action="remove-contours"]').click();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-action="export-report"]').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /report/i);

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(resourceErrors, []);
  } finally {
    await browser.close();
    await server.stop();
  }
});
