'use strict';

const path = require('node:path');

const stateStorePath = path.resolve(__dirname, '../../../../scripts/context7-key-pool/state-store.cjs');
const { createStateStore } = require(stateStorePath);

const identities = [1, 2, 3, 4].map(slot => ({
  slot,
  fingerprintSha256: String(slot).repeat(64),
}));

async function main() {
  const [stateDir, isoTime, reportMode] = process.argv.slice(2);
  const fixedNow = new Date(isoTime);
  if (!stateDir || Number.isNaN(fixedNow.getTime())) throw new Error('invalid-worker-input');

  const store = createStateStore({
    stateDir,
    now: () => new Date(fixedNow),
    lockWaitMs: 30_000,
  });
  const context = { identities, timeZone: 'UTC' };
  const preview = await store.preview(context);
  let reserved = await store.reserveExpected(context, preview.route);
  for (let attempt = 1; reserved.kind === 'retry' && attempt < 8; attempt += 1) {
    reserved = await store.reserveExpected(context, reserved.route);
  }
  if (reserved.kind !== 'keyed' || !reserved.token) {
    throw new Error('state-reserve-worker-not-keyed');
  }
  if (reportMode === '--report') {
    process.stdout.write(JSON.stringify({ kind: reserved.kind, route: reserved.route, token: reserved.token }) + '\n');
  }
}

main().catch(() => {
  process.stderr.write('state-reserve-worker-failed\n');
  process.exitCode = 1;
});
