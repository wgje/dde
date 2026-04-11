const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { buildDevServerUrl, resolveDevServerBinding } = require('./dev-server-port.cjs');

const args = process.argv.slice(2);
const nodeMajor = Number(process.versions.node.split('.')[0]);

function hasOption(argsToInspect, optionNames) {
  return argsToInspect.some((arg) => {
    return optionNames.some((optionName) => arg === optionName || arg.startsWith(`${optionName}=`));
  });
}

function isServeCommand(argsToInspect) {
  return argsToInspect.some((arg) => arg === 'serve');
}

async function prepareNgArgs(argsToInspect) {
  if (!isServeCommand(argsToInspect)) {
    return argsToInspect;
  }

  const binding = await resolveDevServerBinding({ args: argsToInspect, env: process.env });
  if (binding.unresolved) {
    console.error(
      `[run-ng] 默认开发端口 ${binding.port} 在当前机器上不可用（最后错误：${binding.lastErrorCode ?? 'UNKNOWN'}）。请设置 PORT 或 NANOFLOW_DEV_SERVER_PORT 后重试。`,
    );
    process.exit(1);
  }

  const resolvedArgs = [...argsToInspect];

  if (!hasOption(argsToInspect, ['--port', '-p'])) {
    resolvedArgs.push(`--port=${binding.port}`);
  }

  if (!hasOption(argsToInspect, ['--host', '-H']) && binding.hostSource !== 'default') {
    resolvedArgs.push(`--host=${binding.host}`);
  }

  if (binding.fallbackApplied) {
    console.warn(
      `[run-ng] 默认开发端口 3000 当前不可用（${binding.lastErrorCode ?? 'UNKNOWN'}），已自动回退到 ${buildDevServerUrl(binding)}。如需固定端口，请设置 PORT 或 NANOFLOW_DEV_SERVER_PORT。`,
    );
  }

  return resolvedArgs;
}

function resolveDependencyPath(...segments) {
  let currentDir = path.join(__dirname, '..');

  while (true) {
    const candidate = path.join(currentDir, 'node_modules', ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.join(__dirname, '..', 'node_modules', ...segments);
}

const ngPath = resolveDependencyPath('@angular', 'cli', 'bin', 'ng.js');

/**
 * 使用异步 spawn 启动子进程并正确转发信号
 * 解决 spawnSync 在长时间运行时无法处理 SIGTERM/SIGINT 导致僵尸进程的问题
 */
/**
 * 防御性修正 esbuild 环境变量：
 * - ESBUILD_WORKER_THREADS="0" 在 Node 中是 truthy，会意外启用 worker_threads 分支
 * - 已观察到该配置会触发 esbuild 死锁（all goroutines are asleep - deadlock）
 */
function buildChildEnv() {
  const childEnv = { ...process.env };
  const workerThreads = childEnv.ESBUILD_WORKER_THREADS;
  if (workerThreads === '0' || workerThreads === 'false') {
    delete childEnv.ESBUILD_WORKER_THREADS;
    console.warn(
      `[run-ng] 检测到 ESBUILD_WORKER_THREADS=${workerThreads}，已自动移除以避免 esbuild 死锁。`
    );
  }
  return childEnv;
}

function runWithSignalForwarding(nodeBin, scriptArgs) {
  const childEnv = buildChildEnv();
  const startedAt = Date.now();
  const isBuildCommand = scriptArgs.some((arg) => arg === 'build');
  const heartbeatIntervalMs = Number(process.env.RUN_NG_HEARTBEAT_INTERVAL_MS || 8000);

  // Windows 下 .cmd/.bat 文件必须通过 shell 执行，否则 Node 24 会抛出 EINVAL
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(nodeBin);
  const child = spawn(nodeBin, scriptArgs, {
    stdio: 'inherit',
    env: childEnv,
    ...(needsShell ? { shell: true } : {}),
  });

  let heartbeatTimer = null;
  if (!process.stdout.isTTY && isBuildCommand && Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      console.log(`[run-ng] 构建仍在进行中... ${elapsedSec}s`);
    }, heartbeatIntervalMs);
    // 不阻止进程退出
    if (typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref();
    }
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  // 转发终止信号到子进程，确保 ng serve / esbuild 能正确清理退出
  const forwardSignal = (sig) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(sig => process.on(sig, () => forwardSignal(sig)));

  child.on('exit', (code, signal) => {
    stopHeartbeat();

    if (code !== 0 || signal) {
      const elapsedMs = Date.now() - startedAt;
      console.error(
        `[run-ng] ng 进程异常退出: code=${code ?? 'null'}, signal=${signal ?? 'none'}, elapsed=${elapsedMs}ms`
      );
    }

    // 子进程退出后，父进程也退出
    if (code !== null) {
      process.exit(code);
    }
    // 被信号终止时，以非零码退出
    process.exit(signal ? 1 : 0);
  });

  child.on('error', (err) => {
    stopHeartbeat();
    console.error(`[run-ng] 子进程启动失败: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Node 24+ 与 Angular CLI 19.x 存在兼容性问题（Angular CLI 标记 Node 24 为 Unsupported）。
 * 即使 esbuild >= 0.23.0，在 Node 24 下仍会出现 goroutine 死锁。
 * 强制在 Node 24+ 环境下使用 Node 22 运行构建，确保稳定性。
 */
async function main() {
  const resolvedArgs = await prepareNgArgs(args);

  if (Number.isFinite(nodeMajor) && nodeMajor >= 24) {
    // Node 24+ 与 Angular CLI 19.x 不兼容，强制使用 Node 22
    let node22Path = null;

    // 方法1：检查 nvm (Linux/macOS) 安装的 Node 22
    const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
    const nvmNode22Versions = path.join(nvmDir, 'versions', 'node');
    if (fs.existsSync(nvmNode22Versions)) {
      const versions = fs.readdirSync(nvmNode22Versions).filter(v => v.startsWith('v22.'));
      if (versions.length > 0) {
        versions.sort().reverse();
        node22Path = path.join(nvmNode22Versions, versions[0], 'bin', 'node');
        if (!fs.existsSync(node22Path)) node22Path = null;
      }
    }

    // 方法2：使用 npx 下载并运行 Node 22（作为后备）
    if (!node22Path) {
      console.log('[run-ng] Node 24+ 检测到（Angular CLI 不支持），使用 npx node@22 运行构建...');
      const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      runWithSignalForwarding(npxCmd, ['-y', 'node@22.14.0', '--', ngPath, ...resolvedArgs]);
      return;
    }

    console.log(`[run-ng] Node 24+ 检测到（Angular CLI 不支持），使用本地 Node 22: ${node22Path}`);
    runWithSignalForwarding(node22Path, [ngPath, ...resolvedArgs]);
    return;
  }

  runWithSignalForwarding(process.execPath, [ngPath, ...resolvedArgs]);
}

main().catch((err) => {
  console.error(`[run-ng] 启动前准备失败: ${err.message}`);
  process.exit(1);
});
