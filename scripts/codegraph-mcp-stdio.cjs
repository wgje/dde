#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const rawArgs = process.argv.slice(2);
const packageSpec = rawArgs.shift();

if (!packageSpec || !packageSpec.startsWith('@colbymchenry/codegraph@')) {
  process.stderr.write('[codegraph-mcp-stdio] First argument must be a pinned @colbymchenry/codegraph package spec.\n');
  process.exit(2);
}

if (rawArgs.length === 0) {
  process.stderr.write('[codegraph-mcp-stdio] Missing codegraph command arguments.\n');
  process.exit(2);
}

const codegraphArgs = normalizeCodegraphArgs(rawArgs);
const child = spawnCodegraph(packageSpec, codegraphArgs);

const CHILD_TERMINATION_GRACE_MS = 2000;
let childExited = false;
let shuttingDown = false;
let childTerminationTimer = null;

let clientMode = null;
let stdinBuffer = Buffer.alloc(0);
let childStdoutBuffer = Buffer.alloc(0);
const pendingChildLines = [];
const clientOutputQueue = [];
const childInputQueue = [];
let clientStdoutBackpressured = false;
let childStdinBackpressured = false;

child.stderr.on('data', chunk => {
  process.stderr.write(chunk);
});

child.stdout.on('data', chunk => {
  childStdoutBuffer = Buffer.concat([
    childStdoutBuffer,
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'),
  ]);
  drainChildOutput();
});

