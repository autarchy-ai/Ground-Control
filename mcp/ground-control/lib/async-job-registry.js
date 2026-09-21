// Async job registry (gc_codex_job, issues #937 and #1473).
//
// Extracted from lib/close-issue.js under issue #1473. The generalized registry
// is a shared concern — reviews, preflight, and the long mechanical /implement
// actions — no longer specific to issue-close, and the 500-LOC gate (ADR-092)
// requires it live in its own module. lib.js remains the barrel every caller
// imports.
//
// Reviews, preflight, and the long mechanical /implement actions may outlive
// one MCP request. The shared registry decouples that work from the request
// while preserving the underlying result envelope exactly. Review jobs are
// cancellable because their child process receives the AbortSignal. Mechanical
// jobs explicitly opt out until their complete command/poll call graph honors
// abort; returning `cancelling` while work continues would be false.
//
// In-memory is sufficient: the MCP server is a single long-lived stdio process
// per workflow run, so the registry persists across the start + poll calls. If
// the server restarts, jobs are lost and poll returns `job_not_found` — the
// agent re-runs with the same logical-attempt key. Terminal jobs are retained
// for a bounded TTL, and total capacity is bounded without evicting live work.

import { createHash } from "node:crypto";
import { detectSensitiveBodyContent } from "./grc-legacy-compat-2.js";
import { FAILURE_MESSAGE_MAX, boundFailureDiagnostics, boundFailureMessage } from "./command-failure-diagnostics.js";

export const ASYNC_JOB_TTL_MS = 30 * 60 * 1000;
export const ASYNC_JOB_CAPACITY = 128;
export const ASYNC_JOB_ID_MAX = 80;
export const ASYNC_JOB_ID_RE = /^job-[a-z0-9]+-[a-z0-9]+$/;
export const ASYNC_JOB_IDEMPOTENCY_KEY_MAX = 128;
export const ASYNC_JOB_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// The default covers a default-capped codex child (CODEX_TIMEOUT_MS_DEFAULT, 20
// minutes) in a single wait; the maximum matches the hold gc_watch_sonar_analysis
// already performs and stays well under the 3,600,000 ms MCP_TOOL_TIMEOUT this
// repository configures (issue #1669).
export const ASYNC_JOB_WAIT_SECONDS_DEFAULT = 1500;
export const ASYNC_JOB_WAIT_SECONDS_MAX = 1800;

const _asyncJobs = new Map();
let _asyncJobSeq = 0;
let _asyncJobCapacity = ASYNC_JOB_CAPACITY;
let _asyncJobNow = Date.now;

function _reapExpiredAsyncJobs() {
  const now = _asyncJobNow();
  for (const [id, job] of _asyncJobs) {
    if (job.finishedAt != null && now - job.finishedAt > ASYNC_JOB_TTL_MS) {
      _asyncJobs.delete(id);
    }
  }
}

function _asyncJobNotFound() {
  return {
    ok: false,
    error: "job_not_found",
    message:
      `No active job matches that bounded handle. It may have expired after ${ASYNC_JOB_TTL_MS} ms, ` +
      "or the MCP server may have restarted. For a review-cycle job, refresh and reconcile the " +
      "authoritative issue thread before another attempt; otherwise follow the originating tool's retry contract.",
  };
}

function _safeAsyncJobError(error) {
  const raw = String(error?.message ?? error ?? "background job failed");
  if (detectSensitiveBodyContent(raw)) return "<redacted>";
  // Head-and-tail, not head-only (issue #1568): the head names the failure and
  // the tail carries the child-process state and output tails the failing tool
  // appended after it. The former head-only slice discarded all of the latter.
  return boundFailureMessage(raw, FAILURE_MESSAGE_MAX);
}

// Structured, bounded diagnostics a failing tool attached to its error. Subject
// to the same sensitive-content scrub as the message: a snapshot that trips it
// is dropped whole rather than partially redacted, because a diagnostics
// snapshot is supplementary and the message already states the failure.
function _safeAsyncJobDiagnostics(error) {
  const bounded = boundFailureDiagnostics(error?.diagnostics);
  if (bounded == null) return null;
  return detectSensitiveBodyContent(JSON.stringify(bounded)) ? null : bounded;
}

