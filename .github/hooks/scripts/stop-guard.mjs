/**
 * Stop hook — 防止 agent 因 stop_hook_active 循环导致无限消耗 premium requests
 *
 * 逻辑:
 *  - stop_hook_active = true → 允许停止（已经重试过一次，不再阻挡）
 *  - stop_hook_active = false → 检查是否应该阻止停止（当前仅记录日志，不阻止）
 *
 * 按照 VS Code 官方文档:
 *  "Always check the stop_hook_active field to prevent the agent from running indefinitely."
 */
import fs from 'node:fs';
import path from 'node:path';

const logDir = path.resolve(import.meta.dirname, '..', 'logs');

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
    setTimeout(() => { if (chunks.length === 0) resolve(null); }, 500);
  });
}

function writeLog(message) {
  fs.mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(path.join(logDir, 'stop-guard.log'), `${ts} ${message}\n`, 'utf8');
}

async function main() {
  const input = await readStdin();
  const stopHookActive = input?.stop_hook_active ?? false;
  const sessionId = input?.sessionId ?? 'unknown';

  if (stopHookActive) {
    // 已经因为之前的 stop hook 重新进入 → 允许停止，防止无限循环
    writeLog(`[INFO] session=${sessionId} stop_hook_active=true → allowing stop (preventing infinite loop)`);
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }

  // 首次停止 → 允许停止（记录日志即可）
  writeLog(`[INFO] session=${sessionId} stop_hook_active=false → allowing stop`);
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
  process.exit(0);
}

main();
