'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const contract = deepFreeze(require('../contracts/codegraph-nanoflow-overlay-v1.json'));
const sourcePolicy = require('./codegraph-source-policy.cjs');
const typescriptDescriptor = deepFreeze(require('./codegraph-nanoflow-overlay-v1-schema-typescript.cjs'));
const angularSupportDescriptor = deepFreeze(require('./codegraph-nanoflow-overlay-v1-schema-angular-support.cjs'));
const supabaseAndroidDescriptor = deepFreeze(require('./codegraph-nanoflow-overlay-v1-schema-supabase-android.cjs'));
const graphDescriptor = deepFreeze(require('./codegraph-nanoflow-overlay-v1-schema-graph.cjs'));

const DESCRIPTORS = deepFreeze([
  typescriptDescriptor,
  angularSupportDescriptor,
  supabaseAndroidDescriptor,
  graphDescriptor,
]);
const ARRAY_SUMMARY = Symbol('overlay-v1-array-summary');
const WAIT = Symbol('overlay-v1-parser-wait');
const STARTED = Symbol('overlay-v1-parser-started');
const OVERLAY_V1_SCHEMA_VERSION = 1;

class OverlayV1SchemaError extends Error {
  constructor(code, schemaPath = '', diagnostics) {
    super(code);
    this.name = 'OverlayV1SchemaError';
    this.code = code;
    this.schemaPath = schemaPath;
    Object.assign(this, diagnostics ? { diagnostics } : {});
  }
}

function fail(code, schemaPath = '') {
  throw new OverlayV1SchemaError(code, schemaPath);
}
function deepFreeze(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function') || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value);
  }
  return value;
}
function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareOrdinal)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digestFrame(label, payload) {
  return `${Buffer.byteLength(label)}:${label}${Buffer.byteLength(payload)}:${payload}`;
}
function descriptorContentDigest(descriptor) {
  const { descriptorDigest: _descriptorDigest, ...projection } = descriptor;
  const runtimeSource = typeof descriptor.createRuntime === 'function'
    ? Function.prototype.toString.call(descriptor.createRuntime) : '';
  const runtimeFrame = runtimeSource ? `\0${digestFrame('runtime-source', runtimeSource)}` : '';
  return crypto.createHash('sha256')
    .update(`nanoflow-overlay-v1-descriptor\0${descriptor.name}\0${canonicalJson(projection)}${runtimeFrame}`)
    .digest('hex');
}
const descriptorEntries = DESCRIPTORS.map(descriptor => ({
  name: descriptor.name,
  digest: descriptorContentDigest(descriptor),
}));
const runtimeDescriptorDigests = Object.fromEntries(descriptorEntries.map(({ name, digest }) => [name, digest]));
const runtimeDescriptorManifestDigest = crypto.createHash('sha256')
  .update(`${contract.digestDomain}\0descriptor-manifest-v1\0${canonicalJson(descriptorEntries)}`)
  .digest('hex');
for (const descriptor of DESCRIPTORS) {
  if (descriptor.descriptorDigest !== runtimeDescriptorDigests[descriptor.name]
    || contract.descriptorDigests[descriptor.name] !== runtimeDescriptorDigests[descriptor.name]) {
    fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
  }
}
if (contract.descriptorManifestDigest !== runtimeDescriptorManifestDigest) {
  fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
}
const { schemaDigest: _schemaDigest, ...literalContractProjection } = contract;
const contractProjection = {
  ...literalContractProjection,
  descriptorDigests: runtimeDescriptorDigests,
  descriptorManifestDigest: runtimeDescriptorManifestDigest,
};
const digestFrames = [
  ['contract', canonicalJson(contractProjection)],
  ['source-policy', contract.sourcePolicyDigest],
  ...Object.entries(runtimeDescriptorDigests),
];
const COMPUTED_SCHEMA_DIGEST = crypto.createHash('sha256')
  .update(`${contract.digestDomain}\0schema-digest-v1\0${digestFrames
    .map(([label, payload]) => digestFrame(label, payload)).join('\0')}\0`)
  .digest('hex');
