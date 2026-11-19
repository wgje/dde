'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');

class OverlayWorkerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OverlayWorkerError';
    Object.assign(this, details);
  }
}

class OverlayQueryWorkerPool {
  constructor({ root, scriptPath, size = 2, maxBufferBytes = 16 * 1024 * 1024, maxQueueSize = 32, env = process.env, onEvent = () => {} }) {
    if (!path.isAbsolute(root) || !path.isAbsolute(scriptPath)) throw new TypeError('overlay-worker-path-must-be-absolute');
    if (!Number.isInteger(size) || size < 1 || size > 8) throw new RangeError('overlay-worker-pool-size-invalid');
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1024) throw new RangeError('overlay-worker-max-buffer-invalid');
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 1024) throw new RangeError('overlay-worker-max-queue-invalid');
    if (!Number.isSafeInteger(maxQueueSize) || maxQueueSize < 1 || maxQueueSize > 1024) throw new RangeError('overlay-worker-max-queue-invalid');
    this.root = root;
    this.scriptPath = scriptPath;
    this.size = size;
    this.maxBufferBytes = maxBufferBytes;
    this.maxQueueSize = maxQueueSize;
    this.maxQueueSize = maxQueueSize;
    this.env = { ...env };
    this.onEvent = onEvent;
    this.workers = Array.from({ length: size }, (_, index) => this.makeWorker(index));
    this.queue = [];
    this.closed = false;
    this.nextRequestId = 1;
  }

  makeWorker(index) {
    return { index, child: null, stdoutBuffer: Buffer.alloc(0), stderrTail: '', busy: false, currentJob: null, killTimer: null };
  }

  prewarm(timeoutMs, metadata = {}) {
    return this.request(['--prewarm'], timeoutMs, { ...metadata, prewarm: true });
  }

  request(args, timeoutMs, metadata = {}) {
    if (this.closed) return Promise.reject(new OverlayWorkerError('overlay-worker-pool-closed', { failureClass: 'overlay-process-error' }));
    if (!Array.isArray(args) || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new OverlayWorkerError('overlay-worker-request-invalid'));
    }
    if (this.queue.length >= this.maxQueueSize) {
      const error = new OverlayWorkerError('overlay-worker-queue-full', {
        failureClass: 'overlay-worker-backpressure',
        queueDepth: this.queue.length,
        maxQueueSize: this.maxQueueSize,
      });
      this.emit('overlay-worker.backpressure', { queueDepth: this.queue.length, maxQueueSize: this.maxQueueSize });
      return Promise.reject(error);
    }
    const id = `${process.pid}:${this.nextRequestId++}:${crypto.randomBytes(4).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const job = { id, args, timeoutMs, metadata, resolve, reject, enqueuedAt: process.hrtime.bigint(), timer: null };
      this.queue.push(job);
      this.dispatch();
    });
  }

  dispatch() {
    if (this.closed) return;
    for (const worker of this.workers) {
      if (worker.busy || this.queue.length === 0) continue;
      if (!worker.child) this.spawnWorker(worker);
      if (!worker.child) continue;
      const job = this.queue.shift();
      this.send(worker, job);
    }
  }

  spawnWorker(worker) {
    if (this.closed || worker.child) return;
    const child = spawn(process.execPath, [this.scriptPath, '--worker', '--root', this.root], {
      cwd: path.dirname(this.root),
      env: { ...this.env, NANOFLOW_OVERLAY_SKIP_REFRESH: this.env.NANOFLOW_OVERLAY_SKIP_REFRESH ?? '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    worker.child = child;
    worker.stdoutBuffer = Buffer.alloc(0);
    worker.stderrTail = '';
    child.stdout.on('data', chunk => { if (worker.child === child) this.onStdout(worker, chunk); });
    child.stderr.on('data', chunk => {
      if (worker.child === child) worker.stderrTail = `${worker.stderrTail}${Buffer.from(chunk).toString('utf8')}`.slice(-16_384);
    });
    child.once('error', error => { if (worker.child === child) this.failWorker(worker, new OverlayWorkerError(`overlay-worker-spawn-failed: ${error.message}`, { failureClass: 'overlay-process-error', cause: error }), true); });
    child.once('close', (code, signal) => {
      if (worker.child !== child) return;
      const error = new OverlayWorkerError(`overlay-worker-exited: code=${code ?? 'null'} signal=${signal ?? 'none'}`, {
        failureClass: 'overlay-worker-exit', exitCode: code ?? null, signal: signal ?? null,
      });
      this.failWorker(worker, error, false);
    });
    this.emit('overlay-worker.spawn', { workerIndex: worker.index, pid: child.pid ?? null, root: this.root });
  }

  onStdout(worker, chunk) {
    worker.stdoutBuffer = Buffer.concat([worker.stdoutBuffer, Buffer.from(chunk)]);
    if (worker.stdoutBuffer.length > this.maxBufferBytes && worker.stdoutBuffer.indexOf(0x0a) < 0) {
      this.failWorker(worker, new OverlayWorkerError(`overlay-worker-output-exceeded-${this.maxBufferBytes}`, { failureClass: 'overlay-max-buffer' }), true);
      return;
    }
    while (true) {
      const newline = worker.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) return;
      const lineBytes = worker.stdoutBuffer.subarray(0, newline);
      worker.stdoutBuffer = worker.stdoutBuffer.subarray(newline + 1);
      if (lineBytes.length > this.maxBufferBytes) {
        this.failWorker(worker, new OverlayWorkerError(`overlay-worker-output-exceeded-${this.maxBufferBytes}`, { failureClass: 'overlay-max-buffer' }), true);
        return;
      }
      let response;
      try { response = JSON.parse(lineBytes.toString('utf8')); }
      catch (error) {
        this.failWorker(worker, new OverlayWorkerError(`overlay-worker-invalid-json: ${error.message}`, { failureClass: 'overlay-json-parse', cause: error }), true);
        return;
      }
      const job = worker.currentJob;
      if (!job || response?.id !== job.id) {
        this.failWorker(worker, new OverlayWorkerError('overlay-worker-response-id-mismatch', { failureClass: 'overlay-worker-protocol' }), true);
        return;
      }
      this.finishJob(worker, response, null, lineBytes.length + 1);
    }
  }

  send(worker, job) {
    worker.busy = true;
    worker.currentJob = job;
    job.workerPid = worker.child?.pid ?? null;
    job.dispatchedAt = process.hrtime.bigint();
    job.timer = setTimeout(() => {
      const error = new OverlayWorkerError(`NanoFlow overlay query timed out after ${job.timeoutMs}ms.`, {
        failureClass: 'overlay-timeout', timedOut: true, pid: job.workerPid,
        elapsedMs: Number(process.hrtime.bigint() - job.dispatchedAt) / 1e6,
        stderrTail: worker.stderrTail,
      });
      this.failWorker(worker, error, true);
    }, job.timeoutMs);
    worker.child.stdin.write(`${JSON.stringify({ id: job.id, args: job.args })}\n`, error => {
      if (!error || worker.currentJob !== job) return;
      this.failWorker(worker, new OverlayWorkerError(`overlay-worker-write-failed: ${error.message}`, { failureClass: 'overlay-process-error', cause: error }), true);
    });
  }

  finishJob(worker, response, error, responseBytes = 0) {
    const job = worker.currentJob;
    if (!job) return;
    worker.currentJob = null;
    worker.busy = false;
    if (job.timer) clearTimeout(job.timer);
    const elapsedMs = job.dispatchedAt
      ? Number(process.hrtime.bigint() - job.dispatchedAt) / 1e6
      : Number(process.hrtime.bigint() - job.enqueuedAt) / 1e6;
    if (error) {
      error.responseBytes = responseBytes;
      job.reject(error);
    } else if (!response || response.ok !== true || typeof response.outputText !== 'string') {
      job.resolve({
        ok: false,
        error: String(response?.error ?? 'overlay-worker-result-invalid'),
        failureClass: response?.error?.startsWith?.('overlay-current-') ? 'overlay-current-invalid' : 'overlay-worker-query-failed',
        profileEvents: Array.isArray(response?.profileEvents) ? response.profileEvents : [],
        responseBytes,
        elapsedMs,
        pid: job.workerPid,
        stderrTail: worker.stderrTail,
      });
    } else {
      job.resolve({
        ...response,
        responseBytes,
        elapsedMs,
        pid: job.workerPid,
        stderrTail: worker.stderrTail,
      });
    }
    this.emit('overlay-worker.response', {
      workerIndex: worker.index, requestId: job.id, scenarioId: job.metadata?.queryId ?? null,
      ok: !error && response?.ok === true, elapsedMs, responseBytes,
      cacheHit: response?.cacheHit ?? null, generationId: response?.generationId ?? null,
    });
    this.dispatch();
  }

  failWorker(worker, error, terminate = false) {
    const child = worker.child;
    const job = worker.currentJob;
    if (job?.timer) clearTimeout(job.timer);
    this.resetWorker(worker);
    if (child && terminate && child.exitCode === null && child.signalCode === null) {
      child.kill();
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.unref?.();
      }
    }
    if (job) {
      job.reject(error);
      this.emit('overlay-worker.response', {
        workerIndex: worker.index, requestId: job.id, scenarioId: job.metadata?.queryId ?? null,
        ok: false, failureClass: error.failureClass ?? 'overlay-worker-exit',
        elapsedMs: job.dispatchedAt ? Number(process.hrtime.bigint() - job.dispatchedAt) / 1e6 : null,
      });
    }
    this.dispatch();
  }

  resetWorker(worker) {
    if (worker.killTimer) clearTimeout(worker.killTimer);
    worker.killTimer = null;
    worker.child = null;
    worker.busy = false;
    worker.currentJob = null;
    worker.stdoutBuffer = Buffer.alloc(0);
    worker.stderrTail = '';
  }

  emit(event, data) {
    try { this.onEvent(event, data); } catch { /* Diagnostics must not break query handling. */ }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.reject(new OverlayWorkerError('overlay-worker-pool-closed', { failureClass: 'overlay-process-error' }));
    }
    for (const worker of this.workers) {
      if (worker.currentJob) {
        const job = worker.currentJob;
        if (job.timer) clearTimeout(job.timer);
        worker.currentJob = null;
        worker.busy = false;
        job.reject(new OverlayWorkerError('overlay-worker-pool-closed', { failureClass: 'overlay-process-error' }));
      }
      const child = worker.child;
      if (!child) continue;
      if (child.exitCode === null && child.signalCode === null) child.stdin.end();
      worker.killTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          killer.unref?.();
        }
      }, 1_000);
      worker.killTimer.unref?.();
    }
  }
}

module.exports = Object.freeze({ OverlayQueryWorkerPool, OverlayWorkerError });
