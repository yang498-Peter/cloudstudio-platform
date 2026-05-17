import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const allowedProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-boundary-allowed-'));

process.env.CLOUDSTUDIO_SKIP_SERVER_LISTEN = '1';
process.env.CLOUDSTUDIO_ALLOWED_PROJECT_ROOTS = allowedProjectRoot;
process.env.UPLOAD_REVIEW_PASSWORD_SHA256 = createHash('sha256').update('test-secret').digest('hex');

const {
  app,
  ensureExistingBoundedPath,
  requiresExplicitUploadPasswordEnv,
  resolveUploadPasswordHash,
  uploadCredentialJsonPrecheck,
  verifyUploadPassword,
} = await import('../server.js');

function runJsonCredentialMiddleware(req) {
  let jsonPayload = null;
  let statusCode = 200;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonPayload = payload;
      return this;
    },
  };
  uploadCredentialJsonPrecheck(req, res, () => {
    nextCalled = true;
  });
  return { status: statusCode, payload: jsonPayload, nextCalled };
}

test('production and forced environments do not silently use the built-in upload password hash', () => {
  assert.equal(requiresExplicitUploadPasswordEnv({ NODE_ENV: 'production' }), true);
  assert.equal(requiresExplicitUploadPasswordEnv({ NODE_ENV: 'staging' }), true);
  assert.equal(requiresExplicitUploadPasswordEnv({ CLOUDSTUDIO_REQUIRE_UPLOAD_PASSWORD_ENV: '1' }), true);
  assert.equal(resolveUploadPasswordHash({ NODE_ENV: 'production' }), '');
  assert.equal(resolveUploadPasswordHash({ CLOUDSTUDIO_REQUIRE_UPLOAD_PASSWORD_ENV: '1' }), '');
  assert.match(resolveUploadPasswordHash({ NODE_ENV: 'development' }), /^[a-f0-9]{64}$/);
  assert.throws(() => verifyUploadPassword('anything', ''), {
    code: 'UPLOAD_PASSWORD_NOT_CONFIGURED',
  });
});

test('scan project root registration route is guarded by upload credentials', () => {
  const registerRoute = app._router.stack.find(layer => layer.route?.path === '/api/scan-projects/register')?.route;
  assert.ok(registerRoute, 'register route should exist');
  assert.ok(
    registerRoute.stack.some(layer => layer.handle === uploadCredentialJsonPrecheck),
    'register route should include the upload credential middleware',
  );
});

test('scan project root write credential middleware rejects missing credentials', () => {
  const result = runJsonCredentialMiddleware({
    headers: {},
    query: {},
    body: { dirPath: allowedProjectRoot },
  });

  assert.equal(result.status, 403);
  assert.equal(result.nextCalled, false);
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.errorCode, 'UPLOAD_PASSWORD_REQUIRED');
});

test('scan project root write credential middleware accepts upload credentials', () => {
  const result = runJsonCredentialMiddleware({
    headers: { 'x-cloudstudio-upload-password': 'test-secret' },
    query: {},
    body: { dirPath: allowedProjectRoot },
  });

  assert.equal(result.status, 200);
  assert.equal(result.nextCalled, true);
  assert.equal(result.payload, null);
});

test('path boundary helper allows configured project roots and built-in grids only', () => {
  const insideDir = path.join(allowedProjectRoot, 'scan-a');
  const insideFile = path.join(insideDir, 'colorized.las');
  fs.mkdirSync(insideDir, { recursive: true });
  fs.writeFileSync(insideFile, 'las');

  assert.equal(
    ensureExistingBoundedPath(insideFile, { fieldName: 'lasPath', type: 'file' }),
    fs.realpathSync.native(insideFile),
  );

  const builtinGridReadme = path.resolve('assets/grids/builtin/README.md');
  assert.equal(
    ensureExistingBoundedPath(builtinGridReadme, { fieldName: 'gridPath', type: 'file' }),
    fs.realpathSync.native(builtinGridReadme),
  );

  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudstudio-boundary-denied-'));
  const outsideFile = path.join(outsideDir, 'secret.las');
  fs.writeFileSync(outsideFile, 'las');
  assert.throws(() => ensureExistingBoundedPath(outsideFile, { fieldName: 'lasPath', type: 'file' }), {
    code: 'STORAGE_BOUNDARY_VIOLATION',
  });
});
