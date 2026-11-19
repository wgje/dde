'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { URL } = require('node:url');
const { randomBytes, webcrypto } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();
const DATA_DIR = path.resolve(process.env.QUOTA_MONITOR_DATA_DIR || path.join(ROOT, '.quota-monitor'));
const SNAPSHOT_FILE = path.join(DATA_DIR, 'snapshots.jsonl');
const EVENT_FILE = path.join(DATA_DIR, 'events.jsonl');
const MANUAL_OBSERVATION_IDS = new Set(['supabase.egress', 'supabase.egress.cached', 'supabase.storage.size', 'supabase.auth.mau', 'supabase.edge_functions.invocations', 'supabase.realtime.messages', 'supabase.realtime.connections', 'supabase.logs.ingestion', 'supabase.logs.query.allowance']);
const OAUTH_CLIENTS_FILE = path.join(DATA_DIR, 'oauth-clients.json');
const OAUTH_TOKENS_FILE = path.join(DATA_DIR, 'oauth-tokens.dpapi.json');
const SAVED_CREDENTIALS_FILE = path.join(DATA_DIR, 'credentials.json');
const UI_FILE = path.join(__dirname, 'quota-monitor.html');
const PORT = Number(process.env.QUOTA_MONITOR_PORT || 4180);
const HOST = '127.0.0.1';
const INTERVAL_MS = Number(process.env.QUOTA_MONITOR_INTERVAL_MS || 300000);
const CLOUDFLARE_OAUTH_SCOPE = 'account-analytics.read';
const MAX_HISTORY = 240;

const OAUTH_TTL_MS = 10 * 60 * 1000;
const oauthTransactions = new Map();
const oauthClientOverrides = { cloudflare: { clientId: '', clientSecret: '', accountId: '', refreshRequested: false }, supabase: { clientId: '', clientSecret: '' } };
const oauthRuntime = {
  cloudflare: { accessToken: null, refreshToken: null, expiresAt: 0, accounts: [], error: null },
  supabase: { accessToken: null, refreshToken: null, expiresAt: 0, projects: [], error: null },
};
const runtimeCredentials = {
  CLOUDFLARE_API_TOKEN: null,
  CLOUDFLARE_ACCOUNT_ID: null,
  CLOUDFLARE_WORKER_NAME: null,
  SUPABASE_PROJECT_REF: null,
  SUPABASE_METRICS_SECRET: null,
};
const savedCredentialNames = new Set();
const MANUAL_CREDENTIAL_FIELDS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'SUPABASE_PROJECT_REF', 'SUPABASE_METRICS_SECRET'];
const PERSISTABLE_SECRET_FIELDS = ['CLOUDFLARE_API_TOKEN', 'SUPABASE_METRICS_SECRET'];

const QUOTA_CATALOG = [
  {
    id: 'cloudflare.workers.requests.daily', provider: 'Cloudflare', label: 'Workers / Pages Functions 请求', unit: 'requests', limit: 100000, period: '每日（UTC）',
    explanation: 'Workers Free 的请求额度；Pages 的 Functions 请求与 Workers 请求共享这个每日额度。静态资源请求不计入该额度。',
    mapping: 'cloudflare/workers-static-assets/shell-worker.js：当前仓库只有静态资源 Worker，若没有 Functions 路由，静态资源请求不会消耗这里的额度。', source: 'Cloudflare Workers/Pages pricing（2026-11-14 记录）', confidence: 'baseline',
  },
  {
    id: 'cloudflare.workers.subrequests.external.invocation', provider: 'Cloudflare', kind: 'runtime-limit', label: '单次 Worker 外部子请求上限', unit: 'requests/invocation', limit: 50, period: '单次调用',
    explanation: '这是运行时保护上限，不是月度账单；用于识别某次代码改动是否可能制造请求风暴。',
    mapping: '当前静态资源 Worker 不主动发起外部 fetch；若后续增加 Functions/API 代理，应把外部 fetch 次数纳入审计。', source: 'Cloudflare Workers limits', confidence: 'baseline',
  },
  {
    id: 'cloudflare.d1.rows.read.daily', provider: 'Cloudflare', label: 'D1 每日读取行数', unit: 'rows', limit: 5000000, period: '每日（UTC）',
    explanation: 'D1 Free 每日额度为读取 500 万行；行扫描数才是额度口径，readQueries 只是遥测，不用于计费。',
    mapping: 'Cloudflare 账户总量。仓库当前只有静态资源 Worker，未发现 D1 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare D1 pricing / D1 metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.d1.rows.written.daily', provider: 'Cloudflare', label: 'D1 每日写入行数', unit: 'rows', limit: 100000, period: '每日（UTC）',
    explanation: 'D1 Free 每日额度为写入 10 万行。',
    mapping: 'Cloudflare 账户总量。仓库当前只有静态资源 Worker，未发现 D1 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare D1 pricing / D1 metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.d1.storage.total', provider: 'Cloudflare', label: 'D1 账户总存储', unit: 'bytes', limit: 5 * 1000 * 1000 * 1000, period: '账户总量',
    explanation: 'D1 Free 账户的全部数据库共享 5 GB 存储额度；按当天分析 API 返回的各数据库最大尺寸合计。',
    mapping: 'Cloudflare 账户总量。仓库当前只有静态资源 Worker，未发现 D1 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare D1 pricing / D1 metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.kv.reads.daily', provider: 'Cloudflare', label: 'Workers KV 每日读取键数', unit: 'operations', limit: 100000, period: '每日（UTC）',
    explanation: 'Workers Free 每日包含 100,000 次 KV read；批量读取按键数计数。',
    mapping: 'Cloudflare 账户总量。仓库未发现 Wrangler KV namespace 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare Workers KV pricing / KV metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.kv.writes.daily', provider: 'Cloudflare', label: 'Workers KV 每日写入数', unit: 'operations', limit: 1000, period: '每日（UTC）',
    explanation: 'Workers Free 每日包含 1,000 次 KV write，按写入键数计数。',
    mapping: 'Cloudflare 账户总量。仓库未发现 Wrangler KV namespace 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare Workers KV pricing / KV metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.kv.deletes.daily', provider: 'Cloudflare', label: 'Workers KV 每日删除数', unit: 'operations', limit: 1000, period: '每日（UTC）',
    explanation: 'Workers Free 每日包含 1,000 次 KV delete。',
    mapping: 'Cloudflare 账户总量。仓库未发现 Wrangler KV namespace 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare Workers KV pricing / KV metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.kv.lists.daily', provider: 'Cloudflare', label: 'Workers KV 每日列表请求', unit: 'requests', limit: 1000, period: '每日（UTC）',
    explanation: 'Workers Free 每日包含 1,000 次 KV list 请求。',
    mapping: 'Cloudflare 账户总量。仓库未发现 Wrangler KV namespace 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare Workers KV pricing / KV metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.kv.storage.total', provider: 'Cloudflare', label: 'Workers KV 账户总存储', unit: 'bytes', limit: 1 * 1000 * 1000 * 1000, period: '账户总量',
    explanation: 'Workers Free 包含 1 GB KV 存储；按当天分析 API 返回的各 namespace 最大 byteCount 合计。',
    mapping: 'Cloudflare 账户总量。仓库未发现 Wrangler KV namespace 绑定；若读数大于零，可能来自账户中的其他资源，不能归因到 NanoFlow。', source: 'Cloudflare Workers KV pricing / KV metrics analytics', confidence: 'account-wide-observed',
  },
  {
    id: 'cloudflare.r2.class_a.operations.monthly', provider: 'Cloudflare', kind: 'quota-upper-bound', label: 'R2 Class A 操作数（账户上界）', unit: 'operations', limit: 1000000, period: '当前 UTC 月（账户聚合）',
    explanation: 'R2 Standard Free 每月包含 1,000,000 次 Class A 操作。账户聚合未区分 Standard / Infrequent Access，因此仅作 Standard Free 配额的保守上界；只计官方映射 actionType，未知类型不归类。',
    mapping: 'Cloudflare 账户级 R2 Analytics；当前仓库没有 R2 binding，读数不能归因到 NanoFlow。', source: 'Cloudflare R2 GraphQL Analytics / R2 pricing', confidence: 'account-wide-upper-bound',
  },
  {
    id: 'cloudflare.r2.class_b.operations.monthly', provider: 'Cloudflare', kind: 'quota-upper-bound', label: 'R2 Class B 操作数（账户上界）', unit: 'operations', limit: 10000000, period: '当前 UTC 月（账户聚合）',
    explanation: 'R2 Standard Free 每月包含 10,000,000 次 Class B 操作。账户聚合未区分 Standard / Infrequent Access，因此仅作 Standard Free 配额的保守上界；只计官方映射 actionType，未知类型不归类。',
    mapping: 'Cloudflare 账户级 R2 Analytics；当前仓库没有 R2 binding，读数不能归因到 NanoFlow。', source: 'Cloudflare R2 GraphQL Analytics / R2 pricing', confidence: 'account-wide-upper-bound',
  },
  {
    id: 'cloudflare.r2.storage.snapshot', provider: 'Cloudflare', kind: 'non_cumulative', label: 'R2 当前存储快照（非 GB-month）', unit: 'bytes', limit: 10 * 1000 * 1000 * 1000, period: '当前快照（非账期累计）',
    explanation: 'R2 Analytics 返回当前对象 payload 与 metadata 的存储快照；R2 账单按 GB-month 计算，单个快照不能代表完整账期使用量，因此这里只作参考。',
    mapping: 'Cloudflare 账户级 R2 Analytics；当前仓库没有 R2 binding，读数不能归因到 NanoFlow。', source: 'Cloudflare R2 GraphQL Analytics / R2 pricing', confidence: 'account-wide-reference',
  },
  {
    id: 'supabase.database.size', provider: 'Supabase', label: '数据库大小', unit: 'bytes', limit: 500 * 1000 * 1000, period: '每项目',
    explanation: 'Free 计划数据库大小上限为每项目 500 MB。Supabase 文档说明数据库指标通常每日更新，不能当作实时账单计数。',
    mapping: 'src/services/supabase-client.service.ts 以及同步写入路径；高频快照、未清理历史和索引会推高数据库大小。', source: 'Supabase billing / database size docs', confidence: 'baseline',
  },
  {
    id: 'supabase.egress', provider: 'Supabase', label: '未缓存 Egress', unit: 'bytes', limit: 5 * 1000 * 1000 * 1000, period: '组织 / 账期',
    explanation: 'Free 计划包含 5 GB 未缓存 Egress；Supabase Usage Dashboard 的 Egress 与 Cached Egress 分开显示，不能混作单一读数。',
    mapping: 'src/services/supabase-client.service.ts 的查询/同步响应、Storage 下载、Edge Function 响应都可能贡献出口；本地采集器不会读取应用数据。', source: 'Supabase billing and bandwidth docs', confidence: 'baseline',
  },
  {
    id: 'supabase.egress.cached', provider: 'Supabase', label: 'Cached Egress', unit: 'bytes', limit: 5 * 1000 * 1000 * 1000, period: '组织 / 账期',
    explanation: 'Free 计划 Cached Egress 配额 5 GB，与未缓存 Egress 分开计量；Usage Dashboard 分别显示两类出口。',
    mapping: 'Database、Auth、Storage、Realtime、Edge Functions 与 Log Drains 等可能产生网络出口；本地采集器不读取应用响应体。', source: 'Supabase egress billing docs', confidence: 'baseline',
  },
  {
    id: 'supabase.logs.ingestion', provider: 'Supabase', label: 'Logs Ingest', unit: 'bytes', limit: 5 * 1000 * 1000 * 1000, period: '组织 / 账期',
    explanation: 'Free 计划包含 5 GB Logs Ingest；官方说明日志计费正在逐步推出，额度与费率已发布，但当前 enforcement 尚未全面启用。',
    mapping: 'Postgres、API、Auth、Storage、Realtime 与 Edge Functions 等平台日志；不是应用数据库大小。', source: 'Supabase Logs Ingest usage docs', confidence: 'baseline',
  },
  {
    id: 'supabase.logs.query.allowance', provider: 'Supabase', kind: 'non-billable-allowance', label: 'Logs Query 扫描量（非直接计费）', unit: 'bytes', limit: 1000 * 1000 * 1000 * 1000, period: '组织 / 账期（公开 Free allowance）',
    explanation: 'Free 计划公开基准为每月 1,000 GB 查询 allowance；Supabase 当前 Usage 页面说明它不直接计费，额度会随日志摄取量变化且 enforcement timeline 尚待公告，因此此比率只是参考，不是费用或固定阈值承诺。',
    mapping: '通过 Studio、Management API、CLI 等读取日志会扫描日志量；应控制轮询范围和频率，避免本地采集器额外制造 Logs Query 用量。', source: 'Supabase Logs Query usage docs / current Usage Dashboard', confidence: 'allowance-reference',
  },
  {
    id: 'supabase.storage.size', provider: 'Supabase', label: 'Storage Size（Dashboard GB 摘要）', unit: 'gb', limit: 1, period: 'Dashboard 当前摘要（非 GB-hours）',
    explanation: 'Supabase Usage Dashboard 显示当前 Storage Size 摘要；按页面精度记录仅用于当前项目的容量参考，账单按 GB-hours 计费，不能把该摘要解释为账期精确用量。',
    mapping: '附件/导入导出功能产生的对象需要单独关注；本监控默认只显示基线，未把文件列表当作额度真相。', source: 'Supabase billing docs', confidence: 'baseline',
  },
  {
    id: 'supabase.auth.mau', provider: 'Supabase', label: '月活用户（MAU）', unit: 'users', limit: 50000, period: '账期',
    explanation: 'Free 计划包含 50,000 MAU；这不是本地任务数，也不是请求次数。',
    mapping: '登录、刷新会话和 OAuth 回调会影响 Auth 使用；浏览器端只使用 anon/publishable key。', source: 'Supabase billing docs', confidence: 'baseline',
  },
  {
    id: 'supabase.edge_functions.invocations', provider: 'Supabase', label: 'Edge Function 调用', unit: 'invocations', limit: 500000, period: '账期',
    explanation: 'Free 计划包含 500,000 次 Edge Function 调用；监控采集器不会调用你的 Edge Function。',
    mapping: 'supabase/functions 下的函数只有被业务或 webhook 调用时才会增长；当前仓库不把采集器部署到 Supabase。', source: 'Supabase billing docs', confidence: 'baseline',
  },
  {
    id: 'supabase.realtime.messages', provider: 'Supabase', label: 'Realtime 消息', unit: 'messages', limit: 2000000, period: '账期',
    explanation: 'Free 计划包含 2,000,000 条 Realtime 消息；消息量与峰值连接数是两个概念。',
    mapping: '仅当 Realtime 通道被启用并有广播/数据库变更消息时增长；当前同步配置默认关闭 Realtime。', source: 'Supabase Realtime pricing', confidence: 'baseline',
  },
  {
    id: 'supabase.realtime.connections', provider: 'Supabase', label: 'Realtime 峰值连接', unit: 'connections', limit: 200, period: '账期峰值',
    explanation: 'Free 计划包含 200 个峰值连接；它不等同于累计连接次数。',
    mapping: '多标签页、移动端后台恢复和长连接策略可能影响峰值；当前仓库将 REALTIME_ENABLED 设为 false。', source: 'Supabase Realtime pricing', confidence: 'baseline',
  },
];

