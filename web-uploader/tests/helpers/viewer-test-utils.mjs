import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function resolvePlaywrightModule(startDir = process.cwd()) {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, 'node_modules', 'playwright', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not resolve a local playwright module by searching parent node_modules directories.');
}

export async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function waitForHttpOk(url, { timeoutMs = 60000, intervalMs = 400 } = {}) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError ? String(lastError.message || lastError) : 'unknown error'}`);
}

export async function startViewerServer({ rootDir, port = null } = {}) {
  const resolvedPort = port || await getFreePort();
  const env = {
    ...process.env,
    PORT: String(resolvedPort),
    PYTHON_BIN: path.join(rootDir, '.venv', 'bin', 'python'),
    PYTHON3_BIN: process.env.PYTHON3_BIN || 'python3',
  };
  const child = spawn('node', ['server.js'], {
    cwd: rootDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${resolvedPort}`;
  try {
    await waitForHttpOk(`${baseUrl}/health`, { timeoutMs: 90000 });
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`Viewer server failed to start on ${baseUrl}: ${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  }

  return {
    baseUrl,
    child,
    getLogs: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
