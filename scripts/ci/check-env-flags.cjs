#!/usr/bin/env node
/**
 * scripts/ci/check-env-flags.cjs (§16.27 / §16.7)
 *
 * 校验本次迁移引入的 NG_APP_* flag 在 scripts/set-env.cjs 与
 * docs/cloudflare-migration-plan.md 之间未漂移。
 *
 * 仅检查迁移相关 flag 集合（CLOUDFLARE_MIGRATION_FLAGS），不影响历史 flag。
 * 失败：set-env.cjs 引用了 flag 但文档快照未列出（要求同 PR 同步）。
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const SET_ENV = path.join(REPO_ROOT, 'scripts', 'set-env.cjs');
const PLAN = path.join(REPO_ROOT, 'docs', 'cloudflare-migration-plan.md');

// Cloudflare 迁移文档明确跟踪的 flag 集合（§16.7 单事实源）
const CLOUDFLARE_MIGRATION_FLAGS = [
  'NG_APP_SENTRY_ENVIRONMENT',
  'NG_APP_CANONICAL_ORIGIN',
  'NG_APP_ORIGIN_GATE_MODE',
  'NG_APP_READ_ONLY_PREVIEW',
  'NG_APP_DEPLOYMENT_TARGET',
  'NG_APP_SUPABASE_PROJECT_ALIAS',
  'NG_APP_SENTRY_RELEASE',
  'NG_APP_SYNC_RPC_ENABLED',
  'NG_APP_SYNC_LEASE_ENABLED',
  'NG_APP_SYNC_PROTOCOL_VERSION',
  'NG_APP_DEPLOYMENT_EPOCH',
];

if (!fs.existsSync(SET_ENV)) { console.error('✗ scripts/set-env.cjs missing'); process.exit(1); }
const setEnvText = fs.readFileSync(SET_ENV, 'utf-8');

const flagRe = /process\.env\.(NG_APP_[A-Z0-9_]+)/g;
const consumed = new Set();
let m;
while ((m = flagRe.exec(setEnvText)) !== null) consumed.add(m[1]);

console.log(`Detected ${consumed.size} NG_APP_* flags consumed by scripts/set-env.cjs`);

// 1. 所有迁移 flag 必须在 set-env.cjs 中被消费
const missingInCode = CLOUDFLARE_MIGRATION_FLAGS.filter((f) => !consumed.has(f));
if (missingInCode.length > 0) {
  console.error('✗ Migration flags declared in plan but not consumed by set-env.cjs:');
  for (const f of missingInCode) console.error('    - ' + f);
  process.exit(1);
}
console.log(`✓ All ${CLOUDFLARE_MIGRATION_FLAGS.length} migration flags consumed by set-env.cjs`);

// 2. 文档中必须列出所有迁移 flag
if (!fs.existsSync(PLAN)) {
  console.warn('⚠ docs/cloudflare-migration-plan.md not found — skipping doc snapshot diff');
  process.exit(0);
}

const planText = fs.readFileSync(PLAN, 'utf-8');
const docFlags = new Set();
const pre = /NG_APP_[A-Z0-9_]+/g;
let mm;
while ((mm = pre.exec(planText)) !== null) docFlags.add(mm[0]);

const missingInDocs = CLOUDFLARE_MIGRATION_FLAGS.filter((f) => !docFlags.has(f));
if (missingInDocs.length > 0) {
  console.error('✗ Migration flags consumed by set-env.cjs but missing from docs/cloudflare-migration-plan.md:');
  for (const f of missingInDocs) console.error('    - ' + f);
  console.error('  Update §16.7 snapshot in the same PR.');
  process.exit(1);
}

console.log('✓ check-env-flags PASSED');