function loadDotEnv(filePath = path.join(ROOT, '.env.local')) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function supabaseProjectRefFromUrl() {
  const candidates = [process.env.SUPABASE_URL, process.env.NG_APP_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.VITE_SUPABASE_URL].filter(Boolean);
  const refs = new Set();
  for (const candidate of candidates) {
    try {
      const hostname = new URL(candidate).hostname.toLowerCase();
      const match = /^([a-z0-9]+)\.supabase\.co$/.exec(hostname);
      if (match) refs.add(match[1]);
    } catch { /* ignore malformed or non-hosted local Supabase URLs */ }
  }
  return refs.size === 1 ? [...refs][0] : null;
}

function initializeSupabaseProjectRef() {
  const detectedRef = supabaseProjectRefFromUrl();
  if (!detectedRef) return;
  const configuredRef = process.env.SUPABASE_PROJECT_REF;
  if (configuredRef && configuredRef !== detectedRef) {
    console.warn('[quota-monitor] SUPABASE_PROJECT_REF 与 Supabase URL 不一致；为避免监控错项目，本地采集器以 SUPABASE_URL 推导的项目为准。');
  }
  runtimeCredentials.SUPABASE_PROJECT_REF = detectedRef;
}

function credential(name) {
  if (name === 'CLOUDFLARE_API_TOKEN' && oauthRuntime.cloudflare.accessToken) return oauthRuntime.cloudflare.accessToken;
  if (name === 'SUPABASE_METRICS_SECRET' && oauthRuntime.supabase.accessToken) return oauthRuntime.supabase.accessToken;
  return runtimeCredentials[name] || process.env[name] || '';
}

function credentialSource(name) {
  if (name === 'CLOUDFLARE_API_TOKEN' && oauthRuntime.cloudflare.accessToken) return 'oauth';
  if (name === 'SUPABASE_METRICS_SECRET' && oauthRuntime.supabase.accessToken) return 'oauth';
  if (runtimeCredentials[name]) return savedCredentialNames.has(name) ? 'saved-local' : 'browser-memory';
  return process.env[name] ? 'env-local' : 'missing';
}