const _ASYNC_JOB_PROGRESS_PHASES = new Set(["completion", "policy"]);

// Sanitize a progress snapshot to numbers and a whitelisted phase name only, so
// no command text, child output, path, or environment value can ride along in
// the poll envelope (issue #1497).
function _boundAsyncJobProgress(snapshot) {
  if (snapshot == null || typeof snapshot !== "object") return null;
  const num = (value) => (Number.isFinite(value) ? value : 0);
  return {
    phase: _ASYNC_JOB_PROGRESS_PHASES.has(snapshot.phase) ? snapshot.phase : "gate",
    phase_started_ms: num(snapshot.phase_started_ms),
    last_activity_ms: num(snapshot.last_activity_ms),
    stdout_bytes: num(snapshot.stdout_bytes),
    stderr_bytes: num(snapshot.stderr_bytes),
  };
}

function _asyncJobEnvelope(job) {
  const base = {
    job_id: job.id,
    kind: job.kind,
    elapsed_ms: (job.finishedAt ?? _asyncJobNow()) - job.startedAt,
  };
  if (job.status === "running") {
    // A closed, bounded progress snapshot (issue #1497). It proves only what it
    // states — the current gate phase and the last observed child activity — so
    // a slow-but-healthy sweep is distinguishable from a dead job. It is not a
    // lease, cancellation proof, or liveness guarantee.
    return { ok: true, status: "running", ...base, ...(job.progress ? { progress: job.progress } : {}) };
  }
  if (job.status === "done") {
    return { ok: true, status: "done", ...base, result: job.result };
  }
  if (job.status === "cancelled") {
    return {
      ok: false,
      status: "cancelled",
      error: "job_cancelled",
      message: "The background job was cancelled before it completed.",
      ...base,
    };
  }
  return {
    ok: false,
    status: "failed",
    error: "job_failed",
    message: _safeAsyncJobError(job.error),
    ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
    ...base,
  };
}

function _validateAsyncJobOptions(options) {
  const {
    idempotencyKey = null,
    idempotencyNamespace = null,
    fingerprint = null,
    executionScope = null,
    singleFlight = false,
    cancellable = true,
    retryStaleResult = null,
  } = options ?? {};
  if (retryStaleResult != null && typeof retryStaleResult !== "function") {
    return {
      ok: false,
      error: "job_options_invalid",
      message: "retryStaleResult must be a function when provided.",
    };
  }
  if (idempotencyKey != null) {
    if (
      typeof idempotencyKey !== "string"
      || idempotencyKey.length > ASYNC_JOB_IDEMPOTENCY_KEY_MAX
      || !ASYNC_JOB_IDEMPOTENCY_KEY_RE.test(idempotencyKey)
      || typeof idempotencyNamespace !== "string"
      || idempotencyNamespace.length === 0
      || idempotencyNamespace.length > 512
      || typeof fingerprint !== "string"
      || !/^[a-f0-9]{64}$/.test(fingerprint)
    ) {
      return {
        ok: false,
        error: "job_idempotency_input_invalid",
        message: "Idempotent jobs require a bounded key, namespace, and SHA-256 fingerprint.",
      };
    }
  } else if (idempotencyNamespace != null || fingerprint != null) {
    return {
      ok: false,
      error: "job_idempotency_input_invalid",
      message: "An idempotency namespace or fingerprint requires an idempotency key.",
    };
  }
  if (
    executionScope != null
    && (
      typeof executionScope !== "string"
      || executionScope.length === 0
      || executionScope.length > 512
    )
  ) {
    return {
      ok: false,
      error: "job_execution_scope_invalid",
      message: "The execution scope must be a non-empty bounded string.",
    };
  }
  if (typeof singleFlight !== "boolean" || typeof cancellable !== "boolean") {
    return {
      ok: false,
      error: "job_options_invalid",
      message: "singleFlight and cancellable must be booleans.",
    };
  }
  return {
    ok: true,
    idempotencyKey,
    idempotencyNamespace,
    fingerprint,
    executionScope,
    singleFlight,
    cancellable,
    retryStaleResult,
  };
}

