import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createLongJobRegistry,
  readJobStatusFile,
  runCommandWithTimeout,
  writeJobStatusFile,
} from '../lib/long-job-state.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-long-job-'));
}

test('long job registry persists status transitions', () => {
  const root = makeTempDir();
  const registry = createLongJobRegistry({ dir: root });
  const job = registry.create('potree-conversion', {
    timeoutMs: 1000,
    metadata: { cloudName: 'demo' },
  });

  assert.equal(job.status, 'queued');
  assert.equal(job.stage, 'queued');

  const running = registry.update(job.jobId, {
    status: 'running',
    stage: 'convert',
    message: 'Converting LAS to Potree',
  });
  assert.equal(running.status, 'running');
  assert.equal(running.stage, 'convert');
  assert.ok(running.startedAt);

  const failed = registry.update(job.jobId, {
    status: 'timed_out',
    stage: 'timeout',
    errorCode: 'CONVERSION_TIMEOUT',
    error: 'Timed out',
  });
  assert.equal(failed.status, 'timed_out');
  assert.equal(failed.errorCode, 'CONVERSION_TIMEOUT');
  assert.ok(failed.finishedAt);

  const manifest = readJobStatusFile(path.join(root, `${job.jobId}.json`));
  assert.equal(manifest.status, 'timed_out');
  assert.equal(manifest.metadata.cloudName, 'demo');
});

test('status file helper normalizes a standalone manifest', () => {
  const root = makeTempDir();
  const filePath = path.join(root, 'status.json');
  writeJobStatusFile(filePath, {
    jobId: 'vol_123',
    kind: 'volume-job',
    status: 'succeeded',
    stage: 'complete',
  });

  const status = readJobStatusFile(filePath);
  assert.equal(status.jobId, 'vol_123');
  assert.equal(status.kind, 'volume-job');
  assert.equal(status.status, 'succeeded');
  assert.equal(status.stage, 'complete');
});

test('runCommandWithTimeout reports timed out child processes', async () => {
  const result = await runCommandWithTimeout(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 5000)'],
    { timeoutMs: 25 },
  );

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, 'PROCESS_TIMEOUT');
  assert.equal(result.error.timeoutMs, 25);
});