function loadSavedCredentials() {
  if (!fs.existsSync(SAVED_CREDENTIALS_FILE)) return;
  try {
    const stats = fs.lstatSync(SAVED_CREDENTIALS_FILE);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('saved credential path is not a regular file');
    const saved = JSON.parse(fs.readFileSync(SAVED_CREDENTIALS_FILE, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('saved credential document is invalid');
    for (const name of PERSISTABLE_SECRET_FIELDS) {
      if (process.env[name] !== undefined) continue;
      const value = saved[name];
      if (typeof value !== 'string' || !value.trim()) continue;
      runtimeCredentials[name] = value;
      savedCredentialNames.add(name);
    }
  } catch {
    console.warn('[quota-monitor] 本机凭证文件无法安全读取；本次仅使用环境变量和临时输入。');
  }
}

function saveManualCredentials(input) {
  const stored = {};
  if (fs.existsSync(SAVED_CREDENTIALS_FILE)) {
    const existing = fs.lstatSync(SAVED_CREDENTIALS_FILE);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('拒绝覆盖非普通文件形式的本机凭证文件');
    const saved = JSON.parse(fs.readFileSync(SAVED_CREDENTIALS_FILE, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('本机凭证文件格式无效；未写入任何凭证');
    for (const name of PERSISTABLE_SECRET_FIELDS) {
      if (typeof saved[name] === 'string' && saved[name].trim()) stored[name] = saved[name];
    }
  }
  for (const name of PERSISTABLE_SECRET_FIELDS) {
    const raw = input[name];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const value = raw.trim();
    if (/[\r\n\0]/.test(value)) throw new Error('凭证不能包含换行或空字符；未写入本机凭证文件');
    if (name === 'CLOUDFLARE_API_TOKEN' && oauthRuntime.cloudflare.accessToken === value) continue;
    if (name === 'SUPABASE_METRICS_SECRET' && oauthRuntime.supabase.accessToken === value) continue;
    stored[name] = value;
  }

  if (Object.keys(stored).length === 0) return false;
  ensureDataDir();
  const temporaryFile = SAVED_CREDENTIALS_FILE + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(stored, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryFile, SAVED_CREDENTIALS_FILE);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporaryFile); } catch { /* best-effort cleanup of this operation's unique temp file */ }
    throw error;
  }
  savedCredentialNames.clear();
  for (const name of Object.keys(stored)) {
    if (!process.env[name]) savedCredentialNames.add(name);
  }
  return true;
}

function forgetSavedCredentials() {
  if (!fs.existsSync(SAVED_CREDENTIALS_FILE)) {
    savedCredentialNames.clear();
    return false;
  }
  const stats = fs.lstatSync(SAVED_CREDENTIALS_FILE);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('本机凭证路径不是普通文件；拒绝删除');
  fs.unlinkSync(SAVED_CREDENTIALS_FILE);
  for (const name of savedCredentialNames) runtimeCredentials[name] = null;
  savedCredentialNames.clear();
  return true;
}

function loadOAuthClientOverrides() {
  try {
    if (!fs.existsSync(OAUTH_CLIENTS_FILE)) return;
    const config = JSON.parse(fs.readFileSync(OAUTH_CLIENTS_FILE, 'utf8'));
    for (const provider of ['cloudflare', 'supabase']) {
      if (typeof config?.[provider]?.clientId === 'string') oauthClientOverrides[provider].clientId = config[provider].clientId;
      if (provider === 'cloudflare' && typeof config?.cloudflare?.accountId === 'string') {
        oauthClientOverrides.cloudflare.accountId = config.cloudflare.accountId;
        if (config.cloudflare.accountId) runtimeCredentials.CLOUDFLARE_ACCOUNT_ID = config.cloudflare.accountId;
      }
      if (typeof config?.cloudflare?.refreshRequested === 'boolean') oauthClientOverrides.cloudflare.refreshRequested = config.cloudflare.refreshRequested;
    }
  } catch { /* invalid local OAuth config is ignored; operators can replace it from the UI */ }
}

function oauthClient(provider) {
  if (provider === 'cloudflare') return {
    clientId: process.env.CLOUDFLARE_OAUTH_CLIENT_ID || oauthClientOverrides.cloudflare.clientId,
    clientSecret: process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET || oauthClientOverrides.cloudflare.clientSecret,
    // Cloudflare adds offline_access automatically when the OAuth Client allows refresh_token.
    scopes: CLOUDFLARE_OAUTH_SCOPE,
    refreshRequested: oauthClientOverrides.cloudflare.refreshRequested,
  };
  return {
    clientId: process.env.SUPABASE_OAUTH_CLIENT_ID || oauthClientOverrides.supabase.clientId,
    clientSecret: process.env.SUPABASE_OAUTH_CLIENT_SECRET || oauthClientOverrides.supabase.clientSecret,
    scopes: 'Projects: Read + Secrets: Read',
  };
}

function powershellSecret(command, value) {
  if (process.platform !== 'win32') return '';
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command,
  ], { input: String(value || ''), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function protectOAuthRefreshToken(value) {
  return powershellSecret(
    'Add-Type -AssemblyName System.Security; $value = [Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($value)) { exit 2 }; $bytes = [Text.Encoding]::UTF8.GetBytes($value); $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($encrypted)',
    value,
  );
}

function unprotectOAuthRefreshToken(value) {
  return powershellSecret(
    'Add-Type -AssemblyName System.Security; $encoded = [Console]::In.ReadToEnd(); if ([string]::IsNullOrWhiteSpace($encoded)) { exit 2 }; $encrypted = [Convert]::FromBase64String($encoded); $bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($bytes)',
    value,
  );
}
function persistOAuthRefreshTokens() {
  if (process.platform !== 'win32') return;
  const stored = {};
  for (const provider of ['cloudflare', 'supabase']) {
    const refreshToken = oauthRuntime[provider].refreshToken;
    if (!refreshToken) continue;
    const encrypted = protectOAuthRefreshToken(refreshToken);
    if (encrypted) stored[provider] = { refreshToken: encrypted, savedAt: isoNow() };
  }
  ensureDataDir();
  if (!Object.keys(stored).length) {
    try { fs.unlinkSync(OAUTH_TOKENS_FILE); } catch (error) { if (error?.code !== 'ENOENT') console.warn('[quota-monitor] 无法清理本机 OAuth 续期令牌文件。'); }
    return;
  }
  const temporaryFile = `${OAUTH_TOKENS_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, OAUTH_TOKENS_FILE);
  } catch {
    try { fs.unlinkSync(temporaryFile); } catch { /* best-effort cleanup */ }
    console.warn('[quota-monitor] 本机 OAuth 续期令牌无法安全保存；本次运行仍会继续使用内存令牌。');
  }
}

function loadOAuthRefreshTokens() {
  if (process.platform !== 'win32' || !fs.existsSync(OAUTH_TOKENS_FILE)) return;
  try {
    const stats = fs.lstatSync(OAUTH_TOKENS_FILE);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('token path is not a regular file');
    const saved = JSON.parse(fs.readFileSync(OAUTH_TOKENS_FILE, 'utf8'));
    for (const provider of ['cloudflare', 'supabase']) {
      const encrypted = saved?.[provider]?.refreshToken;
      if (typeof encrypted !== 'string' || !encrypted.trim()) continue;
      const refreshToken = unprotectOAuthRefreshToken(encrypted);
      if (refreshToken) oauthRuntime[provider].refreshToken = refreshToken;
    }
  } catch {
    console.warn('[quota-monitor] 本机 OAuth 续期令牌无法解密；需要重新授权。');
  }
}

function saveOAuthClientOverrides(input) {
  for (const [provider, fields] of Object.entries({
    cloudflare: { clientId: 'CLOUDFLARE_OAUTH_CLIENT_ID', clientSecret: 'CLOUDFLARE_OAUTH_CLIENT_SECRET' },
    supabase: { clientId: 'SUPABASE_OAUTH_CLIENT_ID', clientSecret: 'SUPABASE_OAUTH_CLIENT_SECRET' },
  })) {
    const id = input[fields.clientId];
    if (typeof id === 'string' && id.trim()) oauthClientOverrides[provider].clientId = id.trim();
    const secretName = fields.clientSecret;
    if (secretName && typeof input[secretName] === 'string' && input[secretName].trim()) oauthClientOverrides[provider].clientSecret = input[secretName].trim();
    if (provider === 'cloudflare' && typeof input.CLOUDFLARE_OAUTH_REFRESH_TOKEN !== 'undefined') {
      oauthClientOverrides.cloudflare.refreshRequested = input.CLOUDFLARE_OAUTH_REFRESH_TOKEN === true || String(input.CLOUDFLARE_OAUTH_REFRESH_TOKEN).toLowerCase() === 'true';
    }
    if (provider === 'cloudflare' && typeof input.CLOUDFLARE_ACCOUNT_ID === 'string' && input.CLOUDFLARE_ACCOUNT_ID.trim()) {
      oauthClientOverrides.cloudflare.accountId = input.CLOUDFLARE_ACCOUNT_ID.trim();
      runtimeCredentials.CLOUDFLARE_ACCOUNT_ID = input.CLOUDFLARE_ACCOUNT_ID.trim();
    }
  }
  ensureDataDir();
  const temporaryFile = `${OAUTH_CLIENTS_FILE}.tmp`;
  const publicClientIds = { cloudflare: { clientId: oauthClientOverrides.cloudflare.clientId, accountId: oauthClientOverrides.cloudflare.accountId, refreshRequested: oauthClientOverrides.cloudflare.refreshRequested }, supabase: { clientId: oauthClientOverrides.supabase.clientId } };
  fs.writeFileSync(temporaryFile, JSON.stringify(publicClientIds, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryFile, OAUTH_CLIENTS_FILE);
}

function explainOAuthCallbackError(provider, error) {
  const detail = error instanceof Error ? error.message : 'OAuth callback failed';
  if (provider === 'cloudflare' && /invalid[_ ]scope|not allowed to request scope|requested scope.*(?:invalid|not allowed)/i.test(detail)) {
    return 'Cloudflare OAuth Client 不允许本机请求的只读范围。额度观察簿现在固定请求 account-analytics.read；请在 OAuth Client 的 Scopes 中勾选 Account Analytics Read，并确认保存的是同一个 Client ID。不要把 Client ID、Scope 列表的内部 UUID 或其他 ID 粘贴为授权范围，然后重新授权。';
  }
  return detail;
}

function oauthRedirectUri(provider) {
  // Supabase OAuth's local HTTP exception is for the literal localhost host, not 127.0.0.1.
  const callbackHost = provider === 'supabase' ? 'localhost' : HOST;
  return `http://${callbackHost}:${PORT}/oauth/${provider}/callback`;
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function newPkceValue() { return base64url(randomBytes(48)); }

async function createCodeChallenge(verifier) {
  return base64url(await webcrypto.subtle.digest('SHA-256', Buffer.from(verifier, 'ascii')));
}

async function fetchForm(url, parameters, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(parameters),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error_description: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(data.error_description || data.error || `OAuth endpoint returned ${response.status}`);
    return data;
  } finally { clearTimeout(timeout); }
}

function setOAuthToken(provider, tokens) {
  const current = oauthRuntime[provider];
  current.accessToken = tokens.access_token || current.accessToken;
  current.refreshToken = tokens.refresh_token || current.refreshToken;
  current.expiresAt = Date.now() + Math.max(60, Number(tokens.expires_in) || 3600) * 1000;
  current.error = null;
  if (provider === 'cloudflare' && current.accessToken) runtimeCredentials.CLOUDFLARE_API_TOKEN = current.accessToken;
  if (current.refreshToken) persistOAuthRefreshTokens();
}

async function startOAuth(provider, openerOrigin = `http://${HOST}:${PORT}`) {
  const config = oauthClient(provider);
  if (provider === 'cloudflare' && !credential('CLOUDFLARE_ACCOUNT_ID')) throw new Error('请在“一次性设置”填入 Cloudflare Account ID');
  if (!config.clientId || (provider === 'supabase' && !config.clientSecret)) {
    throw new Error(provider === 'cloudflare' ? '请设置 Cloudflare OAuth Client ID；额度数据权限固定为 Account Analytics Read，offline_access 只用于后台自动续期。' : '请设置 Supabase OAuth Client ID 与 Client Secret（页面表单仅在进程内存保存 Secret）');
  }
  const state = newPkceValue();
  const verifier = newPkceValue();
  const challenge = await createCodeChallenge(verifier);
  oauthTransactions.set(state, { provider, verifier, openerOrigin, createdAt: Date.now() });
  for (const [key, transaction] of oauthTransactions) {
    if (Date.now() - transaction.createdAt > OAUTH_TTL_MS) oauthTransactions.delete(key);
  }
  const endpoint = provider === 'cloudflare'
    ? 'https://dash.cloudflare.com/oauth2/auth'
    : 'https://api.supabase.com/v1/oauth/authorize';
  const url = new URL(endpoint);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', oauthRedirectUri(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Cloudflare documents scope in the authorization request; Supabase configures scopes on its OAuth App.
  if (provider === 'cloudflare') url.searchParams.set('scope', config.scopes);
  return url.toString();
}

async function exchangeOAuthCode(provider, code, verifier) {
  // Supabase confidential OAuth clients authenticate via Basic Auth, not a duplicate client_id form field.
  const config = oauthClient(provider);
  const parameters = {
    grant_type: 'authorization_code', code, ...(provider === 'cloudflare' ? { client_id: config.clientId } : {}),
    redirect_uri: oauthRedirectUri(provider), code_verifier: verifier,
  };
  const headers = config.clientSecret
    ? { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` }
    : {};
  const url = provider === 'cloudflare'
    ? 'https://dash.cloudflare.com/oauth2/token'
    : 'https://api.supabase.com/v1/oauth/token';
  return fetchForm(url, parameters, headers);
}

async function refreshOAuthToken(provider) {
  const current = oauthRuntime[provider];
  if (Date.now() < current.expiresAt - 60000) return current.accessToken;
  if (!current.refreshToken) {
    current.accessToken = null;
    if (provider === 'cloudflare') runtimeCredentials.CLOUDFLARE_API_TOKEN = null;
    throw new Error('OAuth access token 已过期，请重新连接');
  }
  const config = oauthClient(provider);
  const headers = config.clientSecret
    ? { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` }
    : {};
  try {
    const tokens = await fetchForm(provider === 'cloudflare' ? 'https://dash.cloudflare.com/oauth2/token' : 'https://api.supabase.com/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: current.refreshToken, ...(provider === 'cloudflare' ? { client_id: config.clientId } : {}) }, headers);
    setOAuthToken(provider, tokens);
    return current.accessToken;
  } catch (error) {
    current.error = error instanceof Error ? error.message : 'OAuth refresh failed';
    current.accessToken = null;
    current.refreshToken = null;
    current.expiresAt = 0;
    if (provider === 'cloudflare') runtimeCredentials.CLOUDFLARE_API_TOKEN = null;
    throw error;
  }
}

async function responseJson(url, headers) {
  return fetchJson(url, { headers });
}

async function completeOAuth(provider, code, verifier) {
  const tokens = await exchangeOAuthCode(provider, code, verifier);
  setOAuthToken(provider, tokens);
  if (provider === 'cloudflare') {
    const configuredAccount = runtimeCredentials.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!configuredAccount) throw new Error('请先在本地 .env.local 配置非敏感的 CLOUDFLARE_ACCOUNT_ID');
    runtimeCredentials.CLOUDFLARE_ACCOUNT_ID = configuredAccount;
  } else {
    const projects = await responseJson('https://api.supabase.com/v1/projects', { Authorization: `Bearer ${tokens.access_token}` });
    oauthRuntime.supabase.projects = (Array.isArray(projects) ? projects : projects.projects || []).map(project => ({ ref: project.ref || project.id, name: project.name || project.ref || project.id })).filter(project => project.ref);
    const configuredProject = runtimeCredentials.SUPABASE_PROJECT_REF || process.env.SUPABASE_PROJECT_REF || '';
    if (configuredProject && oauthRuntime.supabase.projects.some(project => project.ref === configuredProject)) await configureSupabaseProject(configuredProject);
    else if (oauthRuntime.supabase.projects.length === 1) await configureSupabaseProject(oauthRuntime.supabase.projects[0].ref);
  }
}

async function configureSupabaseProject(projectRef) {
  const project = oauthRuntime.supabase.projects.find(item => item.ref === projectRef);
  if (!project) throw new Error('请选择 OAuth 授权项目列表中的项目');
  const accessToken = await refreshOAuthToken('supabase');
  const response = await responseJson(`https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/api-keys?reveal=true`, { Authorization: `Bearer ${accessToken}` });
  const keys = Array.isArray(response) ? response : response.api_keys || response.keys || [];
  const keyValue = item => item.api_key || item.key || item.value;
  const legacyServiceRole = keys.find(item => ['secret', 'service_role'].includes(String(item.name || item.type || '').toLowerCase()));
  const secret = keys.map(keyValue).find(value => typeof value === 'string' && value.startsWith('sb_secret_'))
    || (legacyServiceRole ? keyValue(legacyServiceRole) : null)
    || keys.map(keyValue).find(value => typeof value === 'string' && value.startsWith('service_role'));
  if (!secret) throw new Error('OAuth 已授权，但未能读取项目 Metrics API 所需的 Secret API Key；请确认 OAuth App 的 Secrets:Read 权限。');
  runtimeCredentials.SUPABASE_PROJECT_REF = projectRef;
  runtimeCredentials.SUPABASE_METRICS_SECRET = secret;
  oauthRuntime.supabase.selectedProjectRef = projectRef;
}

function disconnectOAuth(provider) {
  const state = oauthRuntime[provider];
  state.accessToken = null; state.refreshToken = null; state.expiresAt = 0; state.error = null;
  if (provider === 'cloudflare') { runtimeCredentials.CLOUDFLARE_API_TOKEN = null; state.accounts = []; }
  else { runtimeCredentials.SUPABASE_METRICS_SECRET = null; runtimeCredentials.SUPABASE_PROJECT_REF = null; state.projects = []; state.selectedProjectRef = null; }
  persistOAuthRefreshTokens();
}


function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendJsonLine(filePath, value) {
  ensureDataDir();
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJsonLines(filePath, limit = MAX_HISTORY) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function isoNow() { return new Date().toISOString(); }

function emptyMetric(definition, extra = {}) {
  const status = definition.kind === 'runtime-limit' ? 'non_cumulative' : 'unavailable';
  return { ...definition, observed: null, remaining: null, usageRatio: null, status, ...extra };
}

function observedMetric(definition, observed, source = 'provider-observed') {
  const safeObserved = Number.isFinite(observed) ? observed : null;
  if (safeObserved === null) return emptyMetric(definition, { source, reason: 'provider returned no numeric value' });
  const usageRatio = definition.limit > 0 ? safeObserved / definition.limit : null;
  const status = usageRatio === null ? 'observed' : usageRatio >= 1 ? 'exceeded' : usageRatio >= 0.8 ? 'warning' : 'normal';
  return { ...definition, observed: safeObserved, remaining: Math.max(0, definition.limit - safeObserved), usageRatio, status, source };
}

function parsePrometheus(text) {
  const metrics = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/);
    if (!match) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value) && !metrics.has(match[1])) metrics.set(match[1], value);
  }
  return metrics;
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return body;
  } finally { clearTimeout(timer); }
}

