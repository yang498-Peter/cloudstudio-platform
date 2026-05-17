import test from 'node:test';
import assert from 'node:assert/strict';

import { readLastJsonLine } from '../lib/job-result.js';

test('reads plain JSON from the last line', () => {
  const result = readLastJsonLine('noise\n{"ok":true,"count":3}\n');
  assert.deepEqual(result, { ok: true, count: 3 });
});

test('reads RESULT-prefixed JSON from the last line', () => {
  const result = readLastJsonLine('warning\nRESULT:{"ok":true,"segments":[1,2]}\n');
  assert.deepEqual(result, { ok: true, segments: [1, 2] });
});

test('returns null when no JSON result line exists', () => {
  assert.equal(readLastJsonLine('warning only\nTraceback line\n'), null);
});
