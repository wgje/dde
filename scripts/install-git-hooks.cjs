#!/usr/bin/env node
/**
 * 安装 Git 钩子（pre-commit 密钥扫描）
 *
 * 关联：.copilot-tracking/plans/2026-04-16-comprehensive-remediation.md T0-2
 *
 * 策略：
 * - 在 `.git/hooks/pre-commit` 写入/更新钩子内容
 * - 已存在的钩子：若包含本脚本 marker，幂等替换；否则追加（不破坏用户自定义钩子）
 */

const fs = require('node:fs');
const path = require('node:path');

const MARKER_BEGIN = '# >>> dde/check-secrets BEGIN (do not edit)';
const MARKER_END = '# <<< dde/check-secrets END';

const HOOK_CONTENT = `${MARKER_BEGIN}
# 自动生成：扫描 staged 文件中的敏感信息
# 如需临时跳过（慎用）：git commit --no-verify
node scripts/contracts/check-secrets.cjs
status=$?
if [ $status -ne 0 ]; then
  echo ""
  echo "[pre-commit] aborting due to check-secrets failure (exit $status)"
  exit $status
fi
${MARKER_END}
`;

function main() {
  const gitDir = path.resolve(process.cwd(), '.git');
  if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
    console.log('[install-git-hooks] .git not found — skipping (this is fine outside a repo)');
    return;
  }

  const hooksDir = path.join(gitDir, 'hooks');
  if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });

  const hookPath = path.join(hooksDir, 'pre-commit');
  let existing = '';
  if (fs.existsSync(hookPath)) {
    existing = fs.readFileSync(hookPath, 'utf-8');
  }

  let next;
  if (existing.includes(MARKER_BEGIN)) {
    // 已存在 marker：幂等替换
    const re = new RegExp(
      `${escape(MARKER_BEGIN)}[\\s\\S]*?${escape(MARKER_END)}\\r?\\n?`,
      'm',
    );
    next = existing.replace(re, HOOK_CONTENT);
  } else if (existing.trim().length > 0) {
    // 有用户钩子：追加
    next = existing.endsWith('\n') ? existing + '\n' + HOOK_CONTENT : existing + '\n\n' + HOOK_CONTENT;
  } else {
    // 新建
    next = '#!/bin/sh\n' + HOOK_CONTENT;
  }

  fs.writeFileSync(hookPath, next, { mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch { /* windows 下 chmod 可能 no-op */ }

  console.log(`[install-git-hooks] pre-commit hook installed at ${hookPath}`);
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