function cloudflareMetricsWithReason(usageReason) {
  const runtimeLimitId = 'cloudflare.workers.subrequests.external.invocation';
  const runtimeLimitReason = 'runtime limit is not an account usage counter';
  return QUOTA_CATALOG.filter((item) => item.provider === 'Cloudflare').map((item) => emptyMetric(item, {
    reason: item.id === runtimeLimitId ? runtimeLimitReason : usageReason,
  }));
}

function sumAggregateGroups(groups, field) {
  if (!Array.isArray(groups)) return null;
  if (groups.length === 0) return 0;
  const values = groups.map((group) => {
    const raw = group?.sum?.[field];
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  });
  if (values.some((value) => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function sumMaxByDimension(groups, dimension, field) {
  if (!Array.isArray(groups)) return null;
  if (groups.length === 0) return 0;
  const valuesByDimension = new Map();
  for (const group of groups) {
    const dimensionValue = group?.dimensions?.[dimension];
    if (typeof dimensionValue !== 'string' || dimensionValue.length === 0) return null;
    const raw = group?.max?.[field];
    if (raw === null || raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return null;
    valuesByDimension.set(dimensionValue, Math.max(valuesByDimension.get(dimensionValue) || 0, value));
  }
  return valuesByDimension.size > 0
    ? [...valuesByDimension.values()].reduce((sum, value) => sum + value, 0)
    : null;
}
function latestR2StorageSnapshot(groups) {
  if (!Array.isArray(groups)) return null;
  if (groups.length === 0) return 0;
  const latestByBucket = new Map();
  for (const group of groups) {
    const dimensions = group?.dimensions || {};
    const bucket = typeof dimensions.bucketName === 'string' && dimensions.bucketName ? dimensions.bucketName : '__account__';
    const timestampText = dimensions.datetime || dimensions.date;
    const timestamp = Date.parse(timestampText || '');
    if (!Number.isFinite(timestamp)) return null;
    const payload = Number(group?.max?.payloadSize);
    const metadata = Number(group?.max?.metadataSize);
    if (!Number.isFinite(payload) || payload < 0 || !Number.isFinite(metadata) || metadata < 0) return null;
    const previous = latestByBucket.get(bucket);
    if (!previous || timestamp >= previous.timestamp) latestByBucket.set(bucket, { timestamp, value: payload + metadata });
  }
  return latestByBucket.size ? [...latestByBucket.values()].reduce((sum, item) => sum + item.value, 0) : null;
}

function mapCloudflareAnalytics(account, definitions = QUOTA_CATALOG.filter((item) => item.provider === 'Cloudflare')) {
  const metricsById = new Map();
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const setMissing = (id, reason) => {
    const definition = definitionById.get(id);
    if (definition) metricsById.set(id, emptyMetric(definition, { reason }));
  };
  const setObserved = (id, value, source = 'cloudflare-graphql-account-analytics') => {
    const definition = definitionById.get(id);
    if (definition) metricsById.set(id, observedMetric(definition, value, source));
  };
  const workersDataAvailable = Array.isArray(account?.workersInvocationsAdaptive);
  const d1DataAvailable = Array.isArray(account?.d1AnalyticsAdaptiveGroups);
  const d1StorageAvailable = Array.isArray(account?.d1StorageAdaptiveGroups);
  const kvOperationsAvailable = Array.isArray(account?.kvOperationsAdaptiveGroups);
  const kvStorageAvailable = Array.isArray(account?.kvStorageAdaptiveGroups);
  const r2OperationsAvailable = Array.isArray(account?.r2OperationsAdaptiveGroups);
  const r2StorageAvailable = Array.isArray(account?.r2StorageAdaptiveGroups);
  const workersGroups = workersDataAvailable ? account.workersInvocationsAdaptive : [];
  const d1Groups = d1DataAvailable ? account.d1AnalyticsAdaptiveGroups : [];
  const d1StorageGroups = d1StorageAvailable ? account.d1StorageAdaptiveGroups : [];
  const kvOperationGroups = kvOperationsAvailable ? account.kvOperationsAdaptiveGroups : [];
  const kvStorageGroups = kvStorageAvailable ? account.kvStorageAdaptiveGroups : [];
  const r2OperationGroups = r2OperationsAvailable ? account.r2OperationsAdaptiveGroups : [];
  const r2StorageGroups = r2StorageAvailable ? account.r2StorageAdaptiveGroups : [];
  const noDataReason = 'no analytics observations returned';

  const workerRequests = workersDataAvailable ? sumAggregateGroups(workersGroups, 'requests') : null;
  if (workerRequests === null) setMissing('cloudflare.workers.requests.daily', noDataReason);
  else setObserved('cloudflare.workers.requests.daily', workerRequests, 'cloudflare-workers-analytics');
  setMissing('cloudflare.workers.subrequests.external.invocation', 'runtime limit is not an account usage counter');

  const d1RowsRead = d1DataAvailable ? sumAggregateGroups(d1Groups, 'rowsRead') : null;
  const d1RowsWritten = d1DataAvailable ? sumAggregateGroups(d1Groups, 'rowsWritten') : null;
  if (d1RowsRead === null) setMissing('cloudflare.d1.rows.read.daily', noDataReason);
  else setObserved('cloudflare.d1.rows.read.daily', d1RowsRead, 'cloudflare-d1-analytics');
  if (d1RowsWritten === null) setMissing('cloudflare.d1.rows.written.daily', noDataReason);
  else setObserved('cloudflare.d1.rows.written.daily', d1RowsWritten, 'cloudflare-d1-analytics');

  const d1Storage = d1StorageAvailable ? sumMaxByDimension(d1StorageGroups, 'databaseId', 'databaseSizeBytes') : null;
  if (d1Storage === null) setMissing('cloudflare.d1.storage.total', noDataReason);
  else setObserved('cloudflare.d1.storage.total', d1Storage, 'cloudflare-d1-storage-analytics');

  const kvActionMetrics = {
    read: 'cloudflare.kv.reads.daily',
    write: 'cloudflare.kv.writes.daily',
    delete: 'cloudflare.kv.deletes.daily',
    list: 'cloudflare.kv.lists.daily',
  };
  const kvActionTotals = new Map();
  const invalidKvActions = new Set();
  for (const group of kvOperationGroups) {
    const action = String(group?.dimensions?.actionType || '').toLowerCase();
    if (!Object.hasOwn(kvActionMetrics, action)) continue;
    const rawRequests = group?.sum?.requests;
    const requests = rawRequests === null || rawRequests === undefined ? null : Number(rawRequests);
    if (requests === null || !Number.isFinite(requests) || requests < 0) {
      invalidKvActions.add(action);
      continue;
    }
    kvActionTotals.set(action, (kvActionTotals.get(action) || 0) + requests);
  }
  for (const [action, id] of Object.entries(kvActionMetrics)) {
    if (invalidKvActions.has(action) || !kvOperationsAvailable) setMissing(id, noDataReason);
    else setObserved(id, kvActionTotals.get(action) ?? 0, 'cloudflare-kv-analytics');
  }

  const kvStorage = kvStorageAvailable ? sumMaxByDimension(kvStorageGroups, 'namespaceId', 'byteCount') : null;
  if (kvStorage === null) setMissing('cloudflare.kv.storage.total', noDataReason);
  else setObserved('cloudflare.kv.storage.total', kvStorage, 'cloudflare-kv-storage-analytics');

  const r2ClassA = new Set(['listbuckets', 'putbucket', 'listobjects', 'putobject', 'copyobject', 'completemultipartupload', 'createmultipartupload', 'lifecyclestoragetiertransition', 'listmultipartuploads', 'uploadpart', 'uploadpartcopy', 'listparts', 'putbucketencryption', 'putbucketcors', 'putbucketlifecycleconfiguration']);
  const r2ClassB = new Set(['headbucket', 'headobject', 'getobject', 'usagesummary', 'getbucketencryption', 'getbucketlocation', 'getbucketcors', 'getbucketlifecycleconfiguration']);
  const r2Free = new Set(['deleteobject', 'deletebucket', 'abortmultipartupload']);
  const r2Totals = { classA: 0, classB: 0 };
  const r2UnknownActions = new Set();
  const r2InvalidActions = new Set();
  for (const group of r2OperationGroups) {
    const action = String(group?.dimensions?.actionType || '').replace(/[\s_-]/g, '').toLowerCase();
    const rawStatusCode = group?.dimensions?.responseStatusCode;
    const statusCode = Number(rawStatusCode);
    const requests = Number(group?.sum?.requests);
    if (!action || rawStatusCode === null || rawStatusCode === undefined || !Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599 || !Number.isFinite(requests) || requests < 0) {
      r2InvalidActions.add(action || '<missing actionType/status/requests>');
      continue;
    }
    if (statusCode === 401 || statusCode === 403) continue;
    if (r2ClassA.has(action)) r2Totals.classA += requests;
    else if (r2ClassB.has(action)) r2Totals.classB += requests;
    else if (!r2Free.has(action)) r2UnknownActions.add(action);
  }
  if (!r2OperationsAvailable) {
    setMissing('cloudflare.r2.class_a.operations.monthly', `R2 操作数据存在未映射或无效类型；未知 actionType：${[...r2UnknownActions].join(', ')}；无效项：${[...r2InvalidActions].join(', ')}`);
    setMissing('cloudflare.r2.class_b.operations.monthly', `R2 操作数据存在未映射或无效类型；未知 actionType：${[...r2UnknownActions].join(', ')}；无效项：${[...r2InvalidActions].join(', ')}`);
  } else if (r2InvalidActions.size || r2UnknownActions.size) {
    setMissing('cloudflare.r2.class_a.operations.monthly', `R2 操作数据存在未映射或无效类型；未知 actionType：${[...r2UnknownActions].join(', ')}；无效项：${[...r2InvalidActions].join(', ')}`);
    setMissing('cloudflare.r2.class_b.operations.monthly', `R2 操作数据存在未映射或无效类型；未知 actionType：${[...r2UnknownActions].join(', ')}；无效项：${[...r2InvalidActions].join(', ')}`);
  } else {
    setObserved('cloudflare.r2.class_a.operations.monthly', r2Totals.classA, 'cloudflare-r2-operations-analytics');
    setObserved('cloudflare.r2.class_b.operations.monthly', r2Totals.classB, 'cloudflare-r2-operations-analytics');
  }
  const r2Storage = r2StorageAvailable ? latestR2StorageSnapshot(r2StorageGroups) : null;
  if (r2Storage === null) setMissing('cloudflare.r2.storage.snapshot', noDataReason);
  else {
    const definition = definitionById.get('cloudflare.r2.storage.snapshot');
    if (definition) metricsById.set('cloudflare.r2.storage.snapshot', { ...observedMetric(definition, r2Storage, 'cloudflare-r2-storage-analytics'), status: 'reference', usageRatio: null, remaining: null, reason: 'current snapshot is not GB-month billing usage' });
  }
  const metrics = definitions.map((definition) => metricsById.get(definition.id) || emptyMetric(definition, { reason: noDataReason }));
  const measuredCount = metrics.filter((metric) => metric.observed !== null).length;
  const missingCount = metrics.filter((metric) => metric.status === 'unavailable' && metric.reason === noDataReason).length;
  const actionTypes = [...new Set(kvOperationGroups.map((group) => String(group?.dimensions?.actionType || '')).filter(Boolean))];
  const knownActions = new Set(Object.keys(kvActionMetrics));
  const unknownActions = actionTypes.filter((action) => !knownActions.has(action.toLowerCase()));
  const status = measuredCount === 0 ? 'no_data' : missingCount > 0 || unknownActions.length > 0 || r2UnknownActions.size > 0 || r2InvalidActions.size > 0 ? 'partial' : 'ok';
  const message = `Workers ${workersGroups.length} 组；D1 行指标 ${d1Groups.length} 组、存储 ${d1StorageGroups.length} 组；KV 操作 ${kvOperationGroups.length} 组、存储 ${kvStorageGroups.length} 组；R2 操作 ${r2OperationGroups.length} 组、存储 ${r2StorageGroups.length} 组；KV actionType：${actionTypes.length ? actionTypes.join(', ') : '无观测'}${unknownActions.length ? `（未映射：${unknownActions.join(', ')}）` : ''}${r2UnknownActions.size ? `；R2 未映射 actionType：${[...r2UnknownActions].join(', ')}` : ''}。账户级聚合；接口明确返回空观测组时按当前时间窗 0 用量处理，缺字段/无效数值仍保持未观测。R2 存储仅为快照，不是 GB-month。`;
  const nextStep = unknownActions.length > 0 || r2UnknownActions.size > 0 || r2InvalidActions.size > 0
    ? `存在未映射或无效的 actionType/status：${[...unknownActions, ...r2UnknownActions, ...r2InvalidActions].join(', ')}；这些数值未计入免费额度项。`
    : missingCount > 0
      ? 'Cloudflare GraphQL 没返回部分数据集或有效数值；这些项仍标为未观测。已返回空观测组的数据集按当前时间窗 0 用量计。数据为账户总量，仓库没有 D1/KV/R2 绑定，读数也可能来自其他项目。'
      : null;
  return { status, code: status === 'ok' ? 'OK' : status === 'partial' ? 'PARTIAL_DATA' : 'NO_ANALYTICS_DATA', message, nextStep, metrics };
}


async function collectCloudflare() {
  const definitions = QUOTA_CATALOG.filter((item) => item.provider === 'Cloudflare');
  if (oauthRuntime.cloudflare.accessToken || oauthRuntime.cloudflare.refreshToken) {
    try { await refreshOAuthToken('cloudflare'); } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { status: 'error', code: 'OAUTH_REFRESH_FAILED', source: 'oauth', message: `Cloudflare OAuth refresh failed: ${detail}`, nextStep: 'Cloudflare OAuth 会话已无法续期。请在一次性授权中允许 offline_access，以便本机进程使用 refresh token 自动续期；额度读取权限仍只有 Account Analytics Read。', metrics: cloudflareMetricsWithReason('OAuth refresh failed') };
    }
  }
  const token = credential('CLOUDFLARE_API_TOKEN');
  const accountId = credential('CLOUDFLARE_ACCOUNT_ID');
  const source = credentialSource('CLOUDFLARE_API_TOKEN');
  if (!token || !accountId) return { status: 'not_configured', code: 'NOT_CONFIGURED', source, message: '缺少 CLOUDFLARE_API_TOKEN 或 CLOUDFLARE_ACCOUNT_ID', nextStep: '配置 Cloudflare Account ID，并使用 Account Analytics Read 只读权限的 Token，或完成浏览器 OAuth 授权。', metrics: cloudflareMetricsWithReason('collector credentials not configured') };
  const end = new Date();
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const workerFilter = credential('CLOUDFLARE_WORKER_NAME');
  const filter = workerFilter ? `, scriptName: ${JSON.stringify(workerFilter)}` : '';
  const monthStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  const query = `query($accountTag: String!, $start: DateTime!, $end: DateTime!, $r2Start: Time!, $r2MonthStart: Time!, $r2End: Time!, $startDate: Date!, $endDate: Date!) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(filter: { datetime_geq: $start, datetime_leq: $end${filter} }, limit: 10000) { sum { requests errors subrequests } dimensions { datetime scriptName status } } d1AnalyticsAdaptiveGroups(filter: { date_geq: $startDate, date_leq: $endDate }, limit: 10000) { sum { rowsRead rowsWritten } dimensions { date databaseId } } d1StorageAdaptiveGroups(filter: { date_geq: $startDate, date_leq: $endDate }, limit: 10000) { max { databaseSizeBytes } dimensions { date databaseId } } kvOperationsAdaptiveGroups(filter: { date_geq: $startDate, date_leq: $endDate }, limit: 10000) { sum { requests } dimensions { date actionType namespaceId } } kvStorageAdaptiveGroups(filter: { date_geq: $startDate, date_leq: $endDate }, limit: 10000) { max { byteCount keyCount } dimensions { date namespaceId } } r2OperationsAdaptiveGroups(filter: { datetime_geq: $r2MonthStart, datetime_leq: $r2End }, limit: 10000) { sum { requests } dimensions { datetime actionType actionStatus responseStatusCode } } r2StorageAdaptiveGroups(filter: { datetime_geq: $r2Start, datetime_leq: $r2End }, limit: 10000, orderBy: [datetime_DESC]) { max { payloadSize metadataSize } dimensions { datetime bucketName } } } } }`;
  try {
    const body = await fetchJson('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { accountTag: accountId, start: start.toISOString(), end: end.toISOString(), r2Start: start.toISOString(), r2MonthStart: monthStart.toISOString(), r2End: end.toISOString(), startDate, endDate } }) });
    if (body.errors?.length) throw new Error(body.errors.map((item) => item.message).join('; '));
    const account = body.data?.viewer?.accounts?.[0] || {};
    return { ...mapCloudflareAnalytics(account, definitions), source };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const authorizationDenied = /authorization denied|not authorized|unauthori[sz]ed|\b401\b|\b403\b/i.test(detail);
    const nextStep = authorizationDenied
      ? source === 'oauth'
        ? 'Cloudflare OAuth Token 被拒绝。请在 OAuth Client 的 Scopes 中勾选 Account Analytics Read，并确保本机请求范围为 account-analytics.read；保存后断开并重新授权，同时核对 Account ID。'
        : '当前 Cloudflare 凭证来自 .env.local / 手动配置，GraphQL 拒绝了分析查询。请确认 Token 已授予 Account Analytics Read、允许范围覆盖此 Account ID；也可用属于同一账户的 OAuth Client 授权（OAuth 范围：account-analytics.read）。'
      : '检查本机网络/代理是否能访问 api.cloudflare.com；本机采样器会按间隔自动重试。';
    return { status: 'error', code: authorizationDenied ? 'AUTHORIZATION_DENIED' : 'COLLECTOR_ERROR', source, message: `Cloudflare 采集失败：${detail}`, nextStep, metrics: cloudflareMetricsWithReason(authorizationDenied ? 'authorization denied' : 'collector error') };
  }
}
function supabaseMetricsWithReason(databaseReason) {
  return QUOTA_CATALOG.filter((item) => item.provider === 'Supabase').map((item) => emptyMetric(item, {
    reason: item.id === 'supabase.database.size' ? databaseReason : 'billing metric not exposed by Metrics API',
  }));
}

async function collectSupabase() {
  const projectRef = credential('SUPABASE_PROJECT_REF');
  const secretKey = credential('SUPABASE_METRICS_SECRET') || credential('SUPABASE_SECRET_KEY');
  const definitions = QUOTA_CATALOG.filter((item) => item.provider === 'Supabase');
  if (!projectRef || !secretKey) {
    return { status: 'not_configured', message: '缺少 Supabase 项目选择或 Metrics Secret API Key（完成 OAuth 授权或使用手动备用配置）', metrics: supabaseMetricsWithReason('collector credentials not configured') };
  }
  try {
    const text = await fetchText(`https://${projectRef}.supabase.co/customer/v1/privileged/metrics`, { Authorization: `Basic ${Buffer.from(`service_role:${secretKey}`).toString('base64')}` });
    const metrics = parsePrometheus(text);
    const databaseBytes = firstMetric(metrics, ['pg_database_size_bytes', 'supabase_db_size_bytes', 'postgres_database_size_bytes']);
    return { status: 'ok', message: `Supabase Metrics API 返回 ${metrics.size} 个 Prometheus 指标`, metrics: definitions.map((item) => item.id === 'supabase.database.size' && databaseBytes !== null ? observedMetric(item, databaseBytes) : emptyMetric(item, { reason: 'billing metric not exposed by Metrics API' })) };
  } catch (error) {
    return { status: 'error', message: `Supabase 采集失败：${error instanceof Error ? error.message : String(error)}`, metrics: supabaseMetricsWithReason('collector error') };
  }
}

async function fetchText(url, headers = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return text;
  } finally { clearTimeout(timer); }
}

function firstMetric(metrics, names) {
  for (const name of names) {
    const value = metrics.get(name);
    if (value !== undefined) return value;
  }
  return null;
}

function detectAnomalies(metrics, previous) {
  if (!previous) return [];
  const previousById = new Map(previous.metrics.map((metric) => [metric.id, metric]));
  return metrics.flatMap((metric) => {
    const old = previousById.get(metric.id);
    if (!old || metric.observed === null || old.observed === null || metric.observed <= old.observed) return [];
    const delta = metric.observed - old.observed;
    const relativeDelta = old.observed === 0 ? null : delta / old.observed;
    const limitTrigger = metric.limit > 0 && delta >= metric.limit * 0.05;
    const relativeTrigger = relativeDelta !== null && relativeDelta >= 0.5;
    if (!limitTrigger && !relativeTrigger) return [];
    const percent = relativeDelta === null ? '首次出现非零值' : `${(relativeDelta * 100).toFixed(1)}%`;
    return [{
      id: `${metric.id}:${isoNow()}`,
      metricId: metric.id, provider: metric.provider, label: metric.label,
      previous: old.observed, current: metric.observed, delta, relativeDelta,
      detectedAt: isoNow(), severity: metric.usageRatio !== null && metric.usageRatio >= 0.8 ? 'high' : 'medium',
      reasoning: [
        `对比上一份快照：${formatNumber(old.observed)} → ${formatNumber(metric.observed)}（增加 ${formatNumber(delta)}，${percent}）。`,
        `触发条件：单次增量达到免费基线的 5%，或相对上次观测增加至少 50%。`,
        `项目映射：${metric.mapping}`,
        '这是异常候选而不是账单结论；需要结合部署时间、请求日志、函数调用和 Supabase Dashboard 账期数据复核。',
      ],
      nextChecks: ['查看最近一次部署或配置变更', '按项目/路径/函数拆分请求来源', '在对应平台账单页核对同一时间窗'],
    }];
  });
}

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '未知';
}

function buildAnalysis(snapshot) {
  return {
    purpose: '给 AI 的额度突变调查上下文；不包含任何 API 密钥或应用数据。',
    method: ['读取平台只读指标', '与上一份本地快照比较', '计算绝对增量与相对增量', '将指标映射到仓库路径', '把候选原因和复核步骤写入导出日志'],
    limitations: ['GraphQL/Prometheus 指标不一定等同最终账单口径', '未配置或未暴露的指标保持 null，不解释为 0', '本地监控器不会自动修改 Cloudflare、Supabase 或应用数据'],
    collectorDiagnostics: Object.entries(snapshot.collectors).map(([provider, collector]) => ({ provider, status: collector.status, code: collector.code || null, source: collector.source || null, message: collector.message, nextStep: collector.nextStep || null })),
    anomalies: snapshot.anomalies,
  };
}

async function collectSnapshot() {
  const previous = readJsonLines(SNAPSHOT_FILE, 1)[0] || null;
  const [cloudflare, supabase] = await Promise.all([collectCloudflare(), collectSupabase()]);
  const metrics = [...cloudflare.metrics, ...supabase.metrics];
  const snapshot = {
    schemaVersion: 1,
    collectedAt: isoNow(),
    window: 'Cloudflare: current UTC day; Supabase: latest Prometheus scrape',
    collectors: {
      cloudflare: { status: cloudflare.status, code: cloudflare.code || null, source: cloudflare.source || credentialSource('CLOUDFLARE_API_TOKEN'), message: cloudflare.message, nextStep: cloudflare.nextStep || null },
      supabase: { status: supabase.status, code: supabase.code || null, source: supabase.source || credentialSource('SUPABASE_METRICS_SECRET'), message: supabase.message, nextStep: supabase.nextStep || null },
    },
    metrics,
    anomalies: detectAnomalies(metrics, previous),
  };
  snapshot.analysis = buildAnalysis(snapshot);
  appendJsonLine(SNAPSHOT_FILE, snapshot);
  for (const anomaly of snapshot.anomalies) appendJsonLine(EVENT_FILE, anomaly);
  return snapshot;
}

function latestSnapshot() { return readJsonLines(SNAPSHOT_FILE, 1)[0] || null; }

function manualObservationHistory() {
  return readJsonLines(path.join(DATA_DIR, 'supabase-dashboard-observations.jsonl'));
}

function latestManualObservations() {
  const latestByMetric = new Map();
  for (const record of manualObservationHistory()) {
    for (const observation of record.observations || []) {
      const previous = latestByMetric.get(observation.metricId);
      if (!previous || Date.parse(record.capturedAt) > Date.parse(previous.capturedAt)) {
        latestByMetric.set(observation.metricId, { ...observation, source: record.source, projectRef: record.projectRef, evidenceKind: record.evidenceKind, exactness: record.exactness, capturedAt: record.capturedAt, periodStart: record.periodStart, periodEnd: record.periodEnd });
      }
    }
  }
  return [...latestByMetric.values()];
}

function manualObservationAnomalies() { return manualObservationHistory().flatMap((record) => record.anomalies || []); }

function validateDashboardObservation(input) {
  const allowedKeys = new Set(['projectRef', 'periodStart', 'periodEnd', 'observations']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowedKeys.has(key))) throw new Error('请求字段不符合手动读数格式');
  const projectRef = credential('SUPABASE_PROJECT_REF');
  if (!projectRef || input.projectRef !== projectRef) throw new Error('Dashboard 读数必须绑定当前已配置的 Supabase Project Ref；请先选中目标项目，不能录入组织级混合用量');
  const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(input.periodStart) || !validDate(input.periodEnd) || input.periodStart > input.periodEnd) throw new Error('账期必须是有效的 UTC 日期，且开始日期不晚于结束日期');
  if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > MANUAL_OBSERVATION_IDS.size) throw new Error('至少填入一个读数，最多九项');
  const catalogById = new Map(QUOTA_CATALOG.map((item) => [item.id, item]));
  const seen = new Set();
  return input.observations.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !['metricId', 'displayedValue'].includes(key))) throw new Error('读数项格式无效');
    const definition = catalogById.get(item.metricId);
    if (!definition || !MANUAL_OBSERVATION_IDS.has(item.metricId) || seen.has(item.metricId)) throw new Error('包含不允许或重复的指标');
    if (typeof item.displayedValue !== 'string' || item.displayedValue.length > 48) throw new Error(`${definition.label} 必须提供 Dashboard 页面显示的数字文本`);
    const enteredValue = Number(item.displayedValue.replace(/,/g, '').trim());
    if (!item.displayedValue.trim() || !Number.isFinite(enteredValue) || enteredValue < 0) throw new Error(`${definition.label} 必须是 Dashboard 页面显示的非负有限数值`);
    if (['users', 'invocations', 'messages', 'connections'].includes(definition.unit) && !Number.isInteger(enteredValue)) throw new Error(`${definition.label} 必须是整数`);
    seen.add(item.metricId);
    const multiplier = ['supabase.egress', 'supabase.egress.cached', 'supabase.storage.size', 'supabase.logs.ingestion', 'supabase.logs.query.allowance'].includes(definition.id) ? 1_000_000_000 : 1;
    const observed = enteredValue * multiplier;
    if (!Number.isFinite(observed)) throw new Error(`${definition.label} 数值超出可处理范围`);
    const metric = observedMetric(definition, observed, 'supabase-usage-dashboard-manual');
    return { metricId: definition.id, label: definition.label, value: metric.observed, enteredValue, displayUnit: ['supabase.egress', 'supabase.egress.cached', 'supabase.storage.size', 'supabase.logs.ingestion', 'supabase.logs.query.allowance'].includes(definition.id) ? 'GB' : definition.unit, displayedValue: item.displayedValue.trim(), exactness: 'dashboard-displayed-rounded-value', displayRounding: '按 Dashboard 显示精度人工录入；监控器不补精度' ,enteredUnit: ['supabase.egress', 'supabase.egress.cached', 'supabase.storage.size', 'supabase.logs.ingestion', 'supabase.logs.query.allowance'].includes(definition.id) ? 'GB' : definition.unit, unit: definition.unit, limit: definition.limit, usageRatio: metric.usageRatio, remaining: metric.remaining, status: metric.status };
  });
}

