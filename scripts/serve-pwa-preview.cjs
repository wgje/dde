const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function parseOptionValue(args, optionNames) {
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    for (const optionName of optionNames) {
      if (current === optionName) {
        const nextValue = args[index + 1];
        if (typeof nextValue === 'string' && nextValue.length > 0) {
          return nextValue;
        }
      }

      const prefix = `${optionName}=`;
      if (current.startsWith(prefix)) {
        return current.slice(prefix.length);
      }
    }
  }

  return null;
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PORT;
  }

  const normalized = Number.parseInt(String(value), 10);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
    throw new Error(`无效端口: ${value}`);
  }

  return normalized;
}

function normalizeHost(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return DEFAULT_HOST;
  }

  return value.trim();
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveStaticRoot(workspaceRoot = path.resolve(__dirname, '..')) {
  const browserRoot = path.join(workspaceRoot, 'dist', 'browser');
  if (fileExists(path.join(browserRoot, 'index.html'))) {
    return browserRoot;
  }

  const distRoot = path.join(workspaceRoot, 'dist');
  if (fileExists(path.join(distRoot, 'index.html'))) {
    return distRoot;
  }

  return browserRoot;
}

function send(response, statusCode, headers, body) {
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(body);
}

function decodeRequestPath(url) {
  const rawPath = String(url || '/').split(/[?#]/, 1)[0] || '/';
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return '/';
  }
}

function resolveSafeFilePath(staticRoot, requestPath) {
  const normalizedPath = requestPath.replace(/\\/g, '/');
  const relativePath = normalizedPath === '/'
    ? 'index.html'
    : normalizedPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(staticRoot, relativePath);
  const normalizedRoot = path.resolve(staticRoot);

  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null;
  }

  return resolvedPath;
}

function createPwaPreviewServer(options) {
  const staticRoot = path.resolve(options.staticRoot);
  const indexPath = path.join(staticRoot, 'index.html');

  return http.createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, { allow: 'GET, HEAD' }, '');
      return;
    }

    const requestPath = decodeRequestPath(request.url);
    const filePath = resolveSafeFilePath(staticRoot, requestPath);
    if (!filePath) {
      send(response, 403, { 'content-type': 'text/plain; charset=utf-8' }, 'Forbidden');
      return;
    }

    const targetPath = fileExists(filePath) ? filePath : indexPath;
    if (!fileExists(targetPath)) {
      send(response, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Build output not found');
      return;
    }

    const extension = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES.get(extension) || 'application/octet-stream';
    const body = request.method === 'HEAD' ? '' : fs.readFileSync(targetPath);
    send(response, 200, { 'content-type': contentType }, body);
  });
}

function runCli() {
  const args = process.argv.slice(2);
  const workspaceRoot = path.resolve(__dirname, '..');
  const port = normalizePort(parseOptionValue(args, ['--port', '-p']) || process.env.PORT);
  const host = normalizeHost(parseOptionValue(args, ['--host', '-H']) || process.env.HOST);
  const staticRoot = resolveStaticRoot(workspaceRoot);

  if (!fileExists(path.join(staticRoot, 'index.html'))) {
    console.error(`[serve-pwa-preview] 未找到生产构建产物: ${path.join(staticRoot, 'index.html')}`);
    console.error('[serve-pwa-preview] 请先运行 npm run build。');
    process.exit(1);
  }

  const server = createPwaPreviewServer({ staticRoot });
  server.listen(port, host, () => {
    console.log(`[serve-pwa-preview] serving ${staticRoot}`);
    console.log(`[serve-pwa-preview] http://${host}:${port}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  createPwaPreviewServer,
  resolveStaticRoot,
};

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    console.error(`[serve-pwa-preview] ${error.message}`);
    process.exit(1);
  }
}
