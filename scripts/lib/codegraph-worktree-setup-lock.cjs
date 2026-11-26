'use strict';
const fs = require('node:fs');
const path = require('node:path');
function withSetupLock(root, callback, options = {}) {
  const fsImpl = options.fs ?? fs;
  const lockPath = path.join(root, '.codegraph-worktree-setup.lock');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  const previousOwner = process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT;
  let acquired = false;
  for (;;) {
    try {
      fsImpl.mkdirSync(lockPath);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const ownerPath = path.join(lockPath, 'owner.json');
      let owner = null;
      try { owner = JSON.parse(fsImpl.readFileSync(ownerPath, 'utf8')); } catch { /* A new owner may still be writing the record. */ }
      const isAlive = options.isProcessAlive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } });
      let lockAgeMs = 0;
      try { lockAgeMs = Date.now() - fsImpl.statSync(lockPath).mtimeMs; } catch { /* A concurrent owner may have just released it. */ }
      const abandonedBeforeOwnerRecord = !owner && lockAgeMs > (options.ownerRecordGraceMs ?? 60_000);
      if (abandonedBeforeOwnerRecord || (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && !isAlive(owner.pid))) {
        const quarantine = lockPath + '.stale-' + process.pid + '-' + Date.now();
        try { fsImpl.renameSync(lockPath, quarantine); fsImpl.rmSync(quarantine, { recursive: true, force: true }); continue; } catch (recoveryError) { if (recoveryError?.code !== 'ENOENT' && recoveryError?.code !== 'EEXIST') throw recoveryError; }
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error('codegraph-worktree-setup-lock-timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    fsImpl.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT = path.resolve(root);
    return callback();
  } finally {
    if (previousOwner === undefined) delete process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT;
    else process.env.NANOFLOW_CODEGRAPH_WORKTREE_SETUP_LOCK_ROOT = previousOwner;
    if (acquired) fsImpl.rmSync(lockPath, { recursive: true, force: true });
  }
}
module.exports = Object.freeze({ withSetupLock });