child.on('error', error => {
  process.stderr.write(`[codegraph-mcp-stdio] Failed to start codegraph: ${error.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  childExited = true;
  clearChildTerminationTimer();
  const cleanExit = code === 0 && signal === null;
  if (shuttingDown && !cleanExit) {
    const normalizedCode = Number.isInteger(code) ? code : 'null';
    const normalizedSignal = typeof signal === 'string' && /^[A-Z0-9]+$/.test(signal) ? signal : 'null';
    process.stderr.write(`[codegraph-mcp-stdio] codegraph-child-shutdown-failure exitCode=${normalizedCode} signal=${normalizedSignal}\n`);
  } else if (signal) {
    process.stderr.write(`[codegraph-mcp-stdio] Codegraph exited from signal ${signal}.\n`);
  }
  process.exit(cleanExit ? 0 : (Number.isInteger(code) && code !== 0 ? code : 1));
});

child.stdin.on('error', error => {
  if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
    return;
  }
  process.stderr.write(`[codegraph-mcp-stdio] Codegraph stdin error: ${error.message}\n`);
});

process.stdin.on('data', chunk => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  drainClientInput();
});

process.stdin.on('end', () => {
  requestClientStdinShutdown();
});

process.stdin.on('close', () => {
  requestClientStdinShutdown();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdownAndExit();
  });
}

function requestClientStdinShutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  requestChildShutdown();
}

function requestChildShutdown() {
  if (childExited) {
    return;
  }

  try {
    child.stdin.end();
  } catch {
    // The child may already be tearing down; the termination timer below is the fallback.
  }

  if (!childTerminationTimer) {
    childTerminationTimer = setTimeout(() => {
      terminateChildTree(child.pid);
    }, CHILD_TERMINATION_GRACE_MS);
    childTerminationTimer.unref?.();
  }
}

function shutdownAndExit() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  requestChildShutdown();
  terminateChildTree(child.pid);
}

function terminateChildTree(pid) {
  if (!pid || childExited) {
    return;
  }

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Best effort. The wrapper will exit when the child exits or the host closes it.
      }
    });
    return;
  }

  try {
    child.kill('SIGTERM');
  } catch {
    // Best effort.
  }
}

function clearChildTerminationTimer() {
  if (!childTerminationTimer) {
    return;
  }
  clearTimeout(childTerminationTimer);
  childTerminationTimer = null;
}

function spawnCodegraph(packageSpecToRun, childArgs) {
  const npxArgs = ['-y', packageSpecToRun, ...childArgs];

  if (process.platform === 'win32') {
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', quoteCmdCommand(['npx', ...npxArgs])],
      createSpawnOptions(),
    );
  }

  return spawn('npx', npxArgs, createSpawnOptions());
}

function createSpawnOptions() {
  return {
    cwd: process.cwd(),
    env: createCodegraphChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function createCodegraphChildEnv() {
  const allowDaemon = process.env.NANOFLOW_CODEGRAPH_ALLOW_DAEMON === '1';
  return {
    ...process.env,
    CODEGRAPH_NO_DAEMON: allowDaemon ? (process.env.CODEGRAPH_NO_DAEMON ?? '0') : '1',
    CODEGRAPH_NO_WATCH: process.env.CODEGRAPH_NO_WATCH ?? '0',
    CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: process.env.CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS ?? '60000',
    CODEGRAPH_DAEMON_MAX_IDLE_MS: process.env.CODEGRAPH_DAEMON_MAX_IDLE_MS ?? '60000',
  };
}

function quoteCmdCommand(args) {
  return args.map(quoteCmdArg).join(' ');
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) {
    return text;
  }

  return `"${text
    .replace(/"/g, '\\"')
    .replace(/%/g, '^%')
    .replace(/[&|<>^]/g, '^$&')}"`;
}

function normalizeCodegraphArgs(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    normalized.push(arg);

    if ((arg === '--path' || arg === '-p') && index + 1 < args.length) {
      index += 1;
      normalized.push(normalizePath(args[index]));
    }
  }
  return normalized;
}

function normalizePath(value) {
  if (!value || value.includes('${')) {
    return value;
  }

  try {
    return fs.realpathSync.native(value);
  } catch {
    try {
      return fs.realpathSync(value);
    } catch {
      return value;
    }
  }
}

function drainClientInput() {
  while (stdinBuffer.length > 0) {
    if (!clientMode) {
      const prefix = stdinBuffer.toString('utf8', 0, Math.min(stdinBuffer.length, 128)).trimStart();
      if (prefix.startsWith('Content-Length:')) {
        clientMode = 'content-length';
        flushPendingChildLines();
      } else if (stdinBuffer.includes(0x0a)) {
        clientMode = 'newline';
        flushPendingChildLines();
      } else {
        return;
      }
    }

    if (clientMode === 'content-length') {
      if (!drainContentLengthMessage()) {
        return;
      }
      continue;
    }

    if (!drainLineMessage()) {
      return;
    }
  }
}

function drainContentLengthMessage() {
  const headerEnd = findHeaderEnd(stdinBuffer);
  if (!headerEnd) {
    return false;
  }

  const header = stdinBuffer.slice(0, headerEnd.index).toString('utf8');
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) {
    process.stderr.write(`[codegraph-mcp-stdio] Invalid MCP header: ${JSON.stringify(header)}\n`);
    process.exit(1);
  }

  const bodyLength = Number(match[1]);
  const bodyStart = headerEnd.index + headerEnd.length;
  const bodyEnd = bodyStart + bodyLength;
  if (stdinBuffer.length < bodyEnd) {
    return false;
  }

  const body = stdinBuffer.slice(bodyStart, bodyEnd).toString('utf8');
  stdinBuffer = stdinBuffer.slice(bodyEnd);
  return forwardToCodegraph(body);
}

function drainLineMessage() {
  const newlineIndex = stdinBuffer.indexOf(0x0a);
  if (newlineIndex === -1) {
    return false;
  }

  const line = stdinBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
  stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
  if (line.trim().length > 0) {
    return forwardToCodegraph(line);
  }
  return true;
}

function findHeaderEnd(buffer) {
  const crlfIndex = buffer.indexOf(Buffer.from('\r\n\r\n'));
  if (crlfIndex !== -1) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = buffer.indexOf(Buffer.from('\n\n'));
  if (lfIndex !== -1) {
    return { index: lfIndex, length: 2 };
  }

  return null;
}

function drainChildOutput() {
  if (clientStdoutBackpressured) {
    return false;
  }

  while (childStdoutBuffer.length > 0) {
    if (startsWithContentLengthHeader(childStdoutBuffer)) {
      if (!drainChildContentLengthMessage()) return;
      continue;
    }

    if (!drainChildLineMessage()) return;
  }

  return true;
}

function startsWithContentLengthHeader(buffer) {
  const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 64));
  return /^Content-Length:/i.test(prefix);
}

