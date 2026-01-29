const { spawnSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const ngPath = path.join(__dirname, '..', 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const nodeMajor = Number(process.versions.node.split('.')[0]);

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
    // 设置 ESBUILD_BINARY_PATH 环境变量防止 esbuild 重新下载二进制
    const env = { ...process.env };
    
    const result = spawnSync(
      'npx',
      ['-y', 'node@22.14.0', '--', ngPath, ...args],
      { 
        stdio: 'inherit', 
        env,
        // 增加超时和 kill 信号处理
        killSignal: 'SIGTERM'
      }
    );
    process.exit(result.status ?? 1);
  }

  // 使用本地 Node 22
  console.log(`[run-ng] Node 24+ 检测到，使用本地 Node 22: ${node22Path}`);
  const result = spawnSync(node22Path, [ngPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(result.status ?? 1);
}

const result = spawnSync(process.execPath, [ngPath, ...args], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
