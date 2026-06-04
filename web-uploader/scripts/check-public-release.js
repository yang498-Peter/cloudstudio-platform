import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(process.cwd(), '..');

const blockedPathPatterns = [
  /^memory\//,
  /^docs\/audit\//,
  /^docs\/product\//,
  /^docs\/staging-deploy-runbook\.md$/,
  /(^|\/)CloudStudio_.*\.(md|docx)$/i,
  /(^|\/)DEPLOY_SOP\.md$/i,
  /(^|\/)MIGRATION_WINDOWS_TO_SERVER\.md$/i,
  /^web-uploader\/CODEBASE_MAP\.md$/i,
  /^web-uploader\/STATE_MAP\.md$/i,
  /^web-uploader\/MEASUREMENT_SPLIT_PLAN\.md$/i,
  /\.(docx|dxf)$/i,
  /接入|交接|维护|开发计划|操作手册|项目/,
];

const publicDemoDomainPattern = /cloudstudio\.tersus-gnss\.com/i;

const blockedContentPatterns = [
  /PRIVATE_REPOSITORY_URL/i,
  /YOUR_PRIVATE_REPOSITORY_URL/i,
  /keep the repository private/i,
  /private GitHub repository/i,
  /share access through your organization/i,
  /docs\/staging-deploy-runbook\.md/i,
  /cloudstudio-new/i,
  /8\.209\.66\.134/,
  /47\.254\.151\.31/,
  /47\.253\.63\.0/,
  /198\.18\.0\.29/,
  /root@/,
  /IdentityFile\s*[= ]/i,
  /BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY/,
];

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.txt',
  '.yaml',
  '.yml',
]);

const contentSkipPatterns = [
  /^PotreeConverter\//,
  /^potree\//,
  /^web-uploader\/assets\/supersplat-editor\//,
  /^web-uploader\/assets\/i18n\//,
  /^web-uploader\/scripts\/check-public-release\.js$/,
  /^web-uploader\/scripts\/check-deploy-docs\.js$/,
];

function readLocalDenylistPatterns() {
  const denylistPath = path.join(repoRoot, '.cloudstudio-public-denylist');
  if (!fs.existsSync(denylistPath)) return [];
  const lines = fs.readFileSync(denylistPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  return lines.map(line => new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function listFiles() {
  const output = git(['ls-files', '--cached', '--others', '--exclude-standard']);
  return output.split(/\r?\n/).filter(Boolean);
}

function isBlockedPath(relativePath) {
  return blockedPathPatterns.some(pattern => pattern.test(relativePath));
}

function shouldScanContent(relativePath) {
  if (contentSkipPatterns.some(pattern => pattern.test(relativePath))) {
    return false;
  }
  const ext = path.extname(relativePath);
  if (!textExtensions.has(ext)) {
    return false;
  }
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return false;
  }
  return fs.statSync(absolutePath).size <= 1024 * 1024;
}

function allowsPublicDemoDomain(relativePath, content) {
  return relativePath === 'README.md'
    && content.includes('## Live Demo')
    && content.includes('The public demo is read-only for visitors.');
}

const files = listFiles();
const problems = [];
const localDenylistPatterns = readLocalDenylistPatterns();

for (const relativePath of files) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  if (isBlockedPath(relativePath)) {
    problems.push(`${relativePath}: blocked path for public release`);
    continue;
  }

  if (!shouldScanContent(relativePath)) {
    continue;
  }

  const content = fs.readFileSync(absolutePath, 'utf8');
  const patterns = [...blockedContentPatterns, ...localDenylistPatterns];
  if (!allowsPublicDemoDomain(relativePath, content)) {
    patterns.push(publicDemoDomainPattern);
  }

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      problems.push(`${relativePath}: blocked public-release marker ${pattern}`);
    }
  }
}

if (problems.length) {
  console.error('Public release safety check failed:');
  for (const problem of problems) {
    console.error(`- ${problem}`);
  }
  process.exit(1);
}

console.log('public release safety check passed');
