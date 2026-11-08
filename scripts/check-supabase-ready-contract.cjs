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

// Only these two calls are availability probes: both immediately catch a
// synchronous-client construction failure and return a safe readiness value.
// Any other `.client()` occurrence remains forbidden by this gate.
const ALLOWED_AVAILABILITY_PROBES = new Map([
  [
    'src/app/core/services/sync/session-manager.service.ts',
    /^try \{ client = this\.supabase\.client\(\); \} catch \{ \/\* client remains unavailable \*\/ \}$/,
  ],
  [
    'src/services/auth.service.ts',
    /^try \{ this\.supabase\.client\(\); return true; \} catch \{ return false; \}$/,
  ],
]);

function fail(message) {
  console.error(`[check-supabase-ready-contract] ❌ ${message}`);
  process.exit(1);
}

function getLineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function isAllowedAvailabilityProbe(relativeFile, content, matchIndex) {
  const pattern = ALLOWED_AVAILABILITY_PROBES.get(relativeFile);
  if (!pattern) return false;

  const lineStart = content.lastIndexOf('\n', matchIndex) + 1;
  const lineEnd = content.indexOf('\n', matchIndex);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();
  return pattern.test(line);
}

function collectViolations(root = ROOT, checkFiles = CHECK_FILES) {
  const violations = [];

  for (const relativeFile of checkFiles) {
    const absoluteFile = path.join(root, relativeFile);
    if (!fs.existsSync(absoluteFile)) {
      throw new Error(`未找到检查文件: ${relativeFile}`);
    }

    const content = fs.readFileSync(absoluteFile, 'utf8');
    FORBIDDEN_PATTERN.lastIndex = 0;
    let match = FORBIDDEN_PATTERN.exec(content);
    while (match) {
      if (!isAllowedAvailabilityProbe(relativeFile, content, match.index)) {
        const line = getLineNumber(content, match.index);
        violations.push(`${relativeFile}:${line} 出现禁用调用 ".client()"`);
      }
      match = FORBIDDEN_PATTERN.exec(content);
    }
  }

  return violations;
}

function parseCliOption(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(argument => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

if (require.main === module) {
  const root = parseCliOption('root') ?? ROOT;
  const files = parseCliOption('files');
  const checkFiles = files ? files.split(',').filter(Boolean) : CHECK_FILES;
  let violations;
  try {
    violations = collectViolations(root, checkFiles);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (violations.length > 0) {
    console.error('[check-supabase-ready-contract] ❌ 检测到关键链路使用同步 client()：');
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-supabase-ready-contract] ✅ 通过：${checkFiles.length} 个关键文件均未使用同步 client()`
  );
}

module.exports = {
  CHECK_FILES,
  collectViolations,
  isAllowedAvailabilityProbe,
};