function recordDashboardObservation(input) {
  const observations = validateDashboardObservation(input);
  const record = {
    schemaVersion: 1,
    type: 'manual-dashboard-observation',
    id: randomBytes(16).toString('hex'),
    provider: 'Supabase',
    projectRef: input.projectRef,
    evidenceKind: 'dashboard-displayed-rounded-manual',
    exactness: 'dashboard-displayed-rounded-value',
    source: 'Supabase Usage Dashboard（项目筛选：This project only）',
    capturedAt: isoNow(),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    observations,
    analysis: {
      purpose: '补充 Metrics API 未暴露的官方 Dashboard 读数；不会改写自动采集快照。',
      method: ['由使用者从 Supabase Usage Dashboard 读取数值', '保留录入时间、来源与账期', '仅与相同指标、相同账期的前一条手动记录比较'],
      limitations: ['属于人工录入，不是自动 API 采样', '组织级读数不能直接归因到单一项目', '不同账期的数据不能直接比较', '未填写的指标仍保持未观测'],
    },
  };
  const history = manualObservationHistory();
  const previousById = new Map();
  for (const previous of history) {
    if (previous.periodStart !== record.periodStart || previous.periodEnd !== record.periodEnd) continue;
    for (const observation of previous.observations || []) previousById.set(observation.metricId, { ...observation, capturedAt: previous.capturedAt });
  }
  const anomalies = [];
  for (const current of observations) {
    const old = previousById.get(current.metricId);
    if (!old || current.value <= old.value) continue;
    const delta = current.value - old.value;
    const relativeDelta = old.value === 0 ? null : delta / old.value;
    if (delta < current.limit * 0.05 && !(relativeDelta !== null && relativeDelta >= 0.5)) continue;
    const definition = QUOTA_CATALOG.find((item) => item.id === current.metricId);
    anomalies.push({
      id: `${current.metricId}:${record.capturedAt}`,
      metricId: current.metricId,
      provider: 'Supabase',
      label: current.label,
      projectRef: record.projectRef,
      evidenceKind: record.evidenceKind,
      previous: old.value,
      current: current.value,
      delta,
      relativeDelta,
      detectedAt: record.capturedAt,
      source: record.source,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      severity: current.usageRatio >= 0.8 ? 'high' : 'medium',
      reasoning: [`相同账期手动 Dashboard 记录：${formatNumber(old.value)} → ${formatNumber(current.value)}（增加 ${formatNumber(delta)}）。`, `前次记录时间：${old.capturedAt}；本次读取时间：${record.capturedAt}。`, `来源：${record.source}；账期：${record.periodStart} 至 ${record.periodEnd}。`, `项目映射：${definition.mapping}`, '这是人工录入读数的突变候选，不是自动采样或独立账单证明。'],
      nextChecks: ['确认两次记录来自相同 Dashboard 指标与项目筛选', '查看账期内部署和用量曲线变化', '不要将组织级读数归因到单一仓库'],
    });
  }
  record.anomalies = anomalies;
  appendJsonLine(path.join(DATA_DIR, 'supabase-dashboard-observations.jsonl'), record);
  for (const anomaly of anomalies) appendJsonLine(EVENT_FILE, anomaly);
  return record;
}