const OVERLAY_V1_SCHEMA_DIGEST = COMPUTED_SCHEMA_DIGEST;
const OVERLAY_V1_LIMITS = deepFreeze({ ...contract.limits });
function descriptorIndex() {
  const objectRules = new Map();
  const arrayPaths = new Set();
  const scalarTypes = new Map();
  for (const descriptor of DESCRIPTORS) {
    for (const [schemaPath, keys, orders] of descriptor.objectRules) {
      if (objectRules.has(schemaPath)) fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
      const exactOrders = orders.map(order => Object.freeze([...order]));
      objectRules.set(schemaPath, {
        keys: new Set(keys),
        required: new Set(keys.filter(key => exactOrders.every(order => order.includes(key)))),
        orders: exactOrders,
      });
    }
    for (const schemaPath of descriptor.arrayPaths) {
      if (arrayPaths.has(schemaPath)) fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
      arrayPaths.add(schemaPath);
    }
    for (const [types, paths] of descriptor.scalarTypeGroups) {
      for (const schemaPath of paths) {
        if (scalarTypes.has(schemaPath)) fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
        scalarTypes.set(schemaPath, new Set(types));
      }
    }
  }
  return { objectRules, arrayPaths, scalarTypes };
}
const INDEX = descriptorIndex();
function arraySummary(length) {
  return Object.freeze({ [ARRAY_SUMMARY]: true, length });
}
function isArraySummary(value) {
  return Boolean(value?.[ARRAY_SUMMARY]);
}
function normalizedProjectRoot(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
}
const REPOSITORY_FIELDS = new Set(contract.pathPolicy.repositoryFieldNames);
const DIRECTORY_FIELDS = new Set(contract.pathPolicy.directoryFieldNames);
const GRAPH = graphDescriptor.createRuntime({
  contract, canonicalJson, canonicalRepositoryPath, fail,
  runtimeIntl: Intl, runtimeIcuVersion: process.versions.icu,
});
const STATIC_COUNTS = deepFreeze({ objectPaths: INDEX.objectRules.size, arrayPaths: INDEX.arrayPaths.size,
  scalarPaths: INDEX.scalarTypes.size, ...GRAPH.staticCounts });

