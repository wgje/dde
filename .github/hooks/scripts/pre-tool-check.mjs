/**
 * PreToolUse hook — 按 VS Code 官方 hook 协议实现
 *
 * 读取: stdin JSON（官方协议），env vars 作为回退
 * 输出: hookSpecificOutput 格式（官方 PreToolUse 输出协议）
 *
 * 功能:
 *  1. 拦截危险终端命令
 *  2. 审计敏感文件编辑
 *  3. 拦截 read_file 对不存在文件的请求（防止 subagent 的 "cannot open" 错误洪泛）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const logDir = path.resolve(import.meta.dirname, '..', 'logs');

// ---------- 危险命令模式 ----------
const dangerousPatterns = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'Remove-Item -Recurse -Force C:\\',
  'Remove-Item -Recurse -Force /',
  ':(){:|:&};:',
  'dd if=/dev/zero',
  'mkfs.',
  '> /dev/sda',
  'chmod -R 777 /',
  'Format-',
  'Clear-Disk',
];

// ---------- 敏感文件模式 ----------
const sensitiveFiles = [
  '.env',
  '.env.local',
  '.env.production',
  'secrets',
  'credentials',
  'private.key',
  '.pem',
];

// ---------- 输出：hookSpecificOutput 格式 ----------
function writeDecision(permissionDecision, permissionDecisionReason) {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision,
  };
  if (permissionDecisionReason) {
    hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
  process.exit(0);
}

// ---------- 审计日志 ----------
function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function writeAuditWarn(message) {
  ensureLogDir();
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(path.join(logDir, 'sensitive-access.log'), `${timestamp} [WARN] ${message}\n`, 'utf8');
}

// ---------- 工具名规范化 ----------
function normalizeToolName(rawName) {
  return rawName.toLowerCase().replace(/[^a-z0-9/_-]/g, '');
}

function isTerminalTool(name) {
  return /(run_in_terminal|runinterminal|execute|shell|powershell|bash)/.test(name);
}

function isEditTool(name) {
  return /(editfiles|apply_patch|create_file|edit|write|replace_string|multi_replace)/.test(name);
}

function isReadFileTool(name) {
  return /(^readfile$|^read_file$|\/readfile$|read_file)/.test(name);
}

// ---------- 文件路径提取 ----------
function extractFilePath(toolInput, toolInputStr) {
  // 优先从结构化 tool_input 中提取
  if (toolInput && typeof toolInput === 'object') {
    if (typeof toolInput.filePath === 'string') return toolInput.filePath;
    if (typeof toolInput.path === 'string') return toolInput.path;
  }
  // 回退：正则从原始字符串中提取
  if (toolInputStr) {
    const m = toolInputStr.match(/"filePath"\s*:\s*"([^"]+)"/i);
    if (m?.[1]) {
      try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
    }
  }
  return null;
}

function toLocalPath(candidate) {
  if (!candidate) return null;
  // 虚拟路径（memory / untitled）不做本地检查
  if (candidate.startsWith('untitled:') || candidate.startsWith('/memories/')) return null;
  // memory 路径误用为本地路径时也跳过
  if (/[\\/]memories[\\/]repo[\\/]/.test(candidate)) return null;
  if (/^file:\/\//i.test(candidate)) {
    try { return fileURLToPath(candidate); } catch { return candidate; }
  }
  return candidate;
}

// ---------- 读取 stdin（官方协议） ----------
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const raw = chunks.join('');
      if (!raw.trim()) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    // 如果 stdin 为空管道或 TTY，500ms 后超时
    setTimeout(() => { if (chunks.length === 0) resolve(null); }, 500);
  });
}

// ---------- 主逻辑 ----------
async function main() {
  // 1) 从 stdin 读取（VS Code 官方协议）
  const stdinData = await readStdin();

  // 2) 从 stdin 或 env vars 确定 tool_name 和 tool_input
  const toolName = stdinData?.tool_name ?? process.env.TOOL_NAME ?? '';
  const toolInput = stdinData?.tool_input ?? null;
  const toolInputStr = toolInput ? JSON.stringify(toolInput) : (process.env.TOOL_ARGS ?? '');

  const normalized = normalizeToolName(toolName);

  // 3) 终端工具：拦截危险命令
  if (isTerminalTool(normalized)) {
    const cmdStr = toolInput?.command ?? toolInputStr;
    for (const pattern of dangerousPatterns) {
      if (cmdStr.includes(pattern)) {
        writeDecision('deny', `Dangerous command pattern detected: ${pattern}`);
      }
    }
  }

  // 4) 编辑工具：审计敏感文件访问
  if (isEditTool(normalized)) {
    const lower = toolInputStr.toLowerCase();
    for (const sensitivePattern of sensitiveFiles) {
      if (lower.includes(sensitivePattern.toLowerCase())) {
        writeAuditWarn(`Sensitive file access: ${sensitivePattern} | Tool=${toolName}`);
      }
    }
  }

  // 5) 读取工具：拦截不存在的文件 + 拦截 memory 路径误用
  if (isReadFileTool(normalized)) {
    const rawPath = extractFilePath(toolInput, toolInputStr);

    // 如果路径包含 memories/repo 或 memories/session，说明 agent 误把虚拟路径当文件路径
    if (rawPath && /[\\/]memories[\\/](repo|session)[\\/]/.test(rawPath)) {
      writeDecision(
        'deny',
        `Memory path used as file path: ${rawPath}. Use the "memory" tool with virtual path /memories/repo/... instead of read_file.`,
      );
    }

    const requestedPath = toLocalPath(rawPath);
    if (requestedPath && !fs.existsSync(requestedPath)) {
      writeDecision(
        'deny',
        `Target file does not exist: ${requestedPath}. Use the memory tool for /memories/ paths, or verify the file was created before reading.`,
      );
    }
  }

  // 6) 通过
  writeDecision('allow');
}

main();