function exportJson() {
  return JSON.stringify({ schemaVersion: 1, exportedAt: isoNow(), snapshots: readJsonLines(SNAPSHOT_FILE), manualDashboardObservations: manualObservationHistory(), anomalies: readJsonLines(EVENT_FILE) }, null, 2);
}

function exportMarkdown() {
  const snapshots = readJsonLines(SNAPSHOT_FILE);
  const anomalies = readJsonLines(EVENT_FILE);
  const manualDashboardObservations = manualObservationHistory();
  const latest = snapshots.at(-1);
  const lines = ['# 免费额度突变调查包', '', `导出时间：${isoNow()}`, '', '## 给 AI 的分析说明', '', '这是本地采集器生成的结构化调查上下文。请先区分官方基线、平台实际读数和本地推断；不要把 null 当作 0，也不要把 GraphQL/Prometheus 估算当作最终账单。', '', '## 最新采集', ''];
  if (latest) {
    lines.push(`采集时间：${latest.collectedAt}`, `时间窗：${latest.window}`, '');
    for (const metric of latest.metrics) lines.push(`- ${metric.provider} / ${metric.label}：观测 ${metric.observed === null ? '未知' : formatNumber(metric.observed)}；免费基线 ${formatNumber(metric.limit)} ${metric.unit}；状态 ${metric.status}；未观测原因：${metric.reason || '无'}；映射：${metric.mapping}`);
  } else lines.push('尚未成功采集。');
  lines.push('', '## Supabase Usage Dashboard 手工观测', '');
  if (!manualDashboardObservations.length) lines.push('暂无手工 Dashboard 记录。');
  for (const record of manualDashboardObservations) {
    lines.push(`### ${record.provider} · ${record.projectRef} · ${record.periodStart} 至 ${record.periodEnd}`, '', `读取时间：${record.capturedAt}`, `来源：${record.source}`, `证据类型：${record.evidenceKind}；精度：${record.exactness}`, '');
    for (const observation of record.observations || []) lines.push(`- ${observation.label}：Dashboard 显示 ${observation.displayedValue} ${observation.displayUnit}；标准化值 ${formatNumber(observation.value)} ${observation.unit}；状态 ${observation.status}`);
    if (record.analysis?.method?.length) lines.push('', '记录方法：', ...record.analysis.method.map((item) => `- ${item}`));
    if (record.analysis?.limitations?.length) lines.push('', '解释边界：', ...record.analysis.limitations.map((item) => `- ${item}`));
    lines.push('');
  }  lines.push('', '## 突变事件', '');
  if (!anomalies.length) lines.push('暂无满足阈值的突变事件。');
  for (const event of anomalies) { lines.push(`### ${event.provider} / ${event.label}`, '', ...event.reasoning.map((item) => `- ${item}`), '', '复核步骤：', ...event.nextChecks.map((item) => `- ${item}`), ''); }
  lines.push('## 采集器状态', '');
  if (latest) for (const [name, collector] of Object.entries(latest.collectors)) {
    lines.push(`- ${name}：${collector.status}${collector.code ? ` / ${collector.code}` : ''}${collector.source ? ` / 来源 ${collector.source}` : ''} — ${collector.message}`);
    if (collector.nextStep) lines.push(`  - 建议下一步：${collector.nextStep}`);
  }
  lines.push('', '## 机器可读数据', '', '```json', JSON.stringify({ snapshots, manualDashboardObservations, anomalies }, null, 2), '```', '');
  return lines.join('\n');
}

