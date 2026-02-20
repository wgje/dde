const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const ngPath = path.join(__dirname, '..', 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const nodeMajor = Number(process.versions.node.split('.')[0]);

/**
 * 使用异步 spawn 启动子进程并正确转发信号
 * 解决 spawnSync 在长时间运行时无法处理 SIGTERM/SIGINT 导致僵尸进程的问题
 */
function runWithSignalForwarding(nodeBin, scriptArgs) {
  const child = spawn(nodeBin, scriptArgs, {
    stdio: 'inherit',
    env: process.env,
  });

  // 转发终止信号到子进程，确保 ng serve / esbuild 能正确清理退出
  const forwardSignal = (sig) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(sig => process.on(sig, () => forwardSignal(sig)));

  child.on('exit', (code, signal) => {
    // 子进程退出后，父进程也退出
    if (code !== null) {
      process.exit(code);
    }
    // 被信号终止时，以非零码退出
    process.exit(signal ? 1 : 0);
  });

  child.on('error', (err) => {
    console.error(`[run-ng] 子进程启动失败: ${err.message}`);
    process.exit(1);
  });
}

/**
 * Node 24+ 与 esbuild 存在 goroutine 通信问题，需要使用 Node 22 运行
 * 问题表现：构建时 esbuild 进程挂起，报 "goroutine chan receive" 错误
 */
if (Number.isFinite(nodeMajor) && nodeMajor >= 24) {
  // 尝试查找本地已安装的 Node 22
  let node22Path = null;
  
  // 方法1：检查 nvm 安装的 Node 22
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmNode22Versions = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmNode22Versions)) {
    const versions = fs.readdirSync(nvmNode22Versions).filter(v => v.startsWith('v22.'));
    if (versions.length > 0) {
      // 选择最新的 v22 版本
      versions.sort().reverse();
      node22Path = path.join(nvmNode22Versions, versions[0], 'bin', 'node');
      if (!fs.existsSync(node22Path)) node22Path = null;
    }
  }

  // 方法2：使用 npx 下载并运行 Node 22（作为后备）
  if (!node22Path) {
    console.log('[run-ng] Node 24+ 检测到，使用 npx node@22 运行构建...');
    runWithSignalForwarding('npx', ['-y', 'node@22.14.0', '--', ngPath, ...args]);
  } else {
    // 使用本地 Node 22
    console.log(`[run-ng] Node 24+ 检测到，使用本地 Node 22: ${node22Path}`);
    runWithSignalForwarding(node22Path, [ngPath, ...args]);
  }
} else {
  runWithSignalForwarding(process.execPath, [ngPath, ...args]);
}
