const net = require('node:net');
const http = require('node:http');

const DEFAULT_DEV_SERVER_PORT = 3000;
const DEFAULT_DEV_SERVER_HOST = 'localhost';
const DEFAULT_DEV_SERVER_PROTOCOL = 'http';
const DEFAULT_PORT_SCAN_SPAN = 200;
const EXISTING_SERVER_ERROR_CODES = new Set(['EACCES', 'EADDRINUSE']);

function normalizePort(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const normalized = Number.parseInt(String(value), 10);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
    return null;
  }

  return normalized;
}

function normalizeHost(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeScanSpan(value) {
  const normalized = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(normalized) || normalized < 0) {
    return DEFAULT_PORT_SCAN_SPAN;
  }

  return normalized;
}

function parseOptionValue(args, optionNames) {
  let result = null;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    for (const optionName of optionNames) {
      if (current === optionName) {
        const nextValue = args[index + 1];
        if (typeof nextValue === 'string' && nextValue.length > 0) {
          result = nextValue;
        }
        continue;
      }

      const prefix = `${optionName}=`;
      if (current.startsWith(prefix)) {
        result = current.slice(prefix.length);
      }
    }
  }

  return result;
}

function readPortPreference(args, env) {
  const cliPort = normalizePort(parseOptionValue(args, ['--port', '-p']));
  if (cliPort !== null) {
    return { port: cliPort, source: 'cli' };
  }

  const envPort = normalizePort(env.NANOFLOW_DEV_SERVER_PORT ?? env.PORT);
  if (envPort !== null) {
    return { port: envPort, source: 'env' };
  }

  return { port: DEFAULT_DEV_SERVER_PORT, source: 'default' };
}

function readHostPreference(args, env) {
  const cliHost = normalizeHost(parseOptionValue(args, ['--host', '-H']));
  if (cliHost !== null) {
    return { host: cliHost, source: 'cli' };
  }

  const envHost = normalizeHost(env.NANOFLOW_DEV_SERVER_HOST ?? env.HOST);
  if (envHost !== null) {
    return { host: envHost, source: 'env' };
  }

  return { host: DEFAULT_DEV_SERVER_HOST, source: 'default' };
}

function toProbeHost(host) {
  return host === 'localhost' ? '127.0.0.1' : host;
}

function toBrowserHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    return '127.0.0.1';
  }

  return host;
}

function formatUrlHost(host) {
  return host.includes(':') && !host.startsWith('[')
    ? `[${host}]`
    : host;
}

function isIgnoredProbeErrorCode(errorCode) {
  return errorCode === 'EADDRNOTAVAIL' || errorCode === 'EAFNOSUPPORT';
}

function probeSingleHostAvailability({ host, port }) {
  return new Promise((resolve) => {
    const server = net.createServer();
    if (typeof server.unref === 'function') {
      server.unref();
    }

    server.once('error', (error) => {
      resolve({
        available: false,
        errorCode: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      });
    });

    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve({ available: true, errorCode: null }));
    });
  });
}

function probePortAvailability({ host, port }) {
  const probeHosts = host === 'localhost'
    ? ['127.0.0.1', '::1']
    : [toProbeHost(host)];

  return (async () => {
    for (const probeHost of probeHosts) {
      const result = await probeSingleHostAvailability({ host: probeHost, port });
      if (result.available || isIgnoredProbeErrorCode(result.errorCode)) {
        continue;
      }

      return result;
    }

    return { available: true, errorCode: null };
  })();
}

function looksLikeNanoFlowHtml(body) {
  return body.includes('__NANOFLOW_BOOT_FLAGS__')
    || body.includes('__NANOFLOW_STARTUP_TRACE__')
    || body.includes('__NANOFLOW_INITIAL_COLOR_MODE__');
}

function detectExistingNanoFlowServer({ host, port, timeoutMs = 250 }) {
  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const request = http.get({
      host: toBrowserHost(host),
      port,
      path: '/',
      timeout: timeoutMs,
      headers: {
        Accept: 'text/html',
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('close', () => resolveOnce(looksLikeNanoFlowHtml(body)));
      response.on('end', () => resolveOnce(looksLikeNanoFlowHtml(body)));
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => resolveOnce(false));
  });
}