function drainChildContentLengthMessage() {
  const headerEnd = findHeaderEnd(childStdoutBuffer);
  if (!headerEnd) return false;

  const header = childStdoutBuffer.slice(0, headerEnd.index).toString('utf8');
  const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
  if (!match) {
    return drainChildLineMessage();
  }

  const bodyLength = Number(match[1]);
  const bodyStart = headerEnd.index + headerEnd.length;
  const bodyEnd = bodyStart + bodyLength;
  if (childStdoutBuffer.length < bodyEnd) return false;

  const body = childStdoutBuffer.slice(bodyStart, bodyEnd).toString('utf8');
  childStdoutBuffer = childStdoutBuffer.slice(bodyEnd);
  if (body.trim().length > 0) {
    return writeToClient(body);
  }
  return true;
}

function drainChildLineMessage() {
  const newlineIndex = childStdoutBuffer.indexOf(0x0a);
  if (newlineIndex === -1) return false;

  const line = childStdoutBuffer.slice(0, newlineIndex).toString('utf8').replace(/\r$/, '');
  childStdoutBuffer = childStdoutBuffer.slice(newlineIndex + 1);
  if (line.trim().length > 0) {
    return writeToClient(line);
  }
  return true;
}

function forwardToCodegraph(jsonText) {
  return writeToCodegraphStdin(`${jsonText.trim()}\n`);
}

function writeToCodegraphStdin(text) {
  if (childExited || child.stdin.destroyed || child.stdin.writableEnded) {
    return false;
  }

  childInputQueue.push(text);
  return flushChildInputQueue();
}

function flushChildInputQueue() {
  if (childStdinBackpressured) {
    return false;
  }

  if (childExited || child.stdin.destroyed || child.stdin.writableEnded) {
    return false;
  }

  try {
    while (childInputQueue.length > 0) {
      const text = childInputQueue.shift();
      const ok = child.stdin.write(text, error => {
        if (!error || error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') {
          return;
        }
        process.stderr.write(`[codegraph-mcp-stdio] Codegraph stdin write error: ${error.message}\n`);
      });

      if (!ok) {
        childStdinBackpressured = true;
        process.stdin.pause?.();
        child.stdin.once('drain', onChildStdinDrain);
        return false;
      }
    }
  } catch (error) {
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
      process.stderr.write(`[codegraph-mcp-stdio] Codegraph stdin write error: ${error.message}\n`);
    }
    return false;
  }

  return true;
}

function onChildStdinDrain() {
  childStdinBackpressured = false;
  const flushed = flushChildInputQueue();
  if (flushed && !clientStdoutBackpressured && !shuttingDown) {
    process.stdin.resume?.();
    drainClientInput();
  }
}

function writeToClient(line) {
  if (!clientMode) {
    pendingChildLines.push(line);
    return true;
  }

  clientOutputQueue.push(formatClientOutput(line));
  return flushClientOutputQueue();
}

function formatClientOutput(line) {
  if (clientMode === 'content-length') {
    const payload = Buffer.from(line, 'utf8');
    return Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'),
      payload,
    ]);
  }

  return Buffer.from(`${line}\n`, 'utf8');
}

function flushClientOutputQueue() {
  if (clientStdoutBackpressured) {
    return false;
  }

  while (clientOutputQueue.length > 0) {
    const chunk = clientOutputQueue.shift();
    const ok = process.stdout.write(chunk);
    if (!ok) {
      clientStdoutBackpressured = true;
      process.stdin.pause?.();
      child.stdout.pause?.();
      process.stdout.once('drain', onClientStdoutDrain);
      return false;
    }
  }

  return true;
}

function onClientStdoutDrain() {
  clientStdoutBackpressured = false;
  if (!flushClientOutputQueue()) {
    return;
  }

  if (childStdoutBuffer.length > 0 && !drainChildOutput()) {
    return;
  }

  if (!childStdinBackpressured && !shuttingDown) {
    process.stdin.resume?.();
  }
  child.stdout.resume?.();
}

function flushPendingChildLines() {
  while (pendingChildLines.length > 0) {
    writeToClient(pendingChildLines.shift());
  }
}
