import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const VENV_PYTHON_BIN = process.platform === 'win32'
  ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
  : path.join(ROOT, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.PYTHON_BIN || process.env.PYTHON3_BIN || (fs.existsSync(VENV_PYTHON_BIN) ? VENV_PYTHON_BIN : 'python3');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'compute_volume_analysis.py');

function assertPythonRuntime() {
  try {
    execFileSync(PYTHON_BIN, ['--version'], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Expected usable Python runtime at ${PYTHON_BIN}: ${error.message}`);
  }
}

function hasPythonModules(modules) {
  try {
    const statement = `import ${modules.join(', ')}`;
    execFileSync(PYTHON_BIN, ['-c', statement], { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

test('unified volume job generates result and dual-surface artifacts from synthetic LAS', (t) => {
  assertPythonRuntime();
  if (!hasPythonModules(['laspy', 'numpy'])) {
    t.skip('requires Python modules: laspy, numpy');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-job-test-'));
  const lasPath = path.join(tempDir, 'synthetic.las');
  const outputDir = path.join(tempDir, 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'payload.json');

  const makeLasScript = `
import laspy
import numpy as np

header = laspy.LasHeader(point_format=3, version="1.2")
las = laspy.LasData(header)
xs = []
ys = []
zs = []
cls = []
for y in np.linspace(0.25, 3.75, 16):
    for x in np.linspace(0.25, 3.75, 16):
        xs.append(float(x))
        ys.append(float(y))
        # Slight mound centered near (2,2)
        z = 1.0 + max(0.0, 1.2 - ((x - 2.0) ** 2 + (y - 2.0) ** 2) * 0.25)
        zs.append(float(z))
        cls.append(2)
las.x = np.asarray(xs)
las.y = np.asarray(ys)
las.z = np.asarray(zs)
las.classification = np.asarray(cls, dtype=np.uint8)
las.write(${JSON.stringify(lasPath)})
`;
  execFileSync(PYTHON_BIN, ['-c', makeLasScript], { cwd: ROOT, stdio: 'pipe' });

  const payload = {
    jobId: 'vol_test',
    outputDir,
    lasPath,
    polygon: [
      { x: 0, y: 0, z: 1.0 },
      { x: 4, y: 0, z: 1.0 },
      { x: 4, y: 4, z: 1.0 },
      { x: 0, y: 4, z: 1.0 },
    ],
    resolution: 1.0,
    scenarioMode: 'plane_cut_fill',
    analysisSurface: {
      surfaceType: 'stockpile',
      aggregateMode: 'p80',
      pointFilterMode: 'all',
    },
    baseSurface: {
      mode: 'fixed',
      referenceHeight: 1.0,
    },
    holeFillMode: 'interpolate',
    fixedHeight: 1.0,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

  const stdout = execFileSync(PYTHON_BIN, [SCRIPT_PATH, payloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  assert.match(stdout, /RESULT:/);

  const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
  assert.equal(result.scenarioMode, 'plane_cut_fill');
  assert.equal(result.baseSurface.mode, 'fixed');
  assert.ok(result.volume.cutVolume > 0, 'expected positive cut volume');
  assert.equal(result.volume.fillVolume, 0);
  assert.equal(result.stats.effectiveCellCount, 16);
  assert.ok(result.diagnostic.resolutionRecommendation.recommendedResolution > 0);

  const expectedFiles = [
    'analysis_surface_mesh.json',
    'analysis_surface_grid.json',
    'base_surface_mesh.json',
    'base_surface_grid.json',
    'preview_analysis.png',
    'preview_base.png',
    'analysis_surface.obj',
    'base_surface.obj',
    'volume_report.pdf',
  ];
  for (const fileName of expectedFiles) {
    assert.ok(fs.existsSync(path.join(outputDir, fileName)), `missing ${fileName}`);
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('report-only volume rebuild accepts a viewport screenshot artifact', (t) => {
  assertPythonRuntime();
  if (!hasPythonModules(['laspy', 'numpy'])) {
    t.skip('requires Python modules: laspy, numpy');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-report-refresh-test-'));
  const lasPath = path.join(tempDir, 'synthetic.las');
  const outputDir = path.join(tempDir, 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'payload.json');

  const makeLasScript = `
import laspy
import numpy as np

header = laspy.LasHeader(point_format=3, version="1.2")
las = laspy.LasData(header)
xs = []
ys = []
zs = []
cls = []
for y in np.linspace(0.25, 3.75, 16):
    for x in np.linspace(0.25, 3.75, 16):
        xs.append(float(x))
        ys.append(float(y))
        z = 1.0 + max(0.0, 1.2 - ((x - 2.0) ** 2 + (y - 2.0) ** 2) * 0.25)
        zs.append(float(z))
        cls.append(2)
las.x = np.asarray(xs)
las.y = np.asarray(ys)
las.z = np.asarray(zs)
las.classification = np.asarray(cls, dtype=np.uint8)
las.write(${JSON.stringify(lasPath)})
`;
  execFileSync(PYTHON_BIN, ['-c', makeLasScript], { cwd: ROOT, stdio: 'pipe' });

  const payload = {
    jobId: 'vol_report_refresh_test',
    outputDir,
    lasPath,
    polygon: [
      { x: 0, y: 0, z: 1.0 },
      { x: 4, y: 0, z: 1.0 },
      { x: 4, y: 4, z: 1.0 },
      { x: 0, y: 4, z: 1.0 },
    ],
    resolution: 1.0,
    scenarioMode: 'plane_cut_fill',
    analysisSurface: {
      surfaceType: 'stockpile',
      aggregateMode: 'p80',
      pointFilterMode: 'all',
    },
    baseSurface: {
      mode: 'fixed',
      referenceHeight: 1.0,
    },
    holeFillMode: 'interpolate',
    fixedHeight: 1.0,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

  execFileSync(PYTHON_BIN, [SCRIPT_PATH, payloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const viewportPreviewPath = path.join(outputDir, 'viewer_snapshot.png');
  fs.copyFileSync(path.join(outputDir, 'preview_analysis.png'), viewportPreviewPath);

  const reportRefreshPayloadPath = path.join(tempDir, 'report-refresh.json');
  fs.writeFileSync(reportRefreshPayloadPath, JSON.stringify({
    reportOnly: true,
    outputPath: path.join(outputDir, 'volume_report.pdf'),
    resultPath: path.join(outputDir, 'result.json'),
    analysisPreviewPath: path.join(outputDir, 'preview_analysis.png'),
    basePreviewPath: path.join(outputDir, 'preview_base.png'),
    viewportPreviewPath,
  }, null, 2), 'utf8');

  const stdout = execFileSync(PYTHON_BIN, [SCRIPT_PATH, reportRefreshPayloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  assert.match(stdout, /"reportOnly":\s*true/);
  assert.ok(fs.existsSync(path.join(outputDir, 'volume_report.pdf')), 'expected refreshed report pdf');

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ground-fitted volume reports ground support when class-2 terrain is available', (t) => {
  assertPythonRuntime();
  if (!hasPythonModules(['laspy', 'numpy'])) {
    t.skip('requires Python modules: laspy, numpy');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-ground-fit-test-'));
  const lasPath = path.join(tempDir, 'groundfit.las');
  const outputDir = path.join(tempDir, 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'payload.json');

  const makeLasScript = `
import laspy
import numpy as np

header = laspy.LasHeader(point_format=3, version="1.2")
las = laspy.LasData(header)
xs = []
ys = []
zs = []
cls = []
for y in np.linspace(0.25, 3.75, 16):
    for x in np.linspace(0.25, 3.75, 16):
        xs.append(float(x))
        ys.append(float(y))
        ground = 0.2 + ((x + y) * 0.02)
        mound = max(0.0, 1.0 - ((x - 2.0) ** 2 + (y - 2.0) ** 2) * 0.20)
        zs.append(float(ground + mound))
        cls.append(2)
las.x = np.asarray(xs)
las.y = np.asarray(ys)
las.z = np.asarray(zs)
las.classification = np.asarray(cls, dtype=np.uint8)
las.write(${JSON.stringify(lasPath)})
`;
  execFileSync(PYTHON_BIN, ['-c', makeLasScript], { cwd: ROOT, stdio: 'pipe' });

  const payload = {
    jobId: 'vol_ground_fit_test',
    outputDir,
    lasPath,
    polygon: [
      { x: 0, y: 0, z: 0.2 },
      { x: 4, y: 0, z: 0.3 },
      { x: 4, y: 4, z: 0.35 },
      { x: 0, y: 4, z: 0.25 },
    ],
    resolution: 1.0,
    scenarioMode: 'ground_fit_volume',
    analysisSurface: {
      surfaceType: 'stockpile',
      aggregateMode: 'p80',
      pointFilterMode: 'exclude_vegetation',
    },
    baseSurface: {
      mode: 'ground',
      referenceHeight: 0.25,
    },
    holeFillMode: 'interpolate',
    fixedHeight: 0.25,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

  execFileSync(PYTHON_BIN, [SCRIPT_PATH, payloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
  assert.equal(result.scenarioMode, 'ground_fit_volume');
  assert.equal(result.baseSurface.mode, 'ground');
  assert.equal(result.diagnostic.baseSourceUsed, 'ground_class2_fit');
  assert.equal(result.diagnostic.usedGroundSupport, true);
  assert.ok(result.diagnostic.groundSupportRatio > 0.5);
  assert.ok(result.diagnostic.resolutionRecommendation.recommendedResolution > 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ground-fitted volume falls back to low-percentile terrain approximation when no class-2 support exists', (t) => {
  assertPythonRuntime();
  if (!hasPythonModules(['laspy', 'numpy'])) {
    t.skip('requires Python modules: laspy, numpy');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-ground-fallback-test-'));
  const lasPath = path.join(tempDir, 'groundfallback.las');
  const outputDir = path.join(tempDir, 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'payload.json');

  const makeLasScript = `
import laspy
import numpy as np

header = laspy.LasHeader(point_format=3, version="1.2")
las = laspy.LasData(header)
xs = []
ys = []
zs = []
cls = []
for y in np.linspace(0.25, 3.75, 16):
    for x in np.linspace(0.25, 3.75, 16):
        xs.append(float(x))
        ys.append(float(y))
        zs.append(float(0.3 + max(0.0, 0.8 - ((x - 2.0) ** 2 + (y - 2.0) ** 2) * 0.18)))
        cls.append(0)
las.x = np.asarray(xs)
las.y = np.asarray(ys)
las.z = np.asarray(zs)
las.classification = np.asarray(cls, dtype=np.uint8)
las.write(${JSON.stringify(lasPath)})
`;
  execFileSync(PYTHON_BIN, ['-c', makeLasScript], { cwd: ROOT, stdio: 'pipe' });

  const payload = {
    jobId: 'vol_ground_fallback_test',
    outputDir,
    lasPath,
    polygon: [
      { x: 0, y: 0, z: 0.3 },
      { x: 4, y: 0, z: 0.3 },
      { x: 4, y: 4, z: 0.3 },
      { x: 0, y: 4, z: 0.3 },
    ],
    resolution: 1.0,
    scenarioMode: 'ground_fit_volume',
    analysisSurface: {
      surfaceType: 'stockpile',
      aggregateMode: 'p80',
      pointFilterMode: 'exclude_vegetation',
    },
    baseSurface: {
      mode: 'ground',
      referenceHeight: 0.3,
    },
    holeFillMode: 'interpolate',
    fixedHeight: 0.3,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

  execFileSync(PYTHON_BIN, [SCRIPT_PATH, payloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
  assert.equal(result.scenarioMode, 'ground_fit_volume');
  assert.equal(result.baseSurface.mode, 'ground');
  assert.equal(result.diagnostic.baseSourceUsed, 'ground_quantile_fallback');
  assert.equal(result.diagnostic.usedGroundSupport, false);
  assert.ok(result.diagnostic.warnings.some(message => message.includes('low-percentile surface')));
  assert.ok(!result.diagnostic.warnings.some(message => message.includes('class 0')));
  assert.ok(result.diagnostic.resolutionRecommendation.recommendedResolution > 0);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ground-fitted volume uses local CSF when class-2 support is missing but enough local ground exists', (t) => {
  assertPythonRuntime();
  if (!hasPythonModules(['laspy', 'numpy', 'CSF'])) {
    t.skip('requires Python modules: laspy, numpy, CSF');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-local-csf-test-'));
  const lasPath = path.join(tempDir, 'local-csf.las');
  const outputDir = path.join(tempDir, 'job');
  fs.mkdirSync(outputDir, { recursive: true });
  const payloadPath = path.join(tempDir, 'payload.json');

  const makeLasScript = `
import laspy
import numpy as np

rng = np.random.default_rng(20260507)
header = laspy.LasHeader(point_format=3, version="1.2")
las = laspy.LasData(header)
n_ground = 6000
xg = rng.random(n_ground) * 20.0
yg = rng.random(n_ground) * 20.0
zg = rng.normal(0.0, 0.02, n_ground)
n_pile = 3000
xp = 7.0 + rng.random(n_pile) * 6.0
yp = 7.0 + rng.random(n_pile) * 6.0
r = np.sqrt((xp - 10.0) ** 2 + (yp - 10.0) ** 2)
zp = np.maximum(0.0, 2.5 - r * 0.45) + rng.normal(0.0, 0.04, n_pile)
las.x = np.concatenate([xg, xp])
las.y = np.concatenate([yg, yp])
las.z = np.concatenate([zg, zp])
las.classification = np.zeros(n_ground + n_pile, dtype=np.uint8)
las.write(${JSON.stringify(lasPath)})
`;
  execFileSync(PYTHON_BIN, ['-c', makeLasScript], { cwd: ROOT, stdio: 'pipe' });

  const payload = {
    jobId: 'vol_local_csf_test',
    outputDir,
    lasPath,
    polygon: [
      { x: 0, y: 0, z: 0 },
      { x: 20, y: 0, z: 0 },
      { x: 20, y: 20, z: 0 },
      { x: 0, y: 20, z: 0 },
    ],
    resolution: 0.5,
    scenarioMode: 'ground_fit_volume',
    analysisSurface: {
      surfaceType: 'stockpile',
      aggregateMode: 'p80',
      pointFilterMode: 'exclude_vegetation',
    },
    baseSurface: {
      mode: 'ground',
      referenceHeight: 0,
    },
    holeFillMode: 'interpolate',
    fixedHeight: 0,
  };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

  execFileSync(PYTHON_BIN, [SCRIPT_PATH, payloadPath], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
  assert.equal(result.scenarioMode, 'ground_fit_volume');
  assert.equal(result.baseSurface.mode, 'ground');
  assert.equal(result.diagnostic.baseSourceUsed, 'local_csf_fit');
  assert.equal(result.diagnostic.localCsfUsed, true);
  assert.ok(result.diagnostic.localCsfStats.groundPointCount > 0);
  assert.ok(result.diagnostic.warnings.some(message => message.includes('local CSF')));

  fs.rmSync(tempDir, { recursive: true, force: true });
});
