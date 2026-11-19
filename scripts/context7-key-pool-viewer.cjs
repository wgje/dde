#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('./context7-key-pool/state-store.cjs');
const { projectPublicStatus } = require('./context7-key-pool/status.cjs');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4179;
const REFRESH_INTERVAL_MS = 5_000;
const PAGE_PATH = path.join(__dirname, 'context7-key-pool-viewer.html');
const STATE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'),
  'NanoFlow',
  'context7-key-pool',
);
const TIME_ZONE = process.env.CONTEXT7_POOL_TIME_ZONE || 'UTC';

function resolvePort() {
  const raw = process.env.CONTEXT7_POOL_VIEWER_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^[0-9]+$/.test(raw)) throw new Error('viewer-port-invalid');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('viewer-port-invalid');
  return port;
}

function writeResponse(response, statusCode, contentType, body, nonce) {
  response.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': nonce
      ? `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function requestIsLocal(request, port) {
  if (request.headers.host !== `${HOST}:${port}`) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && parsed.hostname === HOST
      && parsed.port === String(port)
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
}

async function readPublicUsage(store) {
  const inspected = await store.inspectStored();
  const now = new Date();
  const projected = projectPublicStatus({
    state: inspected.state,
    health: inspected.health,
    reconciliation: inspected.reconciliation,
    now,
  });
  return {
    schemaVersion: 1,
    source: 'local-persistent-ledger',
    observedAt: now.toISOString(),
    periodId: projected.periodId ?? null,
    timeZone: projected.timeZone ?? TIME_ZONE,
    nextResetAt: projected.nextResetAt ?? null,
    quotaLimit: 950,
    stateHealth: projected.stateHealth,
    ledgerUpdatedAt: projected.updatedAt,
    routing: {
      mode: projected.mode,
      nextSlot: projected.activeSlot,
      reason: projected.anonymousReason,
    },
    accounts: projected.slots.map(slot => ({
      slot: slot.slot,
      attemptedCalls: slot.attemptedCalls,
      successfulCalls: slot.successfulCalls,
      status: slot.status,
      cooldownUntil: slot.cooldownUntil,
      lastErrorClass: slot.lastErrorClass,
    })),
  };
}

async function main() {
  const port = resolvePort();
  const store = createStateStore({ stateDir: STATE_DIR, lockWaitMs: 2_000 });
  const pageTemplate = fs.readFileSync(PAGE_PATH, 'utf8');
  const server = http.createServer({ maxHeaderSize: 8 * 1024, headersTimeout: 5_000, requestTimeout: 5_000 }, async (request, response) => {
    if (!requestIsLocal(request, port)) {
      writeResponse(response, 403, 'text/plain; charset=utf-8', 'Local access only.');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      writeResponse(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.');
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url || '/', `http://${HOST}:${port}`).pathname;
    } catch {
      writeResponse(response, 400, 'text/plain; charset=utf-8', 'Bad request.');
      return;
    }

    if (pathname === '/health') {
      writeResponse(response, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      return;
    }
    if (pathname === '/') {
      const nonce = crypto.randomBytes(18).toString('base64');
      const page = pageTemplate.replaceAll('__CSP_NONCE__', nonce);
      writeResponse(response, 200, 'text/html; charset=utf-8', request.method === 'HEAD' ? '' : page, nonce);
      return;
    }
    if (pathname === '/api/status') {
      try {
        const usage = await readPublicUsage(store);
        writeResponse(response, 200, 'application/json; charset=utf-8', request.method === 'HEAD' ? '' : JSON.stringify(usage));
      } catch {
        writeResponse(response, 503, 'application/json; charset=utf-8', JSON.stringify({ error: 'usage-unavailable' }));
      }
      return;
    }
    writeResponse(response, 404, 'text/plain; charset=utf-8', 'Not found.');
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.listen(port, HOST, () => {
    process.stdout.write(`Context7 本地用量页：http://${HOST}:${port}/\n刷新间隔：${REFRESH_INTERVAL_MS / 1000} 秒；只读读取本机持久状态。\n`);
  });

  const close = () => server.close(() => process.exit(0));
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch(error => {
  const safeMessage = error && error.message === 'viewer-port-invalid' ? 'viewer-port-invalid' : 'viewer-start-failed';
  process.stderr.write(`${safeMessage}\n`);
  process.exitCode = 1;
});