class OverlaySchemaEngine {
  constructor(options, limits = OVERLAY_V1_LIMITS) {
    if (!options || typeof options.expectedProjectRoot !== 'string') {
      fail('OVERLAY_SCHEMA_VALUE', 'project.root');
    }
    if (options.expectedSourcePolicyDigest !== sourcePolicy.SOURCE_POLICY_DIGEST
      || sourcePolicy.SOURCE_POLICY_DIGEST !== contract.sourcePolicyDigest) {
      fail('OVERLAY_SCHEMA_SOURCE_POLICY_MISMATCH');
    }
    if (contract.schemaVersion !== OVERLAY_V1_SCHEMA_VERSION
      || contract.schemaDigest !== COMPUTED_SCHEMA_DIGEST) {
      fail('OVERLAY_SCHEMA_DIGEST_MISMATCH');
    }
    this.expectedProjectRoot = normalizedProjectRoot(options.expectedProjectRoot);
    this.limits = limits;
    this.nodeIds = new Set();
    this.selectedSources = new Set();
    this.pathCases = new Map();
    this.orderState = { node: null, edge: null };
    this.counts = {
      ...STATIC_COUNTS,
      valueTokens: 0,
      stringValues: 0,
      keyTokens: 0,
      stringTokens: 0,
      decodedStringBytes: 0,
      stringScanCodeUnits: 0,
      maxStringBytes: 0,
      maxBufferedTokenBytes: 0,
      maxInputWindowBytes: 0,
      maxDepth: 0,
      graphNodes: 0,
      graphEdges: 0,
      endpointIdBytes: 0,
      pathWitnessBytes: 0,
      pathWitnesses: 0,
      nodeTieGroups: 0, nodeTieExtraItems: 0, nodeMaxTieGroup: 0,
      edgeTieGroups: 0, edgeTieExtraItems: 0, edgeMaxTieGroup: 0,
    };
  }
  assertKind(schemaPath, kind) {
    const accepted = kind === 'object' ? INDEX.objectRules.has(schemaPath)
      : kind === 'array' ? INDEX.arrayPaths.has(schemaPath) : INDEX.scalarTypes.has(schemaPath);
    if (!accepted) fail('OVERLAY_SCHEMA_TYPE', schemaPath);
  }
  beginContainer(schemaPath, kind, depth) {
    this.assertKind(schemaPath, kind);
    this.counts.maxDepth = Math.max(this.counts.maxDepth, depth);
    if (depth > this.limits.depth) fail('OVERLAY_SCHEMA_DEPTH_LIMIT', schemaPath);
  }
  objectKey(schemaPath, key, seen, sequence) {
    const rule = INDEX.objectRules.get(schemaPath);
    if (!rule) fail('OVERLAY_SCHEMA_TYPE', schemaPath);
    if (seen.has(key)) fail('OVERLAY_SCHEMA_DUPLICATE_KEY', schemaPath);
    if (!rule.keys.has(key)) fail('OVERLAY_SCHEMA_UNKNOWN_KEY', schemaPath);
    this.countString(key, true, schemaPath);
    sequence.push(key);
  }
  validateObject(schemaPath, value, seen, sequence) {
    const rule = INDEX.objectRules.get(schemaPath);
    for (const key of rule.required) {
      if (!seen.has(key)) fail('OVERLAY_SCHEMA_MISSING_KEY', schemaPath);
    }
    const canonicalOrder = rule.orders.some(order => (
      order.length === sequence.length && order.every((key, index) => key === sequence[index])
    ));
    if (!canonicalOrder) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON', schemaPath);
    if (schemaPath === '') this.validateRoot(value);
    if (schemaPath === 'graph.nodes[]') {
      try { GRAPH.validateNode(this, value, sequence); }
      catch (error) {
        if (error?.code !== 'OVERLAY_SCHEMA_INVALID_PATH' || error?.schemaPath !== 'graph.nodes[].filePath') throw error;
        const normalized = canonicalRepositoryPath(value.filePath, false);
        throw new OverlayV1SchemaError('OVERLAY_SCHEMA_INVALID_PATH', 'graph.nodes[].filePath', {
          nodeIndex: this.counts.graphNodes, nodeId: value.id, kind: value.kind,
          filePath: value.filePath, metadataRelation: value.metadata?.relation ?? null,
          selectedSource: Boolean(normalized && this.selectedSources.has(normalized)),
        });
      }
    }
    if (schemaPath === 'graph.edges[]') GRAPH.validateEdge(this, value, sequence);
    this.completeValue(schemaPath);
  }
  validateRoot(value) {
    if (value.schemaVersion !== OVERLAY_V1_SCHEMA_VERSION) fail('OVERLAY_SCHEMA_VALUE', 'schemaVersion');
    if (normalizedProjectRoot(value.project?.root) !== this.expectedProjectRoot) {
      fail('OVERLAY_SCHEMA_VALUE', 'project.root');
    }
    if (!Array.isArray(value.coverageTargets)
      || JSON.stringify(value.coverageTargets) !== JSON.stringify(contract.coverageTargets)) {
      fail('OVERLAY_SCHEMA_VALUE', 'coverageTargets');
    }
    if (value.graph?.schemaVersion !== OVERLAY_V1_SCHEMA_VERSION) {
      fail('OVERLAY_SCHEMA_VALUE', 'graph.schemaVersion');
    }
  }

