'use strict';
const crypto = require('node:crypto');
const predecessor = require('./codegraph-nanoflow-overlay-v1-schema-graph.cjs');
const EXTENSION_ID = 'nanoflow-current-metadata/2';
const NODE_METADATA_ORDERS = Object.freeze([
  ['route-target', [['relation', 'framework', 'path']]],
  ['migration-constraint-validation', [['relation', 'table']]],
  ['migration-index', [['relation', 'table', 'columns', 'method', 'unique', 'concurrently', 'predicate']]],
]);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
const descriptor = JSON.parse(JSON.stringify(predecessor));
for (const [relation, orders] of NODE_METADATA_ORDERS) {
  const row = descriptor.nodeMetadataOrders.find(([name]) => name === relation);
  if (row) row[1].push(...orders); else descriptor.nodeMetadataOrders.push([relation, orders]);
  const objectRule = descriptor.objectRules.find(([name]) => name === 'graph.nodes[].metadata');
  for (const order of orders) if (!objectRule[2].some(existing => JSON.stringify(existing) === JSON.stringify(order))) objectRule[2].push(order);
}
const EDGE_METADATA_ORDERS = [
  ['migration-index', [['relation', 'indexName', 'table', 'columns', 'method', 'unique', 'concurrently', 'predicate']]],
];
for (const [relation, orders] of EDGE_METADATA_ORDERS) {
  descriptor.edgeMetadataOrders.find(([name]) => name === relation)[1].push(...orders);
  descriptor.objectRules.find(([name]) => name === 'graph.edges[].metadata')[2].push(...orders);
}
const variableRelations = descriptor.nodeRelationsByKind.find(([kind]) => kind === 'variable')[1];
variableRelations.push('migration-constraint-validation');
// Rebind the unchanged predecessor validator algorithm to cloned, exact tables.
// Only repository-owned function bytes are evaluated; no input supplies executable text.
const bindings = {
  deepFreeze: freeze,
  NODE_METADATA_ORDERS: descriptor.nodeMetadataOrders,
  EDGE_METADATA_ORDERS: descriptor.edgeMetadataOrders,
  NODE_RELATIONS_BY_KIND: descriptor.nodeRelationsByKind,
  EDGE_RELATIONS_BY_KIND: descriptor.edgeRelationsByKind,
  NODE_KINDS: descriptor.nodeKinds, EDGE_KINDS: descriptor.edgeKinds,
  LANGUAGES: descriptor.languages, VISIBILITIES: descriptor.visibilities,
  NODE_ORDERS_BY_KIND: descriptor.nodeOrdersByKind, EDGE_ORDERS_BY_KIND: descriptor.edgeOrdersByKind,
};
const identityAnchor = '    const templates = {';
const predecessorRuntime = predecessor.createRuntime.toString();
if (predecessorRuntime.split(identityAnchor).length !== 2) throw new Error('current-graph-identity-anchor-drift');
const currentRuntime = predecessorRuntime.replace(identityAnchor,
  identityAnchor + "\n      'migration-constraint-validation': `constraint-validation:${name}:${metadata.table ?? 'unknown-table'}:${lineOrUnknown}`,");
const createRuntime = Function(...Object.keys(bindings), 'return (' + currentRuntime + ');')(...Object.values(bindings));
Object.defineProperty(descriptor, 'createRuntime', { value: createRuntime, enumerable: false });
const { descriptorDigest: ignored, ...projection } = descriptor;
const source = createRuntime.toString().replaceAll('\r\n', '\n').replaceAll('\r', '\n');
const label = 'runtime-source';
const frame = Buffer.byteLength(label) + ':' + label + Buffer.byteLength(source) + ':' + source;
descriptor.descriptorDigest = crypto.createHash('sha256').update('nanoflow-overlay-v1-descriptor\0graph\0' + canonical(projection) + '\0' + frame).digest('hex');
module.exports = freeze({ EXTENSION_ID, NODE_METADATA_ORDERS, EDGE_METADATA_ORDERS, descriptor });
