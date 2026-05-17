import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactServerPath,
  sanitizeManifestForClient,
  sanitizeSourceFileForClient,
  shouldExposeServerPaths,
} from '../lib/public-api-sanitize.js';

test('server path exposure is opt-in only', () => {
  assert.equal(shouldExposeServerPaths({}), false);
  assert.equal(shouldExposeServerPaths({ CLOUDSTUDIO_EXPOSE_SERVER_PATHS: 'true' }), true);
  assert.equal(redactServerPath('/opt/cloudstudio/web-uploader/.env', { expose: false }), null);
  assert.equal(redactServerPath('/opt/cloudstudio/data/colorized.las', { expose: false, basename: true }), 'colorized.las');
  assert.equal(redactServerPath('/opt/cloudstudio/data/colorized.las', { expose: true }), '/opt/cloudstudio/data/colorized.las');
});

test('source file sanitization removes absolute path fields by default', () => {
  const sanitized = sanitizeSourceFileForClient({
    name: 'colorized.las',
    relPath: 'colorized.las',
    absPath: '/srv/cloudstudio-data/projects/demo/colorized.las',
    sourcePath: '/srv/cloudstudio-data/projects/demo/colorized.las',
  }, { expose: false });

  assert.equal(sanitized.name, 'colorized.las');
  assert.equal(sanitized.relPath, 'colorized.las');
  assert.equal('absPath' in sanitized, false);
  assert.equal('sourcePath' in sanitized, false);
});

test('manifest sanitization keeps workflow metadata but removes local filesystem paths', () => {
  const sanitized = sanitizeManifestForClient({
    type: 'project-upload',
    scannerProjectId: 'scan-1',
    scanDataUrl: '/scan-data/scan-1',
    originalPath: '/srv/cloudstudio-data/projects/demo/colorized.las',
    projectDir: '/srv/cloudstudio-data/projects/demo',
    convertedInputPath: '/srv/cloudstudio-data/projects/demo/colorized_sanitized.las',
    sourceFiles: [{
      name: 'colorized.las',
      relPath: 'colorized.las',
      absPath: '/srv/cloudstudio-data/projects/demo/colorized.las',
    }],
  }, { expose: false });

  assert.equal(sanitized.type, 'project-upload');
  assert.equal(sanitized.scannerProjectId, 'scan-1');
  assert.equal(sanitized.scanDataUrl, '/scan-data/scan-1');
  assert.equal(sanitized.convertedInputFile, 'colorized_sanitized.las');
  assert.equal('originalPath' in sanitized, false);
  assert.equal('projectDir' in sanitized, false);
  assert.equal('convertedInputPath' in sanitized, false);
  assert.equal('absPath' in sanitized.sourceFiles[0], false);
});
