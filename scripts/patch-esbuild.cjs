const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

/**
 * 将 @angular/build 的 esbuild 指向根目录版本
 * 这样可以确保版本一致性（通过 npm overrides 统一版本）
 * 
 * Node 24+ 兼容性问题通过 run-ng.cjs 使用 Node 22 运行来解决
 */
const source = path.join(projectRoot, 'node_modules', 'esbuild');
const target = path.join(projectRoot, 'node_modules', '@angular', 'build', 'node_modules', 'esbuild');

try {
  if (!fs.existsSync(source)) {
    console.warn('[patch-esbuild] 未找到根目录 esbuild，跳过补丁。');
    process.exit(0);
  }

  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, 'dir');
  console.log('[patch-esbuild] 已将 @angular/build 的 esbuild 指向根目录版本。');
} catch (error) {
  console.error('[patch-esbuild] 补丁失败:', error);
  process.exit(1);
}
