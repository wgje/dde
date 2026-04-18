#!/usr/bin/env node
/**
 * 敏感信息扫描门禁
 *
 * 用途：
 * - 作为 pre-commit hook：扫描 git staged 文件（默认行为）
 * - 作为审计工具：传入 --mode=audit 扫描整个工作树
 *
 * 输出原则：
 * - 命中时仅输出文件路径 + 行号 + 模式名，**不输出命中内容本身**（避免二次泄漏）
 * - 命中任一规则即 exit(1)
 *
 * 关联计划：.copilot-tracking/plans/2026-04-16-comprehensive-remediation.md T0-2
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ───────────────────────── 规则 ─────────────────────────

/**
 * 敏感串正则（按模式名归类，避免命中内容打印到日志）
 * 每条规则：{ name, pattern }
 *
 * 设计原则：
 * - 环境变量名本身不敏感（`const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get(...)` 是合法读取）
 * - 只对"赋值为看起来像密钥的字面量"告警
 * - 通用的 JWT / 私钥形状正则作为兜底
 */
const SECRET_PATTERNS = [
  // 环境变量名被硬编码赋值为字面量
  { name: 'SUPABASE_SERVICE_ROLE_KEY_LITERAL', pattern: /SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*['"`](?:eyJ|sb_)/i },
  { name: 'SUPABASE_ANON_KEY_LITERAL', pattern: /SUPABASE_ANON_KEY\s*[=:]\s*['"`]eyJ/i },
  { name: 'GROQ_API_KEY_LITERAL', pattern: /GROQ_API_KEY\s*[=:]\s*['"`](?:gsk_|sk-)/i },
  // 通用密钥形状
  { name: 'JWT_LIKE', pattern: /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { name: 'STRIPE_LIVE_SECRET', pattern: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { name: 'SUPABASE_SECRET', pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'OPENAI_KEY', pattern: /\bsk-[A-Za-z0-9]{30,}/ },
  { name: 'GITHUB_TOKEN', pattern: /\bgh[ps]_[A-Za-z0-9]{30,}/ },
  { name: 'PRIVATE_KEY_BLOCK', pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/ },
  { name: 'AWS_ACCESS_KEY', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** 内容扫描豁免路径（这些文件允许包含 mock 密钥 / 形似 JWT 的测试 fixture） */
const CONTENT_EXEMPT_PATHS = [
  /\.spec\.ts$/,
  /\.test\.ts$/,
  /^src\/tests\//,
  /^e2e\//,
  /^scripts\/contracts\/check-secrets\.cjs$/,  // 自身包含正则
];

/** 针对误报的精确内容规则白名单 */
const CONTENT_RULE_EXCEPTIONS = [
  {
    path: /^index\.html$/,
    rules: new Set(['SUPABASE_ANON_KEY_LITERAL', 'JWT_LIKE']),
  },
];

/** 路径黑名单（无论内容如何，这些路径不应入库） */
const PATH_BLACKLIST = [
  /^ai_conversations\//,
  /^\.supabase\//,
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.local$/,
  /^public\/\.well-known\/assetlinks\.json$/,
  /^src\/environments\/environment(\.[^/]+)?\.ts$/,
];

/** 文件内容扫描白名单扩展（节省时间） */
const SCANNABLE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.md', '.txt', '.sh', '.ps1', '.bat', '.cmd',
  '.html', '.css', '.scss', '.sql',
]);

/** 扫描跳过的目录（与现有 check-encoding-corruption.cjs 对齐） */
const SKIP_DIRS = new Set([
  '.angular', '.copilot-tracking', '.git', '.tmp', '.vscode',
  '.worktrees',
  'dist', 'node_modules', 'playwright-report', 'test-results', 'tmp',
  'coverage', '.cache', '.vercel',
]);

/** 路径黑名单白名单（允许的例外，避免误报） */
const BLACKLIST_EXCEPTIONS = [
  /^\.env\.template$/,
  /^\.env\.example$/,
  /^public\/\.well-known\/assetlinks\.json$/,
];

// ───────────────────────── 实现 ─────────────────────────

function getStagedFiles() {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf-8',
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * audit 模式文件清单：使用 git ls-files 仅获取被跟踪文件
 * 自动跳过 .gitignore 命中的文件（ai_conversations/、.worktrees/、.env、environment.ts 等）
 */
function getTrackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    // 不在 git 仓库，退回全量扫描
    const acc = [];
    walkDir(process.cwd(), acc);
    return acc;
  }
}

function walkDir(dir, acc) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(process.cwd(), full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walkDir(full, acc);
    } else if (e.isFile()) {
      acc.push(rel);
    }
  }
}

function getAllFiles() {
  const acc = [];
  walkDir(process.cwd(), acc);
  return acc;
}

/**
 * 检查路径黑名单
 * @returns {string|null} 命中的规则名，否则 null
 */
function checkBlacklist(relPath) {
  for (const ex of BLACKLIST_EXCEPTIONS) {
    if (ex.test(relPath)) return null;
  }
  for (const pat of PATH_BLACKLIST) {
    if (pat.test(relPath)) return `PATH_BLACKLIST:${pat.source}`;
  }
  return null;
}

/**
 * 扫描单文件内容
 * @returns {Array<{line: number, rule: string}>}
 */
function scanFileContent(absPath) {
  const hits = [];
  let content;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 2 * 1024 * 1024) return hits; // > 2MB 跳过
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return hits;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(lines[i])) {
        hits.push({ line: i + 1, rule: name });
      }
    }
  }
  return hits;
}

function isScannable(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (SCANNABLE_EXT.has(ext)) return true;
  // 无扩展名文件（如 .env）也扫描
  if (!ext && path.basename(relPath).startsWith('.')) return true;
  return false;
}

function isContentRuleExcepted(relPath, ruleName) {
  return CONTENT_RULE_EXCEPTIONS.some((entry) => entry.path.test(relPath) && entry.rules.has(ruleName));
}

// ───────────────────────── main ─────────────────────────

function main() {
  const args = process.argv.slice(2);
  const mode = args.find(a => a.startsWith('--mode='))?.slice('--mode='.length) || 'precommit';

  let files;
  if (mode === 'audit') {
    console.log('[check-secrets] mode=audit — scanning tracked files (git ls-files)');
    files = getTrackedFiles();
  } else {
    files = getStagedFiles();
    if (files.length === 0) {
      console.log('[check-secrets] no staged files, skipping');
      process.exit(0);
    }
  }

  let violations = 0;
  for (const rel of files) {
    // 1. 路径黑名单（仅对未在 .gitignore 的文件有效，因为已跟踪的文件才会入库）
    const blacklistHit = checkBlacklist(rel);
    if (blacklistHit) {
      console.error(`[check-secrets] BLOCKED path=${rel} rule=${blacklistHit}`);
      violations++;
      continue; // 黑名单文件不再扫内容（避免把命中内容回显）
    }

    // 2. 内容扫描豁免
    if (CONTENT_EXEMPT_PATHS.some(pat => pat.test(rel))) continue;

    // 3. 内容扫描（仅可扫描扩展）
    if (!isScannable(rel)) continue;
    const abs = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(abs)) continue;
    const hits = scanFileContent(abs);
    for (const h of hits) {
      if (isContentRuleExcepted(rel, h.rule)) continue;
      console.error(`[check-secrets] BLOCKED path=${rel}:${h.line} rule=${h.rule}`);
      violations++;
    }
  }

  if (violations > 0) {
    console.error('');
    console.error(`[check-secrets] FAIL: ${violations} violation(s) detected.`);
    console.error('[check-secrets] If this is a false positive:');
    console.error('  1. Review the matched line — do NOT paste its content into chat/logs.');
    console.error('  2. Add the specific file to BLACKLIST_EXCEPTIONS in scripts/contracts/check-secrets.cjs,');
    console.error('     OR rotate the credential and remove it.');
    process.exit(1);
  }

  console.log(`[check-secrets] PASS — scanned ${files.length} file(s), 0 violations.`);
  process.exit(0);
}

main();