function _normalizedFingerprintValue(value) {
  if (Array.isArray(value)) {
    return value.map(_normalizedFingerprintValue);
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        // Explicit, deterministic code-unit ordering (S2871): this feeds a
        // fingerprint, so the order must be identical across hosts and locales.
        .sort((a, b) => {
          if (a < b) return -1;
          if (a > b) return 1;
          return 0;
        })
        .map((key) => [key, _normalizedFingerprintValue(value[key])]),
    );
  }
  return value;
}

export function asyncJobInputFingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(_normalizedFingerprintValue(value)))
    .digest("hex");
}

// Resolves an idempotency-keyed start against any existing job with the same
// key/namespace: an envelope to return immediately (reuse, or a fingerprint
// conflict), or null when startAsyncJob should create a new job because none
// matched or the match was evicted as stale.
function _resolveIdempotentAsyncJob(validated) {
  if (validated.idempotencyKey == null) return null;
  const existing = Array.from(_asyncJobs.values()).find((job) =>
    job.idempotencyKey === validated.idempotencyKey
    && job.idempotencyNamespace === validated.idempotencyNamespace,
  );
  if (!existing) return null;
  if (existing.fingerprint !== validated.fingerprint) {
    return {
      ok: false,
      error: "job_idempotency_conflict",
      message: "That idempotency key is already bound to different normalized input.",
    };
  }
  // A terminal job the caller flagged as stale (e.g. a watcher that ended
  // without a verdict) answers nothing on replay. Evict it so a fresh job
  // takes the same key/namespace slot instead of echoing the old envelope
  // forever within the TTL (issue #1695).
  const stale = existing.status === "done"
    && typeof validated.retryStaleResult === "function"
    && validated.retryStaleResult(existing.result);
  if (!stale) return _asyncJobEnvelope(existing);
  _asyncJobs.delete(existing.id);
  return null;
}

// Start one generic async job. `kind` is a stable label echoed in poll
// responses. Idempotent callers provide a server-derived fingerprint and
// namespace plus the caller-stable key for one logical attempt.
export function startAsyncJob(kind, runFn, options = {}) {
  if (typeof runFn !== "function") {
    throw new TypeError("startAsyncJob: runFn must be a function");
  }
  const validated = _validateAsyncJobOptions(options);
  if (!validated.ok) return validated;
  _reapExpiredAsyncJobs();

  const idempotent = _resolveIdempotentAsyncJob(validated);
  if (idempotent) return idempotent;

  if (validated.singleFlight && validated.executionScope != null) {
    const contended = Array.from(_asyncJobs.values()).some((job) =>
      job.status === "running" && job.executionScope === validated.executionScope,
    );
    if (contended) {
      return {
        ok: false,
        error: "job_execution_contended",
        message: "Another background mutation or verification attempt is active for this checkout.",
      };
    }
  }

  if (_asyncJobs.size >= _asyncJobCapacity) {
    return {
      ok: false,
      error: "job_capacity_exhausted",
      message: "The bounded background-job registry is full; wait for active work to finish and retry.",
    };
  }

  _asyncJobSeq += 1;
  const now = _asyncJobNow();
  const id = `job-${now.toString(36)}-${_asyncJobSeq.toString(36)}`;
  const controller = new AbortController();
  const job = {
    id,
    kind:
      typeof kind === "string" && kind.length > 0 && kind.length <= 80
        ? kind
        : "background",
    status: "running",
    startedAt: now,
    finishedAt: null,
    result: null,
    error: null,
    controller,
    cancellable: validated.cancellable,
    idempotencyKey: validated.idempotencyKey,
    idempotencyNamespace: validated.idempotencyNamespace,
    fingerprint: validated.fingerprint,
    executionScope: validated.executionScope,
    progress: null,
    diagnostics: null,
    waiters: new Set(),
  };
  _asyncJobs.set(id, job);
  const reportProgress = (snapshot) => {
    job.progress = _boundAsyncJobProgress(snapshot);
  };
  Promise.resolve()
    .then(() => runFn(controller.signal, reportProgress))
    .then((result) => {
      job.result = result;
      job.status = "done";
    })
    .catch((e) => {
      job.error = _safeAsyncJobError(e);
      job.diagnostics = _safeAsyncJobDiagnostics(e);
      job.status = controller.signal.aborted ? "cancelled" : "failed";
    })
    .finally(() => {
      job.finishedAt = _asyncJobNow();
      // Release before any further await so a waiter observes the terminal
      // envelope, never an intermediate state.
      const outstanding = job.waiters;
      job.waiters = new Set();
      for (const release of outstanding) release();
    });
  return _asyncJobEnvelope(job);
}