  recordGraphPath(value, schemaPath = 'graph.nodes[].filePath') {
    const bytes = Buffer.byteLength(value);
    const folded = value.toLowerCase();
    const prior = this.pathCases.get(folded);
    if (prior && prior !== value) fail('OVERLAY_SCHEMA_CASE_COLLISION', schemaPath);
    if (!prior) {
      this.counts.pathWitnessBytes += bytes;
      this.pathCases.set(folded, value);
    }
    this.counts.pathWitnesses = this.pathCases.size;
    if (bytes > this.limits.singlePathBytes || this.pathCases.size > this.limits.pathWitnesses
      || this.counts.pathWitnessBytes > this.limits.pathWitnessBytes) {
      fail('OVERLAY_SCHEMA_LIMIT', schemaPath);
    }
  }

  validateArray(schemaPath, length) {
    this.validateArrayLength(schemaPath, length);
    this.completeValue(schemaPath);
  }

  validateArrayLength(schemaPath, length) {
    let limit = this.limits.defaultArray;
    if (schemaPath === 'graph.nodes') limit = this.limits.graphNodes;
    if (schemaPath === 'graph.edges') limit = this.limits.graphEdges;
    if (schemaPath === 'typescript.imports') limit = this.limits.typescriptImports;
    if (schemaPath === 'typescript.functions') limit = this.limits.typescriptFunctions;
    if (schemaPath === 'typescript.exports') limit = this.limits.typescriptExports;
    if (schemaPath === 'typescript.variables') limit = this.limits.typescriptVariables;
    if (length > limit) fail('OVERLAY_SCHEMA_ARRAY_LIMIT', schemaPath);
  }

  validateScalar(schemaPath, value, depth) {
    this.counts.maxDepth = Math.max(this.counts.maxDepth, depth);
    const actualType = value === null ? 'null' : typeof value;
    const expected = INDEX.scalarTypes.get(schemaPath);
    if (!expected?.has(actualType)) fail('OVERLAY_SCHEMA_TYPE', schemaPath);
    if (actualType === 'number' && (!Number.isSafeInteger(value) || !Number.isFinite(value))) {
      fail('OVERLAY_SCHEMA_VALUE', schemaPath);
    }
    if ((GRAPH.isLinePath(schemaPath) && value < contract.coordinatePolicy.lineMinimum)
      || (GRAPH.isColumnPath(schemaPath) && value < contract.coordinatePolicy.columnMinimum)) {
      fail('OVERLAY_SCHEMA_VALUE', schemaPath);
    }
    if (actualType === 'string') {
      this.countString(value, false, schemaPath);
      if (schemaPath === 'generatedAt') this.generatedAt = value;
      const field = schemaPath.split('.').at(-1).replace(/\[\]$/, '');
      const graphPathKind = GRAPH.repositoryPathKind(schemaPath);
      const graphRepositoryPath = graphPathKind !== null;
      const graphDeclaredPath = schemaPath.startsWith('graph.')
        && schemaPath.includes('.metadata.') && REPOSITORY_FIELDS.has(field);
      if (graphRepositoryPath || graphDeclaredPath || (!schemaPath.startsWith('graph.') && REPOSITORY_FIELDS.has(field))) {
        const directory = graphPathKind === 'directory'
          || (!graphRepositoryPath && DIRECTORY_FIELDS.has(field));
        const normalized = canonicalRepositoryPath(value, directory);
        if (!normalized) fail('OVERLAY_SCHEMA_INVALID_PATH', schemaPath);
        if (graphRepositoryPath || graphDeclaredPath) this.recordGraphPath(normalized, schemaPath);
        else this.selectedSources.add(normalized);
      }
      if (schemaPath === 'generatedAt'
        && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
          || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value)) {
        fail('OVERLAY_SCHEMA_VALUE', schemaPath);
      }
    }
    this.completeValue(schemaPath);
  }

  completeValue(schemaPath) {
    this.counts.valueTokens += 1;
    if (this.counts.valueTokens > this.limits.valueTokens) fail('OVERLAY_SCHEMA_LIMIT', schemaPath);
  }

  countString(value, key, schemaPath) {
    const bytes = Buffer.byteLength(value, 'utf8');
    this.counts[key ? 'keyTokens' : 'stringValues'] += 1;
    this.counts.stringTokens += 1;
    this.counts.decodedStringBytes += bytes;
    this.counts.maxStringBytes = Math.max(this.counts.maxStringBytes, bytes);
    if (bytes > this.limits.singleStringBytes
      || this.counts.stringTokens > this.limits.stringTokens
      || this.counts.decodedStringBytes > this.limits.decodedStringBytes) {
      fail('OVERLAY_SCHEMA_STRING_LIMIT', schemaPath);
    }
  }

  shouldRetainArray(schemaPath) {
    return schemaPath === 'coverageTargets';
  }

  shouldRetainObject(schemaPath) {
    return schemaPath === '' || schemaPath === 'project' || schemaPath === 'graph'
      || schemaPath.startsWith('graph.nodes[]') || schemaPath.startsWith('graph.edges[]');
  }
}

