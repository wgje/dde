#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { types: utilTypes } = require('node:util');

const CONTRACT = deepFreeze(require('../contracts/codegraph-overlay-generation-v1.json'));
const GENERATION_ID = new RegExp(CONTRACT.patterns.generationId);
const SEQUENCE = new RegExp(CONTRACT.patterns.sequence);

function canonicalize(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError('codegraph-overlay-generation-control-value-invalid');
    }
    return value;
  }
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)) {
    throw new TypeError('codegraph-overlay-generation-control-value-invalid');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError('codegraph-overlay-generation-control-value-invalid');
      }
      return value.map(item => canonicalize(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('codegraph-overlay-generation-control-value-invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
      throw new TypeError('codegraph-overlay-generation-control-value-invalid');
    }
    return Object.fromEntries(Object.keys(descriptors).sort().map(key => [
      key,
      canonicalize(descriptors[key].value, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

function canonicalControlBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, 'utf8');
}

const CONTRACT_DIGEST = crypto.createHash('sha256')
  .update(canonicalControlBytes(CONTRACT))
  .digest('hex');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function writePrettyJson(value, write, maxChunkBytes = 64 * 1024) {
  if (typeof write !== 'function' || !Number.isSafeInteger(maxChunkBytes)
    || maxChunkBytes < 1 || maxChunkBytes > 64 * 1024) {
    throw new TypeError('codegraph-overlay-generation-writer-invalid');
  }
  const hash = crypto.createHash('sha256');
  let byteCount = 0;
  let pendingBytes = 0;
  let pendingText = [];
  const writeBytes = bytes => {
    for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + maxChunkBytes));
      hash.update(chunk);
      byteCount += chunk.length;
      write(chunk);
    }
  };
  const flush = () => {
    if (pendingBytes === 0) return;
    const bytes = Buffer.from(pendingText.join(''), 'utf8');
    pendingBytes = 0;
    pendingText = [];
    writeBytes(bytes);
  };
  const emit = text => {
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > maxChunkBytes) {
      flush();
      writeBytes(Buffer.from(text, 'utf8'));
      return;
    }
    if (pendingBytes > 0 && pendingBytes + textBytes > maxChunkBytes) flush();
    pendingText.push(text);
    pendingBytes += textBytes;
    if (pendingBytes === maxChunkBytes) flush();
  };
  const visit = (item, depth) => {
    if (Array.isArray(item)) {
      if (item.length === 0) return emit('[]');
      emit('[\n');
      for (let index = 0; index < item.length; index += 1) {
        emit('  '.repeat(depth + 1));
        visit(item[index], depth + 1);
        emit(index + 1 === item.length ? '\n' : ',\n');
      }
      emit(`${'  '.repeat(depth)}]`);
      return;
    }
    if (item !== null && typeof item === 'object') {
      const keys = Object.keys(item);
      if (keys.length === 0) return emit('{}');
      emit('{\n');
      keys.forEach((key, index) => {
        emit(`${'  '.repeat(depth + 1)}${JSON.stringify(key)}: `);
        visit(item[key], depth + 1);
        emit(index + 1 === keys.length ? '\n' : ',\n');
      });
      emit(`${'  '.repeat(depth)}}`);
      return;
    }
    const encoded = JSON.stringify(item);
    if (encoded === undefined) throw new TypeError('codegraph-overlay-generation-json-value-invalid');
    emit(encoded);
  };

  visit(value, 0);
  emit('\n');
  flush();
  return Object.freeze({ bytes: byteCount, sha256: hash.digest('hex') });
}

function collectArraySkeleton(value, arrays, jsonPath = []) {
  if (Array.isArray(value)) {
    arrays.push({ jsonPath: [...jsonPath], records: value });
    return [];
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    collectArraySkeleton(child, arrays, [...jsonPath, key]),
  ]));
}

