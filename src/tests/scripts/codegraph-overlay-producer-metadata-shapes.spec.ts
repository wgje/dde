import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../../..');
const graphSchema = require('../../../scripts/lib/codegraph-nanoflow-overlay-v1-schema-graph.cjs');
const source = fs.readFileSync(path.join(root, 'scripts/generate-codegraph-nanoflow-overlay.mjs'), 'utf8');
const start = source.indexOf('const NODE_METADATA_ORDERS_BY_RELATION_AND_SHAPE =');
const end = source.indexOf('const CALL_RECEIVER_SKIP_NAMES =', start);
const canonical = vm.runInNewContext(source.slice(start, end) + '; canonicalNodeMetadata', { graphSchema, currentSchema: require('../../../scripts/lib/codegraph-overlay-current-schema.cjs') }) as
  (metadata: Record<string, unknown>, kind: string) => Record<string, unknown>;

describe('exact producer metadata shapes beyond the frozen predecessor', () => {
  it('keeps the emitted index method plus predicate in producer insertion order', () => {
    const value = canonical({ predicate: 'deleted_at is null', concurrently: true, unique: true,
      method: 'btree', columns: ['id'], table: 'public.tasks', relation: 'migration-index' }, 'references');
    expect(Object.keys(value)).toEqual(['relation', 'table', 'columns', 'method', 'unique', 'concurrently', 'predicate']);
  });
  it('keeps fallback validation references without inventing a constraint name', () => {
    const value = canonical({ table: 'public.tasks', relation: 'migration-constraint-validation' }, 'references');
    expect(Object.keys(value)).toEqual(['relation', 'table']);
  });
  it('does not accept arbitrary keys on the audited relations', () => {
    expect(() => canonical({ relation: 'migration-constraint-validation', table: 'public.tasks', canary: true }, 'references'))
      .toThrow('codegraph-overlay-node-metadata-order-ambiguous');
    expect(() => canonical({ relation: 'migration-index', table: 'public.tasks', columns: [],
      method: 'btree', unique: false, concurrently: false, predicate: null, unexpected: true }, 'references'))
      .toThrow('codegraph-overlay-node-metadata-order-ambiguous');
  });
  it('does not grant new shapes to unrelated relation names through shape fallback', () => {
    expect(() => canonical({ relation: 'unreviewed-relation', table: 'public.tasks', columns: [],
      method: 'btree', unique: false, concurrently: false, predicate: null }, 'references'))
      .toThrow('codegraph-overlay-node-metadata-order-ambiguous');
  });
  it('preserves every frozen predecessor ordering exactly', () => {
    const seen = new Set<string>();
    for (const [relation, orders] of graphSchema.nodeMetadataOrders as Array<[string, string[][]]>) {
      for (const order of orders) {
        const key = relation + JSON.stringify([...order].sort());
        if (seen.has(key)) continue;
        seen.add(key);
        const value = Object.fromEntries(order.map(key => [key, key === 'relation' ? relation : key]));
        expect(Object.keys(canonical(value, relation.startsWith('@none:') ? relation.slice(6) : 'references')))
          .toEqual(order);
      }
    }
  });
});
