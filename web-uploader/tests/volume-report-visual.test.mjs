import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const PYTHON_BIN = path.join(ROOT, '.venv', 'bin', 'python');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'compute_volume_analysis.py');

test('volume report renders to a readable preview image', () => {
  let hasQlmanage = true;
  try {
    execFileSync('qlmanage', ['-h'], { stdio: 'ignore' });
  } catch {
    hasQlmanage = false;
  }
  if (!hasQlmanage) {
    test.skip('qlmanage is not available in this environment');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volume-report-visual-'));
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
    jobId: 'vol_visual_test',
    outputDir,
    lasPath,
    regionName: 'Visual Report Test',
    pointcloudName: 'Synthetic Test Cloud',
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

  const reportPath = path.join(outputDir, 'volume_report.pdf');
  assert.ok(fs.existsSync(reportPath), 'expected PDF report artifact');

  const renderDir = path.join(tempDir, 'preview');
  fs.mkdirSync(renderDir, { recursive: true });
  execFileSync('qlmanage', ['-t', '-s', '1200', '-o', renderDir, reportPath], { stdio: 'pipe' });

  const pngPath = path.join(renderDir, `${path.basename(reportPath)}.png`);
  assert.ok(fs.existsSync(pngPath), 'expected rendered report preview image');
  const stat = fs.statSync(pngPath);
  assert.ok(stat.size > 50_000, `expected preview image to be non-trivial, got ${stat.size} bytes`);

  const sipsOutput = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', pngPath], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const widthMatch = sipsOutput.match(/pixelWidth:\s+(\d+)/);
  const heightMatch = sipsOutput.match(/pixelHeight:\s+(\d+)/);
  assert.ok(widthMatch && heightMatch, 'expected sips to report preview dimensions');
  assert.ok(Number(widthMatch[1]) >= 800, 'expected report preview width to be readable');
  assert.ok(Number(heightMatch[1]) >= 1000, 'expected report preview height to be readable');

  fs.rmSync(tempDir, { recursive: true, force: true });
});
