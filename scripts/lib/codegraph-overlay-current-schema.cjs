'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const predecessor = require('./codegraph-nanoflow-overlay-v1-schema.cjs');
const currentGraph = require('./codegraph-nanoflow-overlay-current-graph.cjs');
const currentContract = require('../contracts/codegraph-overlay-current-schema.json');
const currentGeneration = require('../contracts/codegraph-overlay-current-generation.json');
const predecessorGeneration = require('../contracts/codegraph-overlay-generation-v1.json');
const { canonicalControlBytes } = require('./codegraph-overlay-generation-format.cjs');
if (currentContract.extensionId !== currentGraph.EXTENSION_ID
  || currentContract.predecessorSchemaDigest !== predecessor.OVERLAY_V1_SCHEMA_DIGEST
  || currentGeneration.overlaySchemaDigest !== currentContract.schemaDigest) throw new Error('current-schema-identity-mismatch');
const schemaPath = path.join(__dirname, 'codegraph-nanoflow-overlay-v1-schema.cjs');
const baseRequire = createRequire(schemaPath);
const isolatedModule = { exports: {} };
// Execute the unchanged streaming validator with registered current descriptors.
// Historical consumers still load the unmodified predecessor module and digest.
vm.runInNewContext(fs.readFileSync(schemaPath, 'utf8'), {
  Buffer, Intl, Map, Object, Set, Symbol, TextDecoder, Uint8Array, process,
  module: isolatedModule, exports: isolatedModule.exports,
  require: request => request === '../contracts/codegraph-nanoflow-overlay-v1.json' ? currentContract
    : request === './codegraph-nanoflow-overlay-v1-schema-graph.cjs' ? currentGraph.descriptor : baseRequire(request),
}, { filename: schemaPath });
const current = isolatedModule.exports;
if (current.OVERLAY_V1_SCHEMA_DIGEST !== currentContract.schemaDigest) throw new Error('current-schema-runtime-digest-mismatch');
const profile = (contract, schema) => Object.freeze({ contract, schema,
  contractDigest: crypto.createHash('sha256').update(canonicalControlBytes(contract)).digest('hex') });
const predecessorProfile = profile(predecessorGeneration, predecessor);
Object.freeze(currentGeneration);
const currentProfile = profile(currentGeneration, current);
const metadataV1Contract = require('../contracts/codegraph-overlay-metadata-v1-schema.json');
const metadataV1Generation = require('../contracts/codegraph-overlay-metadata-v1-generation.json');
const metadataV1Graph = require('./codegraph-nanoflow-overlay-metadata-v1-graph.cjs');
if (metadataV1Contract.extensionId !== metadataV1Graph.EXTENSION_ID
  || metadataV1Contract.predecessorSchemaDigest !== predecessor.OVERLAY_V1_SCHEMA_DIGEST
  || metadataV1Generation.overlaySchemaDigest !== metadataV1Contract.schemaDigest) throw new Error('metadata-v1-schema-identity-mismatch');
const metadataV1Module = { exports: {} };
vm.runInNewContext(fs.readFileSync(schemaPath, 'utf8'), {
  Buffer, Intl, Map, Object, Set, Symbol, TextDecoder, Uint8Array, process,
  module: metadataV1Module, exports: metadataV1Module.exports,
  require: request => request === '../contracts/codegraph-nanoflow-overlay-v1.json' ? metadataV1Contract
    : request === './codegraph-nanoflow-overlay-v1-schema-graph.cjs' ? metadataV1Graph.descriptor : baseRequire(request),
}, { filename: schemaPath });
if (metadataV1Module.exports.OVERLAY_V1_SCHEMA_DIGEST !== metadataV1Contract.schemaDigest) throw new Error('metadata-v1-schema-runtime-digest-mismatch');
const metadataV1Profile = profile(metadataV1Generation, metadataV1Module.exports);

function selectOverlaySchemaProfile(digest) {
  if (digest === predecessorGeneration.overlaySchemaDigest) return predecessorProfile;
  if (digest === currentGeneration.overlaySchemaDigest) return currentProfile;
  if (digest === metadataV1Generation.overlaySchemaDigest) return metadataV1Profile;
  throw new Error('unregistered-overlay-schema-digest');
}
module.exports = Object.freeze({ CURRENT_SCHEMA_DIGEST: currentContract.schemaDigest,
  CURRENT_EXTENSION_ID: currentGraph.EXTENSION_ID, CURRENT_NODE_METADATA_ORDERS: currentGraph.NODE_METADATA_ORDERS,
  createCurrentOverlayValidator: current.createOverlayV1Validator, selectOverlaySchemaProfile });
