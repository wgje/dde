/**
 * 启动关键链路 Supabase 契约门禁
 *
 * 目标：
 * - 关键启动/恢复/认证链路禁止直接使用同步 client()
 * - 必须改用 clientAsync()/ensureClientReady()，避免 Deferred SDK 下的未就绪崩溃
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CHECK_FILES = [
  'src/app/shared/components/reset-password.component.ts',
  'src/app/core/services/sync/session-manager.service.ts',
  'src/services/app-lifecycle-orchestrator.service.ts',
  'src/services/auth.service.ts',
  'src/services/user-session.service.ts',
  'src/app/core/services/simple-sync.service.ts',
  'src/services/black-box-sync.service.ts',
  'src/app/core/services/sync/project-data.service.ts',
];

const FORBIDDEN_PATTERN = /\.client\s*\(\s*\)/g;

function fail(message) {
  console.error(`[check-supabase-ready-contract] ❌ ${message}`);
  process.exit(1);
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

const violations = [];

for (const relativeFile of CHECK_FILES) {
  const absoluteFile = path.join(ROOT, relativeFile);
  if (!fs.existsSync(absoluteFile)) {
    fail(`未找到检查文件: ${relativeFile}`);
  }

  const content = fs.readFileSync(absoluteFile, 'utf8');
  FORBIDDEN_PATTERN.lastIndex = 0;
  let match = FORBIDDEN_PATTERN.exec(content);
  while (match) {
    const line = getLineNumber(content, match.index);
    violations.push(`${relativeFile}:${line} 出现禁用调用 ".client()"`);
    match = FORBIDDEN_PATTERN.exec(content);
  }
}

if (violations.length > 0) {
  console.error('[check-supabase-ready-contract] ❌ 检测到关键链路使用同步 client()：');
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(
  `[check-supabase-ready-contract] ✅ 通过：${CHECK_FILES.length} 个关键文件均未使用同步 client()`
);
