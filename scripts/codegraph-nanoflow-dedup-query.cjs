'use strict';

const CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY = [
  'docs/codegraph-nanoflow-dedup-contract.json',
  'scripts/validate-codegraph-overlay-docs.cjs',
  'scripts/query-codegraph-nanoflow-overlay.mjs',
  'scripts/codegraph-nanoflow-mcp-stdio.cjs',
  'dedup',
  'contract',
].join(' ');

module.exports = {
  CODEGRAPH_DEDUP_MAINTENANCE_FOCUSED_QUERY,
};