class CanonicalJsonStreamParser {
  constructor(engine) {
    this.engine = engine;
    this.decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    this.buffer = '';
    this.position = 0;
    this.stack = [];
    this.rootState = 'value';
    this.seenFirstText = false;
    this.pendingString = null;
    this.pendingPrimitive = null;
  }

  write(bytes) {
    let text;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      fail('OVERLAY_SCHEMA_INVALID_UTF8');
    }
    this.append(text, false);
  }

  finish() {
    let text;
    try {
      text = this.decoder.decode();
    } catch {
      fail('OVERLAY_SCHEMA_INVALID_UTF8');
    }
    this.append(text, true);
    if (this.rootState !== 'done' || this.stack.length !== 0 || this.buffer.length !== 0) {
      fail('OVERLAY_SCHEMA_TRUNCATED');
    }
  }

  append(text, final) {
    if (!this.seenFirstText && text.length > 0) {
      this.seenFirstText = true;
      if (text.charCodeAt(0) === 0xfeff) fail('OVERLAY_SCHEMA_BOM');
    }
    this.buffer += text;
    this.pump(final);
    if (this.position > 0) {
      const consumed = this.position;
      this.buffer = this.buffer.slice(consumed);
      if (this.pendingString) {
        this.pendingString.start -= consumed;
        this.pendingString.index -= consumed;
      }
      if (this.pendingPrimitive) {
        this.pendingPrimitive.start -= consumed;
        this.pendingPrimitive.end -= consumed;
      }
      this.position = 0;
    }
  }

  pump(final) {
    while (true) {
      const beforePosition = this.position;
      const beforeDepth = this.stack.length;
      const beforeRootState = this.rootState;
      if (this.rootState === 'done') {
        if (this.buffer.length === this.position) break;
        fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
      }
      if (this.stack.length === 0) {
        if (this.rootState === 'value') {
          const parsed = this.parseValue('', final);
          if (parsed === WAIT) break;
        } else if (this.rootState === 'after') {
          if (!this.consumeExact('\n', final)) break;
          this.rootState = 'done';
        }
      } else {
        const frame = this.stack.at(-1);
        const progressed = frame.type === 'object'
          ? this.pumpObject(frame, final)
          : this.pumpArray(frame, final);
        if (!progressed) break;
      }
      if (beforePosition === this.position
        && beforeDepth === this.stack.length
        && beforeRootState === this.rootState) break;
    }
    if (final && this.rootState !== 'done' && this.position === this.buffer.length) {
      fail('OVERLAY_SCHEMA_TRUNCATED');
    }
  }

  pumpObject(frame, final) {
    if (frame.state === 'open') {
      if (this.peek() === '}') {
        this.position += 1;
        this.closeObject(frame);
        return true;
      }
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) return false;
      frame.state = 'key';
      return true;
    }
    if (frame.state === 'key') {
      const key = this.parseString(final, true);
      if (key === WAIT) return false;
      this.engine.objectKey(frame.path, key, frame.keys, frame.keyOrder);
      frame.keys.add(key);
      frame.pendingKey = key;
      frame.state = 'colon';
      return true;
    }
    if (frame.state === 'colon') {
      if (!this.consumeExact(': ', final)) return false;
      frame.state = 'value';
      return true;
    }
    if (frame.state === 'value') {
      return this.parseValue(childPath(frame.path, frame.pendingKey), final) !== WAIT;
    }
    if (frame.state === 'after') {
      if (this.peek() === ',') {
        this.position += 1;
        if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) {
          frame.state = 'comma-newline';
          return false;
        }
        frame.state = 'key';
        return true;
      }
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth - 1)}}`, final)) return false;
      this.closeObject(frame);
      return true;
    }
    if (frame.state === 'comma-newline') {
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) return false;
      frame.state = 'key';
      return true;
    }
    return false;
  }

  pumpArray(frame, final) {
    if (frame.state === 'open') {
      if (this.peek() === ']') {
        this.position += 1;
        this.closeArray(frame);
        return true;
      }
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) return false;
      frame.state = 'value';
      return true;
    }
    if (frame.state === 'value') {
      // Reject a new element before parsing/retaining an unfinished value. This
      // keeps collection cardinality bounded even when a caller splits the
      // next element across arbitrarily many writes.
      this.engine.validateArrayLength(frame.path, frame.length + 1);
      return this.parseValue(`${frame.path}[]`, final) !== WAIT;
    }
    if (frame.state === 'after') {
      if (this.peek() === ',') {
        this.position += 1;
        if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) {
          frame.state = 'comma-newline';
          return false;
        }
        frame.state = 'value';
        return true;
      }
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth - 1)}]`, final)) return false;
      this.closeArray(frame);
      return true;
    }
    if (frame.state === 'comma-newline') {
      if (!this.consumeExact(`\n${'  '.repeat(frame.depth)}`, final)) return false;
      frame.state = 'value';
      return true;
    }
    return false;
  }

  parseValue(schemaPath, final) {
    const character = this.peek();
    if (character === undefined) return WAIT;
    if (character === '{') {
      this.position += 1;
      const depth = this.stack.length + 1;
      this.engine.beginContainer(schemaPath, 'object', depth);
      this.stack.push({
        type: 'object', path: schemaPath, depth, state: 'open',
        value: this.engine.shouldRetainObject(schemaPath) ? {} : null,
        keys: new Set(), keyOrder: [], pendingKey: null,
      });
      return STARTED;
    }
    if (character === '[') {
      this.position += 1;
      const depth = this.stack.length + 1;
      this.engine.beginContainer(schemaPath, 'array', depth);
      this.stack.push({
        type: 'array', path: schemaPath, depth, state: 'open', length: 0,
        retained: this.engine.shouldRetainArray(schemaPath) ? [] : null,
      });
      return STARTED;
    }
    const value = character === '"'
      ? this.parseString(final, false)
      : this.parsePrimitive(final);
    if (value === WAIT) return WAIT;
    this.engine.assertKind(schemaPath, 'scalar');
    this.engine.validateScalar(schemaPath, value, this.stack.length + 1);
    this.deliver(value);
    return value;
  }

  parseString(final, key) {
    if (this.peek() === undefined) {
      if (final) fail('OVERLAY_SCHEMA_TRUNCATED');
      return WAIT;
    }
    const start = this.position;
    let scan = this.pendingString;
    if (!scan) {
      if (this.peek() !== '"') fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
      scan = { start, index: start + 1, escaped: false, bytes: 1, key };
      this.pendingString = scan;
    } else if (scan.start !== start || scan.key !== key) fail('OVERLAY_SCHEMA_VALUE');
    let { index, escaped } = scan;
    const segmentStart = index;
    while (index < this.buffer.length) {
      const code = this.buffer.charCodeAt(index);
      this.engine.counts.stringScanCodeUnits += 1;
      if (!escaped && code === 0x22) {
        index += 1;
        scan.bytes += Buffer.byteLength(this.buffer.slice(segmentStart, index), 'utf8');
        this.trackTokenBytes(scan.bytes, this.engine.limits.encodedStringTokenBytes);
        const raw = this.buffer.slice(start, index);
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          fail('OVERLAY_SCHEMA_VALUE');
        }
        if (JSON.stringify(value) !== raw || hasUnpairedSurrogate(value)) {
          fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
        }
        this.pendingString = null;
        this.position = index;
        return value;
      }
      if (!escaped && code < 0x20) fail('OVERLAY_SCHEMA_VALUE');
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      index += 1;
    }
    scan.bytes += Buffer.byteLength(this.buffer.slice(segmentStart, index), 'utf8');
    scan.index = index;
    scan.escaped = escaped;
    this.trackTokenBytes(scan.bytes, this.engine.limits.encodedStringTokenBytes);
    if (final) fail('OVERLAY_SCHEMA_TRUNCATED');
    return WAIT;
  }

  parsePrimitive(final) {
    const scan = this.pendingPrimitive ?? { start: this.position, end: this.position };
    const start = scan.start;
    const first = this.buffer[start];
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (first !== literal[0]) continue;
      const available = this.buffer.slice(start, start + literal.length);
      if (available.length < literal.length) {
        if (!literal.startsWith(available)) fail('OVERLAY_SCHEMA_VALUE');
        if (final) fail('OVERLAY_SCHEMA_TRUNCATED');
        return WAIT;
      }
      if (available !== literal) fail('OVERLAY_SCHEMA_VALUE');
      if (!this.hasValueDelimiter(start + literal.length, final)) return WAIT;
      this.position += literal.length;
      return value;
    }
    let end = scan.end;
    while (end < this.buffer.length && !isValueDelimiter(this.buffer[end])) {
      if (end - start >= this.engine.limits.numericTokenBytes) fail('OVERLAY_SCHEMA_TOKEN_LIMIT');
      if (this.buffer.charCodeAt(end) > 0x7f) fail('OVERLAY_SCHEMA_VALUE');
      end += 1;
    }
    if (end === this.buffer.length && !final) {
      // Enforce the numeric token bound before returning WAIT. Without this
      // check an unfinished token at the boundary could be retained and
      // rescanned on every subsequent write.
      scan.end = end;
      this.pendingPrimitive = scan;
      this.trackTokenBytes(end - start, this.engine.limits.numericTokenBytes);
      return WAIT;
    }
    const raw = this.buffer.slice(start, end);
    this.trackToken(raw, this.engine.limits.numericTokenBytes);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) fail('OVERLAY_SCHEMA_VALUE');
    const value = Number(raw);
    if (!Number.isFinite(value) || JSON.stringify(value) !== raw) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
    this.pendingPrimitive = null;
    this.position = end;
    return value;
  }

  hasValueDelimiter(index, final) {
    if (index < this.buffer.length) {
      if (!isValueDelimiter(this.buffer[index])) fail('OVERLAY_SCHEMA_VALUE');
      return true;
    }
    if (final) return true;
    return false;
  }

  trackToken(raw, limit) {
    this.trackTokenBytes(Buffer.byteLength(raw, 'utf8'), limit);
  }

  trackTokenBytes(bytes, limit) {
    this.engine.counts.maxBufferedTokenBytes = Math.max(this.engine.counts.maxBufferedTokenBytes, bytes);
    if (bytes > limit) fail('OVERLAY_SCHEMA_TOKEN_LIMIT');
  }

  closeObject(frame) {
    if (this.stack.at(-1) !== frame) fail('OVERLAY_SCHEMA_VALUE');
    this.stack.pop();
    this.engine.validateObject(frame.path, frame.value, frame.keys, frame.keyOrder);
    this.deliver(frame.value);
  }

  closeArray(frame) {
    if (this.stack.at(-1) !== frame) fail('OVERLAY_SCHEMA_VALUE');
    this.stack.pop();
    this.engine.validateArray(frame.path, frame.length);
    this.deliver(frame.retained ?? arraySummary(frame.length));
  }

  deliver(value) {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.rootState !== 'value') fail('OVERLAY_SCHEMA_VALUE');
      this.rootState = 'after';
      return;
    }
    if (parent.type === 'object') {
      if (parent.value) parent.value[parent.pendingKey] = value;
      parent.pendingKey = null;
      parent.state = 'after';
      return;
    }
    this.engine.validateArrayLength(parent.path, parent.length + 1);
    parent.length += 1;
    if (parent.retained) parent.retained.push(value);
    parent.state = 'after';
  }

  consumeExact(expected, final) {
    const available = this.buffer.slice(this.position, this.position + expected.length);
    if (available.length < expected.length) {
      if (!expected.startsWith(available)) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
      if (final) fail('OVERLAY_SCHEMA_TRUNCATED');
      return false;
    }
    if (available !== expected) fail('OVERLAY_SCHEMA_NON_CANONICAL_JSON');
    this.position += expected.length;
    return true;
  }

  peek() {
    return this.position < this.buffer.length ? this.buffer[this.position] : undefined;
  }
}