export function pollAsyncJob(jobId) {
  _reapExpiredAsyncJobs();
  if (
    typeof jobId !== "string"
    || jobId.length > ASYNC_JOB_ID_MAX
    || !ASYNC_JOB_ID_RE.test(jobId)
  ) {
    return _asyncJobNotFound();
  }
  const job = _asyncJobs.get(jobId);
  return job ? _asyncJobEnvelope(job) : _asyncJobNotFound();
}

// Hold one request open until the job is terminal, instead of charging the
// caller a full model turn per poll tick (issue #1669). The wait is released by
// the job's own terminal transition, so no status loop runs server-side either.
// `waitMs` bounds this request and nothing else: its expiry returns the ordinary
// running envelope while the job continues, and it is never a job deadline, TTL
// extension, retry, or cancellation.
export function awaitAsyncJob(jobId, waitMs = ASYNC_JOB_WAIT_SECONDS_DEFAULT * 1000) {
  if (!Number.isInteger(waitMs) || waitMs <= 0 || waitMs > ASYNC_JOB_WAIT_SECONDS_MAX * 1000) {
    return Promise.resolve({
      ok: false,
      error: "job_wait_invalid",
      message:
        "The bounded wait must be a positive whole number of milliseconds no greater than "
        + `${ASYNC_JOB_WAIT_SECONDS_MAX * 1000} (${ASYNC_JOB_WAIT_SECONDS_MAX} seconds).`,
    });
  }
  // pollAsyncJob owns handle validation and reaping, so an unknown, expired, or
  // already-terminal handle returns its exact envelope without waiting.
  const immediate = pollAsyncJob(jobId);
  const job = immediate.status === "running" ? _asyncJobs.get(jobId) : null;
  if (!job) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let timer = null;
    const settle = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      job.waiters.delete(settle);
      resolve(_asyncJobEnvelope(job));
    };
    job.waiters.add(settle);
    timer = setTimeout(settle, waitMs);
  });
}

// Cancel only jobs that declared and implement end-to-end AbortSignal support.
// Terminal calls are idempotent.
export function cancelAsyncJob(jobId) {
  _reapExpiredAsyncJobs();
  if (
    typeof jobId !== "string"
    || jobId.length > ASYNC_JOB_ID_MAX
    || !ASYNC_JOB_ID_RE.test(jobId)
  ) {
    return _asyncJobNotFound();
  }
  const job = _asyncJobs.get(jobId);
  if (!job) return _asyncJobNotFound();
  if (job.status !== "running") {
    return {
      ok: true,
      status: job.status,
      job_id: job.id,
      kind: job.kind,
      message: `The background job is already terminal (${job.status}); nothing to cancel.`,
    };
  }
  if (!job.cancellable) {
    return {
      ok: false,
      status: "running",
      error: "job_not_cancellable",
      job_id: job.id,
      kind: job.kind,
      message: "This job does not claim cancellation because its full execution path does not honor abort.",
    };
  }
  job.controller.abort();
  return {
    ok: true,
    status: "cancelling",
    job_id: job.id,
    kind: job.kind,
    message: "Abort signalled. Poll once more to confirm the cancelled state.",
  };
}

// Test-only: clear the registry between cases.
export function _resetAsyncJobsForTest() {
  for (const job of _asyncJobs.values()) {
    for (const release of job.waiters) release();
    job.waiters.clear();
  }
  _asyncJobs.clear();
  _asyncJobSeq = 0;
  _asyncJobCapacity = ASYNC_JOB_CAPACITY;
  _asyncJobNow = Date.now;
}

export function _setAsyncJobCapacityForTest(capacity) {
  _asyncJobCapacity = capacity;
}

export function _setAsyncJobClockForTest(clock) {
  _asyncJobNow = clock;
}
