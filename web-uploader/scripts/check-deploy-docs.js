import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(process.cwd(), '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertContains(relativePath, patterns) {
  const content = readRepoFile(relativePath);
  const missing = patterns.filter(pattern => !pattern.test(content));
  if (missing.length) {
    throw new Error(`${relativePath} is missing required deploy hardening markers: ${missing.map(String).join(', ')}`);
  }
}

function assertNotContains(relativePath, patterns) {
  const content = readRepoFile(relativePath);
  const present = patterns.filter(pattern => pattern.test(content));
  if (present.length) {
    throw new Error(`${relativePath} still contains retired deploy target references: ${present.map(String).join(', ')}`);
  }
}

assertContains('docs/staging-deploy-runbook.md', [
  /8\.209\.66\.134/,
  /staging\/demo/i,
  /cloudstudio-new/,
  /CLOUDSTUDIO_DATA_DIR/,
  /\/srv\/cloudstudio-data/,
  /pm2/i,
  /nginx/i,
  /\/health/,
  /backup/i,
  /rsync/i,
  /--exclude/,
  /rollback/i,
]);

assertContains('docs/dependency-audit.md', [
  /path-to-regexp/,
  /0\.1\.13/,
  /qs/,
  /6\.14\.2/,
  /npm audit --omit=dev --json/,
]);

assertContains('README.md', [
  /staging\/demo/i,
  /CLOUDSTUDIO_DATA_DIR/,
  /docs\/staging-deploy-runbook\.md/,
]);

assertNotContains('DEPLOY_SOP.md', [
  /47\.253\.63\.0/,
  /lidar361\.com/,
]);

console.log('deploy docs check passed');
