const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const RAW_BYTES = 250_558_329;
const RAW_SHA256 = '2508259e81e9c55b0e0e1058be219c0678564ceac685a72faf42c76d19abf420';
const HISTORICAL_ROOT = 'D:/Code/dde';

/** Unpack a fixed historical test artifact; never read or write a live index. */
async function prepareCompatibilityFixture() {
  const manifest = JSON.parse(await fs.promises.readFile(path.join(__dirname, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.source.bytes !== RAW_BYTES
    || manifest.source.sha256 !== RAW_SHA256 || manifest.source.projectRoot !== HISTORICAL_ROOT
    || manifest.compressed.file !== 'compatibility-20260728.json.gz'
    || manifest.compressed.encoding !== 'gzip') {
    throw new Error('Historical overlay fixture manifest identity mismatch');
  }
  const archivePath = path.join(__dirname, manifest.compressed.file);
  const stat = await fs.promises.lstat(archivePath);
  if (!stat.isFile() || stat.size !== manifest.compressed.bytes) {
    throw new Error('Historical overlay fixture archive missing or size mismatch');
  }
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nanoflow-overlay-v1-known-answer-'));
  const artifactPath = path.join(tempRoot, 'compatibility.json');
  const cleanup = async () => {
    if (path.dirname(tempRoot) !== path.resolve(os.tmpdir())
      || !path.basename(tempRoot).startsWith('nanoflow-overlay-v1-known-answer-')) {
      throw new Error('Historical fixture cleanup escaped its temporary root');
    }
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  };
  const compressedHash = crypto.createHash('sha256');
  const rawHash = crypto.createHash('sha256');
  let compressedBytes = 0;
  let rawBytes = 0;
  try {
    await pipeline(
      fs.createReadStream(archivePath),
      new Transform({ transform(chunk, encoding, callback) {
        compressedHash.update(chunk);
        compressedBytes += chunk.length;
        callback(null, chunk);
      } }),
      zlib.createGunzip(),
      new Transform({ transform(chunk, encoding, callback) {
        rawBytes += chunk.length;
        if (rawBytes > RAW_BYTES) return callback(new Error('Historical fixture exceeds pinned raw size'));
        rawHash.update(chunk);
        callback(null, chunk);
      } }),
      fs.createWriteStream(artifactPath, { flags: 'wx' }),
    );
    if (compressedBytes !== manifest.compressed.bytes
      || compressedHash.digest('hex') !== manifest.compressed.sha256
      || rawBytes !== RAW_BYTES || rawHash.digest('hex') !== RAW_SHA256) {
      throw new Error('Historical overlay fixture digest mismatch');
    }
    return { artifactPath, expectedProjectRoot: HISTORICAL_ROOT, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { prepareCompatibilityFixture };