function childPath(parentPath, key) {
  return parentPath ? `${parentPath}.${key}` : key;
}

function canonicalRepositoryPath(value, directory) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:|^\//.test(value)) return null;
  const candidate = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  return candidate && !candidate.includes(':') && sourcePolicy.normalizeRepositoryPath(candidate) === candidate ? candidate : null;
}

function isValueDelimiter(character) {
  return character === ',' || character === ']' || character === '}' || character === '\n';
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function createOverlayV1Validator(options) {
  return createOverlayV1ValidatorWithLimits(options, OVERLAY_V1_LIMITS);
}

function createOverlayV1ValidatorWithLimits(options, limits) {
  const engine = new OverlaySchemaEngine(options, limits);
  const parser = new CanonicalJsonStreamParser(engine);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let state = 'open';
  const assertOpen = () => {
    if (state === 'poisoned') fail('OVERLAY_SCHEMA_POISONED');
    if (state === 'finished') fail('OVERLAY_SCHEMA_ALREADY_FINISHED');
  };
  const attempt = action => {
    try { return action(); } catch (error) { state = 'poisoned'; throw error; }
  };
  return Object.freeze({
    write(chunk) {
      assertOpen();
      return attempt(() => {
        if (!(chunk instanceof Uint8Array)) fail('OVERLAY_SCHEMA_TYPE');
        bytes += chunk.byteLength;
        if (bytes > limits.artifactBytes) fail('OVERLAY_SCHEMA_ARTIFACT_LIMIT');
        engine.counts.maxInputWindowBytes = Math.min(bytes, limits.inputWindowBytes);
        hash.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; offset += limits.inputWindowBytes) {
          parser.write(chunk.subarray(offset, offset + limits.inputWindowBytes));
        }
      });
    },
    finish() {
      assertOpen();
      return attempt(() => {
        parser.finish();
        const artifact = { bytes, sha256: hash.digest('hex') };
        const expected = options.expectedArtifact;
        if (expected && (expected.bytes !== bytes || expected.sha256 !== artifact.sha256
          || Object.entries(expected.counts).some(([key, value]) => engine.counts[key] !== value))) {
          fail('OVERLAY_SCHEMA_PROFILE_MISMATCH');
        }
        state = 'finished';
        return deepFreeze({ schemaVersion: OVERLAY_V1_SCHEMA_VERSION,
          schemaDigest: OVERLAY_V1_SCHEMA_DIGEST, sourcePolicyDigest: sourcePolicy.SOURCE_POLICY_DIGEST,
          artifact, counts: { ...engine.counts } });
      });
    },
  });
}

module.exports = {
  OVERLAY_V1_SCHEMA_VERSION,
  OVERLAY_V1_SCHEMA_DIGEST,
  OVERLAY_V1_LIMITS,
  OverlayV1SchemaError,
  createOverlayV1Validator,
};
