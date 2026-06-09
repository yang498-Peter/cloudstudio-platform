const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function defaultNow() {
  return new Date().toISOString();
}

function defaultIdFactory(type) {
  const prefix = String(type || 'job').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function clampProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function cloneValue(value) {
  if (value == null) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeError(error) {
  if (error == null) return null;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code || undefined,
    };
  }
  if (typeof error === 'string') return { message: error };
  return cloneValue(error);
}

function assertStatus(status) {
  if (!STATUSES.has(status)) {
    throw new Error(`Invalid job status: ${status}`);
  }
}

export function createProgressStore({
  now = defaultNow,
  idFactory = defaultIdFactory,
  maxEntries = 1000,
} = {}) {
  const jobs = new Map();
  const entryLimit = Math.max(1, Number.isFinite(Number(maxEntries)) ? Math.floor(Number(maxEntries)) : 1000);

  function timestamp() {
    return normalizeTimestamp(now());
  }

  function requireJob(id) {
    const job = jobs.get(id);
    if (!job) throw new Error(`Progress job not found: ${id}`);
    return job;
  }

  function pruneOldest() {
    while (jobs.size > entryLimit) {
      const oldestId = jobs.keys().next().value;
      jobs.delete(oldestId);
    }
  }

  function applyPatch(job, patch, updatedAt) {
    if (patch.type !== undefined) job.type = String(patch.type);
    if (patch.status !== undefined) {
      assertStatus(patch.status);
      job.status = patch.status;
    }
    if (patch.progress !== undefined) job.progress = clampProgress(patch.progress);
    if (patch.message !== undefined) job.message = String(patch.message || '');
    if (patch.result !== undefined) job.result = cloneValue(patch.result);
    if (patch.error !== undefined) job.error = normalizeError(patch.error);
    if (patch.meta !== undefined) job.meta = cloneValue(patch.meta) || {};
    if (patch.startedAt !== undefined) job.startedAt = patch.startedAt == null ? null : normalizeTimestamp(patch.startedAt);
    if (patch.finishedAt !== undefined) job.finishedAt = patch.finishedAt == null ? null : normalizeTimestamp(patch.finishedAt);

    if (job.status === 'running' && !job.startedAt) job.startedAt = updatedAt;
    if (TERMINAL_STATUSES.has(job.status) && !job.finishedAt) job.finishedAt = updatedAt;
    job.updatedAt = updatedAt;
    return job;
  }

  function createJob({
    id,
    type = 'job',
    meta = {},
    message = '',
    progress = 0,
    status = 'queued',
  } = {}) {
    assertStatus(status);
    const jobId = id == null ? idFactory(type) : String(id);
    if (!jobId) throw new Error('Progress job id is required');
    if (jobs.has(jobId)) throw new Error(`Progress job already exists: ${jobId}`);

    const createdAt = timestamp();
    const job = {
      id: jobId,
      type: String(type || 'job'),
      status,
      progress: clampProgress(progress),
      message: String(message || ''),
      createdAt,
      updatedAt: createdAt,
      startedAt: status === 'running' ? createdAt : null,
      finishedAt: TERMINAL_STATUSES.has(status) ? createdAt : null,
      result: null,
      error: null,
      meta: cloneValue(meta) || {},
    };

    jobs.set(job.id, job);
    pruneOldest();
    return cloneValue(job);
  }

  function getJob(id) {
    const job = jobs.get(id);
    return job ? cloneValue(job) : null;
  }

  function updateJob(id, patch = {}) {
    const job = requireJob(id);
    return cloneValue(applyPatch(job, patch, timestamp()));
  }

  function completeJob(id, { result = null, message = 'Completed', progress = 100 } = {}) {
    return updateJob(id, { status: 'completed', progress, message, result, error: null });
  }

  function failJob(id, { error = null, message = 'Failed' } = {}) {
    return updateJob(id, { status: 'failed', progress: 100, message, error });
  }

  function cancelJob(id, { message = 'Cancelled', error = null } = {}) {
    return updateJob(id, { status: 'cancelled', message, error });
  }

  function listJobs({ status, type } = {}) {
    if (status !== undefined) assertStatus(status);
    return Array.from(jobs.values())
      .filter(job => status === undefined || job.status === status)
      .filter(job => type === undefined || job.type === type)
      .map(cloneValue);
  }

  function clearJob(id) {
    return jobs.delete(id);
  }

  return {
    createJob,
    getJob,
    updateJob,
    completeJob,
    failJob,
    cancelJob,
    listJobs,
    clearJob,
  };
}
