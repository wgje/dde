#!/usr/bin/env node
/**
 * Chrome DevTools Protocol 代理服务器
 * 将 CDP 请求转发到 Playwright Chromium
 */

const { chromium } = require('@playwright/test');
const http = require('http');
const url = require('url');

const PORT = process.env.CDP_PORT || 9222;
const CHROME_PATH = process.env.CHROME_PATH || 
  '/home/codespace/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';

let browser = null;

// 启动 Chromium 并获取 WebSocket 地址
async function initBrowser() {
  try {
    console.log(`[CDP Proxy] 启动 Chromium: ${CHROME_PATH}`);
    
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
    });
    
    const wsEndpoint = browser.wsEndpoint();
    console.log(`[CDP Proxy] Chromium WebSocket: ${wsEndpoint}`);
    
    return wsEndpoint;
  } catch (error) {
    console.error('[CDP Proxy] 错误:', error.message);
    process.exit(1);
  }
}

// 创建 HTTP 服务器代理
function createProxyServer(wsEndpoint) {
  const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    
    // 处理 /json/version 请求
    if (req.url === '/json/version') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        Browser: 'Chromium (from Playwright)',
        'Protocol-Version': '1.3',
        'User-Agent': 'Chromium',
        'V8-Version': '12.0.0',
        'WebKit-Version': '537.36',
        webSocketDebuggerUrl: wsEndpoint,
      }));
    }
    // 处理 /json 请求
    else if (req.url === '/json' || req.url === '/json/list') {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify([{
        description: 'Chromium (via Playwright)',
        devtoolsFrontendUrl: `chrome-devtools://devtools/bundled/inspector.html?ws=localhost:${PORT}/devtools/browser/default`,
        devtoolsFrontendUrlCompat: `chrome-devtools://devtools/bundled/inspector.html?ws=localhost:${PORT}/devtools/browser/default`,
        faviconUrl: 'https://chromium.org/favicon.ico',
        id: 'default',
        title: 'Chromium',
        type: 'page',
        url: 'about:blank',
        webSocketDebuggerUrl: wsEndpoint,
      }]));
    }
    // 其他请求返回 404
    else {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  
  return server;
}

// 启动代理服务器
async function startServer() {
  const wsEndpoint = await initBrowser();
  const server = createProxyServer(wsEndpoint);
  
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 监听地址: http://localhost:${PORT}`);
    console.log(`[CDP Proxy] WebSocket: ${wsEndpoint}`);
    console.log('[CDP Proxy] 启动完成 ✓');
  });
  
  // 优雅关闭
  process.on('SIGINT', async () => {
    console.log('[CDP Proxy] 关闭中...');
    if (browser) {
      await browser.close();
    }
    server.close();
    process.exit(0);
  });
}

startServer().catch(error => {
  console.error('[CDP Proxy] 启动失败:', error.message);
  process.exit(1);
});