function measuredSink(openFile, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length > CONTRACT.limits.pathCharacters
    || path.isAbsolute(relativePath) || relativePath.includes('\\')
    || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('codegraph-overlay-generation-path-invalid');
  }
  const sink = openFile(relativePath);
  if (!sink || typeof sink.write !== 'function' || typeof sink.close !== 'function') {
    throw new TypeError('codegraph-overlay-generation-sink-invalid');
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let closed = false;
  return {
    byteCount() {
      return bytes;
    },
    write(chunk) {
      if (closed || !Buffer.isBuffer(chunk)) throw new TypeError('codegraph-overlay-generation-sink-write-invalid');
      hash.update(chunk);
      bytes += chunk.length;
      sink.write(chunk);
    },
    close(extra = {}) {
      if (closed) throw new Error('codegraph-overlay-generation-sink-already-closed');
      closed = true;
      sink.close();
      return Object.freeze({ path: relativePath, bytes, sha256: hash.digest('hex'), ...extra });
    },
  };
}

function writePrettyFile(openFile, relativePath, value) {
  const sink = measuredSink(openFile, relativePath);
  writePrettyJson(value, chunk => sink.write(chunk));
  return sink.close();
}

function writeArrayShards(arrayEntry, arrayIndex, openFile) {
  const shards = [];
  let sink = null;
  let count = 0;
  let shardIndex = 0;
  const openShard = () => {
    const relativePath = `${CONTRACT.paths.arrays}/${String(arrayIndex).padStart(4, '0')}/part-${String(shardIndex).padStart(5, '0')}.jsonl`;
    shardIndex += 1;
    sink = measuredSink(openFile, relativePath);
    count = 0;
  };
  const closeShard = () => {
    if (!sink) return;
    shards.push(sink.close({ count }));
    sink = null;
  };

  for (const record of arrayEntry.records) {
    const encoded = JSON.stringify(record);
    if (encoded === undefined) throw new TypeError('codegraph-overlay-generation-record-invalid');
    const line = Buffer.from(`${encoded}\n`, 'utf8');
    if (line.length > CONTRACT.limits.recordBytes) {
      throw new Error('codegraph-overlay-generation-record-too-large');
    }
    if (!sink) openShard();
    if (count > 0 && sinkBytes(sink) + line.length > CONTRACT.limits.shardBytes) {
      closeShard();
      openShard();
    }
    sink.write(line);
    count += 1;
  }
  closeShard();
  return shards;
}

function sinkBytes(sink) {
  return sink.byteCount();
}

function writeGenerationPayload({ overlay, generationId, sequence, openFile }) {
  if (!GENERATION_ID.test(generationId) || !SEQUENCE.test(sequence) || typeof openFile !== 'function') {
    throw new TypeError('codegraph-overlay-generation-payload-invalid');
  }
  const arrays = [];
  const skeletonValue = collectArraySkeleton(overlay, arrays);
  if (arrays.length > CONTRACT.limits.arrayCount) throw new Error('codegraph-overlay-generation-array-limit');
  const compatibility = writePrettyFile(openFile, CONTRACT.paths.compatibility, overlay);
  const skeleton = writePrettyFile(openFile, CONTRACT.paths.skeleton, skeletonValue);
  const arrayDescriptors = arrays.map((entry, index) => ({
    jsonPath: Object.freeze([...entry.jsonPath]),
    count: entry.records.length,
    shards: writeArrayShards(entry, index, openFile),
  }));
  const shardCount = arrayDescriptors.reduce((total, entry) => total + entry.shards.length, 0);
  if (shardCount > CONTRACT.limits.shardCount) throw new Error('codegraph-overlay-generation-shard-limit');
  const totalBytes = compatibility.bytes + skeleton.bytes + arrayDescriptors.reduce(
    (total, entry) => total + entry.shards.reduce((sum, shard) => sum + shard.bytes, 0),
    0,
  );
  if (totalBytes > CONTRACT.limits.generationBytes) throw new Error('codegraph-overlay-generation-byte-limit');
  return deepFreeze({
    compatibility,
    skeleton,
    arrays: arrayDescriptors,
    totalBytes,
  });
}

module.exports = Object.freeze({
  CONTRACT,
  CONTRACT_DIGEST,
  canonicalControlBytes,
  writeGenerationPayload,
  writePrettyJson,
});