function safeJson(value) { return JSON.stringify(value); }
function send(res, status, body, contentType = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(body);
}

function isLocalRequest(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  let parsedHost;
  try { parsedHost = new URL('http://' + host); } catch { return false; }
  if (!['localhost', '127.0.0.1'].includes(parsedHost.hostname) || (parsedHost.port && parsedHost.port !== String(PORT))) return false;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.protocol === 'http:' && parsedOrigin.host === parsedHost.host) return true;
      // The Codex/Chrome browser bridge serves local tabs from its fixed extension origin.
      // Keep the server loopback-only while allowing that local bridge to render and call the UI.
      if (parsedOrigin.protocol === 'chrome-extension:') return true;
    } catch { return false; }
    const callback = new URL(req.url || '/', 'http://' + host).pathname.match(/^\/oauth\/(cloudflare|supabase)\/callback$/);
    const state = new URL(req.url || '/', 'http://' + host).searchParams.get('state') || '';
    const transaction = state ? oauthTransactions.get(state) : null;
    return Boolean(callback && transaction && transaction.provider === callback[1] && Date.now() - transaction.createdAt <= OAUTH_TTL_MS);
  }
  // The service is bound to loopback only; browser bridges may mark local navigation as cross-site.
  // Host validation above is the actual exposure boundary, so keep local UI navigation usable.
  return true;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function handleRequest(req, res) {
  if (!isLocalRequest(req)) return send(res, 403, safeJson({ ok: false, error: '仅允许本机同源访问' }));
  const requestUrl = new URL(req.url || '/', 'http://' + req.headers.host);
  const oauthStartMatch = requestUrl.pathname.match(/^\/oauth\/(cloudflare|supabase)\/start$/);
  const oauthCallbackMatch = requestUrl.pathname.match(/^\/oauth\/(cloudflare|supabase)\/callback$/);
  if (oauthStartMatch && req.method === 'GET') {
    try {
      const openerOrigin = `http://${req.headers.host}`;
      return send(res, 302, '', 'text/plain; charset=utf-8', { Location: await startOAuth(oauthStartMatch[1], openerOrigin) });
    }
    catch (error) { return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
  }
  if (oauthCallbackMatch && req.method === 'GET') {
    const provider = oauthCallbackMatch[1];
    const state = requestUrl.searchParams.get('state') || '';
    const transaction = oauthTransactions.get(state);
    oauthTransactions.delete(state);
    try {
      if (!transaction || transaction.provider !== provider || Date.now() - transaction.createdAt > OAUTH_TTL_MS) throw new Error('OAuth state 已过期或不匹配，请重新授权');
      const providerError = requestUrl.searchParams.get('error_description') || requestUrl.searchParams.get('error');
      if (providerError) throw new Error(providerError);
      const code = requestUrl.searchParams.get('code');
      if (!code) throw new Error('授权服务器没有返回 authorization code');
      await completeOAuth(provider, code, transaction.verifier);
      oauthRuntime[provider].error = null;
      const openerOrigin = JSON.stringify(transaction.openerOrigin || `http://${HOST}:${PORT}`);
      const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权完成</title><body style="font:16px system-ui;padding:32px;color:#302c27;background:#f3eddf"><h2>授权完成</h2><p>可以关闭本窗口并返回额度观察簿。</p><script>window.opener?.postMessage({type:'quota-oauth-complete',provider:'${provider}'},${openerOrigin});window.close()</script></body></html>`;
      return send(res, 200, page, 'text/html; charset=utf-8');
    } catch (error) {
      oauthRuntime[provider].error = explainOAuthCallbackError(provider, error);
      const message = String(oauthRuntime[provider].error).replace(/[<>]/g, '');
      return send(res, 400, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>授权未完成</title><body style="font:16px system-ui;padding:32px;color:#302c27;background:#f3eddf"><h2>授权未完成</h2><p>${message}</p><p>请关闭此窗口，回到额度观察簿重试。</p></body></html>`, 'text/html; charset=utf-8');
    }
  }
  if (requestUrl.pathname === '/api/oauth/disconnect' && req.method === 'POST') {
    try {
      const input = await readRequestBody(req);
      if (input.provider !== 'cloudflare' && input.provider !== 'supabase') throw new Error('unknown provider');
      disconnectOAuth(input.provider);
      return send(res, 200, safeJson({ ok: true }));
    } catch (error) { return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
  }
  if (requestUrl.pathname === '/api/oauth/select' && req.method === 'POST') {
    try {
      const input = await readRequestBody(req);
      if (input.provider === 'cloudflare') {
        const account = oauthRuntime.cloudflare.accounts.find(item => item.id === input.id);
        if (!account) throw new Error('请选择已授权账户列表中的账户');
        runtimeCredentials.CLOUDFLARE_ACCOUNT_ID = account.id;
      } else if (input.provider === 'supabase') {
        const project = oauthRuntime.supabase.projects.find(item => item.ref === input.ref);
        if (!project) throw new Error('请选择已授权项目列表中的项目');
        await configureSupabaseProject(project.ref);
      } else throw new Error('unknown provider');
      return send(res, 200, safeJson({ ok: true }));
    } catch (error) { return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
  }

  if (requestUrl.pathname === '/' && req.method === 'GET') {
    if (!fs.existsSync(UI_FILE)) return send(res, 500, '本地监控界面文件缺失', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(UI_FILE, 'utf8'), 'text/html; charset=utf-8');
  }
  if (requestUrl.pathname === '/api/health' && req.method === 'GET') return send(res, 200, safeJson({ ok: true, service: 'quota-monitor', collectedAt: latestSnapshot()?.collectedAt || null }));
  if (requestUrl.pathname === '/api/oauth/start' && req.method === 'POST') {
    try {
      const input = await readRequestBody(req);
      if (input.provider !== 'cloudflare' && input.provider !== 'supabase') throw new Error('unknown provider');
      const openerOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : `http://${HOST}:${PORT}`;
      const authorizationUrl = await startOAuth(input.provider, openerOrigin);
      return send(res, 200, safeJson({ ok: true, authorizationUrl }));
    } catch (error) {
      return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (requestUrl.pathname === '/api/oauth-apps' && req.method === 'GET') {
    return send(res, 200, safeJson({ ok: true, configured: {
      cloudflare: Boolean(oauthClient('cloudflare').clientId),
      supabase: Boolean(oauthClient('supabase').clientId && oauthClient('supabase').clientSecret),
    } }));
  }
  if (requestUrl.pathname === '/api/oauth-apps' && req.method === 'POST') {
    try {
      const input = await readRequestBody(req);
      saveOAuthClientOverrides(input);
      return send(res, 200, safeJson({ ok: true, message: 'OAuth Client ID / Scope ID 已保存本机；Client Secret 仅在当前监控进程内存（跨重启请配置本地 .env.local）' }));
    } catch (error) {
      return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (requestUrl.pathname === '/api/config' && req.method === 'GET') {
    return send(res, 200, safeJson({
      ok: true,
      intervalMs: INTERVAL_MS,
      providers: {
        cloudflare: Boolean(credential('CLOUDFLARE_API_TOKEN') && credential('CLOUDFLARE_ACCOUNT_ID')),
        supabase: Boolean(credential('SUPABASE_PROJECT_REF') && (credential('SUPABASE_METRICS_SECRET') || credential('SUPABASE_SECRET_KEY'))),
      },
      sources: { cloudflare: credentialSource('CLOUDFLARE_API_TOKEN'), supabase: credentialSource('SUPABASE_METRICS_SECRET') },
      savedCredentials: { cloudflare: savedCredentialNames.has('CLOUDFLARE_API_TOKEN'), supabase: savedCredentialNames.has('SUPABASE_METRICS_SECRET') },
      oauth: {
        cloudflareAccountIdConfigured: Boolean(credential('CLOUDFLARE_ACCOUNT_ID')),
        redirectUris: { cloudflare: oauthRedirectUri('cloudflare'), supabase: oauthRedirectUri('supabase') },
        scopes: { cloudflare: oauthClient('cloudflare').scopes, supabase: oauthClient('supabase').scopes },
        refresh: { cloudflare: Boolean(oauthRuntime.cloudflare.refreshToken), supabase: Boolean(oauthRuntime.supabase.refreshToken), storage: process.platform === 'win32' ? 'Windows DPAPI 本机加密' : '仅进程内存' },
        cloudflare: {
          enabled: Boolean(oauthClient('cloudflare').clientId && credential('CLOUDFLARE_ACCOUNT_ID')),
          clientIdConfigured: Boolean(oauthClient('cloudflare').clientId),
          scopeConfigured: true,
          refreshRequested: Boolean(oauthClient('cloudflare').refreshRequested),
          accountIdConfigured: Boolean(credential('CLOUDFLARE_ACCOUNT_ID')),
          connected: Boolean(oauthRuntime.cloudflare.accessToken), error: oauthRuntime.cloudflare.error,
          accounts: oauthRuntime.cloudflare.accounts, selectedAccountId: credential('CLOUDFLARE_ACCOUNT_ID') || null,
        },
        supabase: {
          enabled: Boolean(oauthClient('supabase').clientId && oauthClient('supabase').clientSecret),
          clientIdConfigured: Boolean(oauthClient('supabase').clientId),
          clientSecretConfigured: Boolean(oauthClient('supabase').clientSecret),
          connected: Boolean(oauthRuntime.supabase.accessToken && credential('SUPABASE_METRICS_SECRET')),
          authorized: Boolean(oauthRuntime.supabase.accessToken), error: oauthRuntime.supabase.error,
          projects: oauthRuntime.supabase.projects, selectedProjectRef: oauthRuntime.supabase.selectedProjectRef || credential('SUPABASE_PROJECT_REF') || null,
        },
      },
    }));
  }
  if (requestUrl.pathname === '/api/snapshot' && req.method === 'GET') return send(res, 200, safeJson({ ok: true, snapshot: latestSnapshot(), manualObservations: latestManualObservations(), manualAnomalies: manualObservationAnomalies(), catalog: QUOTA_CATALOG }));
  if (requestUrl.pathname === '/api/observations/supabase' && req.method === 'POST') {
    try {
      const input = await readRequestBody(req);
      const record = recordDashboardObservation(input);
      return send(res, 201, safeJson({ ok: true, record, manualObservations: latestManualObservations(), manualAnomalies: manualObservationAnomalies(), message: `已记录 ${record.observations.length} 项 Supabase Dashboard 读数；自动采集快照未改写。` }));
    } catch (error) {
      return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (requestUrl.pathname === '/api/forget-saved-credentials' && req.method === 'POST') {
    try {
      const removed = forgetSavedCredentials();
      return send(res, 200, safeJson({ ok: true, removed, message: removed ? '已删除本机保存的手动凭证；.env.local 与 OAuth 配置未修改。' : '本机没有保存的手动凭证。' }));
    } catch (error) {
      return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (requestUrl.pathname === '/api/configure' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const input = body && typeof body === 'object' ? body : {};
      const fields = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKER_NAME', 'SUPABASE_PROJECT_REF', 'SUPABASE_METRICS_SECRET'];
      for (const field of fields) {
        const value = input[field];
        if (typeof value === 'string' && value.trim()) runtimeCredentials[field] = value.trim();
      }
      const savedLocally = input.persistLocally === true && saveManualCredentials(input);
      return send(res, 200, safeJson({ ok: true, savedLocally, message: savedLocally
        ? '本次输入的手动 Secret 已保存至 Git 忽略的本机明文文件 .quota-monitor/credentials.json；OAuth 令牌不会写入该文件。'
        : input.persistLocally === true
          ? '本次没有可保存的手动 Secret；凭证仅保存在当前进程内存。'
          : '凭证只保存在当前本地监控进程内存；重启后需重新输入。', config: {
        cloudflare: Boolean(credential('CLOUDFLARE_API_TOKEN') && credential('CLOUDFLARE_ACCOUNT_ID')),
        supabase: Boolean(credential('SUPABASE_PROJECT_REF') && credential('SUPABASE_METRICS_SECRET')),
      } }));
    } catch (error) {
      return send(res, 400, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (requestUrl.pathname === '/api/export' && req.method === 'GET' && requestUrl.searchParams.get('format') === 'markdown') return send(res, 200, exportMarkdown(), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename=quota-analysis.md' });
  if (requestUrl.pathname === '/api/export' && req.method === 'GET') return send(res, 200, exportJson(), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename=quota-snapshots.json' });
  if (requestUrl.pathname === '/api/collect' && req.method === 'POST') {
    try { return send(res, 200, safeJson({ ok: true, snapshot: await collectSnapshot() })); }
    catch (error) { return send(res, 500, safeJson({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
  }
  return send(res, 404, safeJson({ ok: false, error: 'not found' }));
}

async function start() {
  loadDotEnv();
  initializeSupabaseProjectRef();
  ensureDataDir();
  loadOAuthClientOverrides();
  loadOAuthRefreshTokens();
  loadSavedCredentials();
  const server = http.createServer((req, res) => { void handleRequest(req, res); });
  server.listen(PORT, HOST, () => console.log(`Quota monitor listening on http://${HOST}:${PORT}`));
  if (process.env.QUOTA_MONITOR_AUTOCOLLECT !== '0') {
    try { await collectSnapshot(); } catch (error) { console.warn(`[quota-monitor] initial collection failed: ${error instanceof Error ? error.message : String(error)}`); }
    setInterval(() => { void collectSnapshot().catch((error) => console.warn(`[quota-monitor] collection failed: ${error instanceof Error ? error.message : String(error)}`)); }, INTERVAL_MS).unref();
  }
}

if (require.main === module) void start();

module.exports = { QUOTA_CATALOG, detectAnomalies, parsePrometheus, observedMetric, emptyMetric, buildAnalysis, formatNumber, cloudflareMetricsWithReason, sumAggregateGroups, sumMaxByDimension, mapCloudflareAnalytics };