async function resolveDevServerBinding(options = {}) {
  const args = Array.isArray(options.args) ? options.args : [];
  const env = options.env ?? process.env;
  const checkPortAvailability = options.checkPortAvailability ?? probePortAvailability;
  const checkExistingServer = options.checkExistingServer ?? detectExistingNanoFlowServer;
  const allowExistingNanoFlowServer = options.allowExistingNanoFlowServer === true;

  const portPreference = readPortPreference(args, env);
  const hostPreference = readHostPreference(args, env);
  const publicHost = toBrowserHost(hostPreference.host);

  if (portPreference.source !== 'default') {
    return {
      host: hostPreference.host,
      publicHost,
      port: portPreference.port,
      portSource: portPreference.source,
      hostSource: hostPreference.source,
      fallbackApplied: false,
      lastErrorCode: null,
      unresolved: false,
    };
  }

  const scanSpan = normalizeScanSpan(options.portScanSpan ?? env.NANOFLOW_DEV_SERVER_PORT_SCAN_SPAN);
  let lastErrorCode = null;

  for (let offset = 0; offset <= scanSpan; offset += 1) {
    const candidatePort = portPreference.port + offset;
    const result = await checkPortAvailability({ host: hostPreference.host, port: candidatePort });

    if (result.available) {
      return {
        host: hostPreference.host,
        publicHost,
        port: candidatePort,
        portSource: portPreference.source,
        hostSource: hostPreference.source,
        fallbackApplied: offset > 0,
        lastErrorCode,
        unresolved: false,
        reusedExistingServer: false,
      };
    }

    if (allowExistingNanoFlowServer && EXISTING_SERVER_ERROR_CODES.has(result.errorCode)) {
      const existingServerDetected = await checkExistingServer({ host: hostPreference.host, port: candidatePort });
      if (existingServerDetected) {
        return {
          host: hostPreference.host,
          publicHost,
          port: candidatePort,
          portSource: portPreference.source,
          hostSource: hostPreference.source,
          fallbackApplied: offset > 0,
          lastErrorCode: result.errorCode,
          unresolved: false,
          reusedExistingServer: true,
        };
      }
    }

    lastErrorCode = result.errorCode ?? 'UNKNOWN';
  }

  return {
    host: hostPreference.host,
    publicHost,
    port: portPreference.port,
    portSource: portPreference.source,
    hostSource: hostPreference.source,
    fallbackApplied: false,
    lastErrorCode,
    unresolved: true,
    reusedExistingServer: false,
  };
}

function buildDevServerUrl(binding) {
  const host = formatUrlHost(binding.publicHost ?? binding.host ?? DEFAULT_DEV_SERVER_HOST);
  return `${DEFAULT_DEV_SERVER_PROTOCOL}://${host}:${binding.port}`;
}

async function runCli() {
  const cliArgs = process.argv.slice(2);
  const emitJson = cliArgs.includes('--json');
  const allowExisting = cliArgs.includes('--allow-existing');
  const passthroughArgs = cliArgs.filter((arg) => arg !== '--json' && arg !== '--allow-existing');
  const binding = await resolveDevServerBinding({
    args: passthroughArgs,
    env: process.env,
    allowExistingNanoFlowServer: allowExisting,
  });

  if (binding.unresolved) {
    console.error(
      `[dev-server-port] 未能在 ${binding.port}-${binding.port + DEFAULT_PORT_SCAN_SPAN} 区间内找到可用端口，最后错误：${binding.lastErrorCode ?? 'UNKNOWN'}`,
    );
    process.exit(1);
  }

  const payload = {
    ...binding,
    url: buildDevServerUrl(binding),
  };

  if (emitJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  process.stdout.write(`${payload.url}\n`);
}

module.exports = {
  DEFAULT_DEV_SERVER_HOST,
  DEFAULT_DEV_SERVER_PORT,
  DEFAULT_PORT_SCAN_SPAN,
  buildDevServerUrl,
  detectExistingNanoFlowServer,
  probePortAvailability,
  resolveDevServerBinding,
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`[dev-server-port] 解析开发服务器端口失败: ${error.message}`);
    process.exit(1);
  });
}
