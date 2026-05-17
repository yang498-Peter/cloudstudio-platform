import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FINAL_STATUSES = new Set(['succeeded', 'failed', 'timed_out', 'cancelled']);

export class LongJobTimeoutError extends Error {
  constructor(message, { timeoutMs, stdout = '', stderr = '' } = {}) {
    super(message);
    this.name = 'LongJobTimeoutError';
    this.code = 'PROCESS_TIMEOUT';
    this.timeoutMs = timeoutMs;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function createJobId(kind = 'job', now = Date.now()) {
  const safeKind = String(kind || 'job').replace(/[^a-zA-Z0-9_-]/g, '_') || 'job';
  return `${safeKind}_${now}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isFinalJobStatus(status) {
  return FINAL_STATUSES.has(String(status || ''));
}

export function normalizeJobRecord(record = {}, nowIso = new Date().toISOString()) {
  const createdAt = record.createdAt || nowIso;
  const updatedAt = record.updatedAt || nowIso;
  const normalized = {
    jobId: record.jobId || createJobId(record.kind || record.type || 'job'),
    kind: record.kind || record.type || 'job',
    status: record.status || 'queued',
    stage: record.stage || record.status || 'queued',
    message: record.message || '',
    error: record.error || null,
    errorCode: record.errorCode || null,
    timeoutMs: Number(record.timeoutMs) > 0 ? Number(record.timeoutMs) : null,
    createdAt,
    updatedAt,
    startedAt: record.startedAt || null,
    finishedAt: record.finishedAt || null,
    durationMs: Number.isFinite(Number(record.durationMs)) ? Number(record.durationMs) : null,
    metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
  };
  return { ...record, ...normalized };
}

export function writeJobStatusFile(filePath, record) {
  const normalized = normalizeJobRecord(record);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export function readJobStatusFile(filePath) {
  try {
    return normalizeJobRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export function createLongJobRegistry({
  dir,
  maxJobs = 100,
  now = () => new Date(),
} = {}) {
  if (!dir) throw new Error('createLongJobRegistry requires dir');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();

  const manifestPathFor = jobId => path.join(dir, `${jobId}.json`);

  const persist = (job) => {
    const persisted = writeJobStatusFile(manifestPathFor(job.jobId), job);
    jobs.set(persisted.jobId, persisted);
    prune();
    return persisted;
  };

  const loadFromDisk = (jobId) => {
    const loaded = readJobStatusFile(manifestPathFor(jobId));
    if (loaded) jobs.set(jobId, loaded);
    return loaded;
  };

  const listFromDisk = () => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => readJobStatusFile(path.join(dir, entry.name)))
      .filter(Boolean);
  };

  const prune = () => {
    const all = [...jobs.values(), ...listFromDisk()]
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const keep = new Set(all.slice(0, maxJobs).map(job => job.jobId));
    for (const jobId of jobs.keys()) {
      if (!keep.has(jobId)) jobs.delete(jobId);
    }
    for (const job of all.slice(maxJobs)) {
      try { fs.unlinkSync(manifestPathFor(job.jobId)); } catch {}
    }
  };

  return {
    create(kind, fields = {}) {
      const nowIso = now().toISOString();
      const job = normalizeJobRecord({
        jobId: fields.jobId || createJobId(kind, now().getTime()),
        kind,
        status: 'queued',
        stage: 'queued',
        createdAt: nowIso,
        updatedAt: nowIso,
        ...fields,
      }, nowIso);
      return persist(job);
    },

    update(jobId, patch = {}) {
      const current = jobs.get(jobId) || loadFromDisk(jobId);
      if (!current) return null;
      const nowIso = now().toISOString();
      const merged = {
        ...current,
        ...patch,
        updatedAt: nowIso,
      };
      if (patch.status === 'running' && !merged.startedAt) {
        merged.startedAt = nowIso;
      }
      if (isFinalJobStatus(patch.status) && !merged.finishedAt) {
        merged.finishedAt = nowIso;
      }
      if (merged.startedAt && merged.finishedAt) {
        const durationMs = Date.parse(merged.finishedAt) - Date.parse(merged.startedAt);
        if (Number.isFinite(durationMs) && durationMs >= 0) merged.durationMs = durationMs;
      }
      return persist(merged);
    },

    get(jobId) {
      return jobs.get(jobId) || loadFromDisk(jobId);
    },

    list({ limit = maxJobs } = {}) {
      const merged = new Map();
      for (const job of listFromDisk()) merged.set(job.jobId, job);
      for (const job of jobs.values()) merged.set(job.jobId, job);
      return [...merged.values()]
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
        .slice(0, limit);
    },
  };
}

export function runCommandWithTimeout(command, args = [], {
  cwd,
  env,
  timeoutMs = 0,
  windowsHide = true,
  killSignal = 'SIGKILL',
  onStdout,
  onStderr,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, env, windowsHide });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(killSignal); } catch {}
      }, Number(timeoutMs));
    }

    child.stdout?.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (onStdout) onStdout(text);
    });
    child.stderr?.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (onStderr) onStderr(text);
    });
    child.on('error', error => {
      error.stdout = stdout;
      error.stderr = stderr;
      finish(reject, error);
    });
    child.on('close', (code, signal) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        finish(resolve, {
          ok: false,
          timedOut: true,
          code: null,
          signal,
          stdout,
          stderr,
          durationMs,
          error: new LongJobTimeoutError(`Process timed out after ${timeoutMs}ms`, { timeoutMs, stdout, stderr }),
        });
        return;
      }
      finish(resolve, {
        ok: code === 0,
        timedOut: false,
        code,
        signal,
        stdout,
        stderr,
        durationMs,
      });
    });
  });
}
