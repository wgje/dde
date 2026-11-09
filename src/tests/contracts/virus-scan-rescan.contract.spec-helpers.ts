import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect } from 'vitest';

const virusScanFunctionPath = 'supabase/functions/virus-scan/index.ts';

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function extractFunctionSource(sourceText: string, functionName: string): string {
  const signature = `function ${functionName}(`;
  const start = sourceText.indexOf(signature);
  expect(start, `Function ${functionName} should exist`).toBeGreaterThanOrEqual(0);

  const bodyStart = sourceText.indexOf('{', start);
  expect(bodyStart, `Function ${functionName} should have a body`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const prefixStart = sourceText.lastIndexOf('async function', start) === start - 6
          ? start - 6
          : start;
        return sourceText.slice(prefixStart, index + 1);
      }
    }
  }

  throw new Error(`Failed to extract function ${functionName}`);
}

function extractConstSource(sourceText: string, constName: string): string {
  const marker = `const ${constName} =`;
  const start = sourceText.indexOf(marker);
  expect(start, `Constant ${constName} should exist`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = start; index < sourceText.length; index += 1) {
    const char = sourceText[index];
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (char === ';' && depth === 0) {
      return sourceText.slice(start, index + 1);
    }
  }

  throw new Error(`Failed to extract constant ${constName}`);
}

interface RescanTestState {
  client: unknown;
}

export interface RescanHelpers {
  handleRescan: (
    body: { action: string; fileId?: string },
    userId: string,
    corsHeaders: Record<string, string>,
  ) => Promise<Response>;
  handleHashVerification: (
    body: { action: string; fileId?: string; expectedHash?: string },
    userId: string,
    corsHeaders: Record<string, string>,
  ) => Promise<Response>;
  handleDueRescan: (
    body: { action: string; limit?: number },
    corsHeaders: Record<string, string>,
  ) => Promise<Response>;
  hasValidRescanCronSecret: (request: Request) => boolean;
  __rescanTestState: RescanTestState;
}

export function loadRescanHelpers(): RescanHelpers {
  const sourceText = readText(virusScanFunctionPath);
  const constNames = [
    'CLAMAV_API_URL',
    'VIRUS_RESCAN_CRON_SECRET',
    'ATTACHMENTS_BUCKET',
    'SCAN_STATUS',
    'MAX_FILE_BYTES',
    'RESCAN_TOTAL_TIMEOUT_MS',
    'RESCAN_MIN_INTERVAL_SECONDS',
    'RESCAN_STALE_AFTER_SECONDS',
    'RESCAN_SUCCESS_INTERVAL_MS',
    'RESCAN_FAILURE_RETRY_MS',
    'RESCAN_DUE_MAX_BATCH',
    'RESCAN_DUE_CONCURRENCY',
  ];
  const functionNames = [
    'nextRescanAtForStatus',
    'readObjectField',
    'readStringField',
    'readBooleanField',
    'sha256HexBytes',
    'jsonResponse',
    'withTimeout',
    'hasValidRescanCronSecret',
    'scanWithClamAv',
    'isUuidLike',
    'sanitizeStoragePathSegment',
    'findAttachmentByScanFileId',
    'locateRescanStorageTarget',
    'markRescanFailed',
    'readStorageObjectVersion',
    'readStorageObjectSize',
    'isSameStorageObjectVersion',
    'claimAttachmentScanRescan',
    'rescanClaimFailureResponse',
    'rescanStoredFile',
    'executeClaimedRescan',
    'handleDueRescan',
    'handleHashVerification',
    'handleRescan',
  ];

  const preamble = [
    "const Deno = { env: { get: (key: string): string | undefined => key === 'VIRUS_RESCAN_CRON_SECRET' ? 'cron-secret' : undefined } };",
    "class OperationTimeoutError extends Error { constructor(message: string) { super(message); this.name = 'OperationTimeoutError'; } }",
    'const __rescanTestState: { client: unknown } = { client: null };',
    'function createServiceRoleClient(signal?: AbortSignal): any { const client = __rescanTestState.client as { setGlobalFetch?: (fetcher: typeof fetch | undefined) => void } | null; client?.setGlobalFetch?.(signal ? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, signal })) : undefined); return client; }',
  ].join('\n');

  const snippet = [
    preamble,
    ...constNames.map(name => extractConstSource(sourceText, name)),
    ...functionNames.map(name => extractFunctionSource(sourceText, name)),
  ].join('\n\n');

  const transpiled = ts.transpileModule(
    `${snippet}\nmodule.exports = { handleDueRescan, handleHashVerification, handleRescan, hasValidRescanCronSecret, __rescanTestState };`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;

  const module = { exports: {} as Record<string, unknown> };
  const evaluator = new Function('module', 'exports', transpiled);
  evaluator(module, module.exports);

  return module.exports as unknown as RescanHelpers;
}

export interface RecordedUpdate {
  table: string;
  payload: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

export interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

export interface RecordedQuery {
  table: string;
  filters: Array<[string, unknown]>;
}

export interface RecordedStorageList {
  folder: string;
  options: { limit?: number; search?: string };
}

export interface MockClientOptions {
  scanRecord?: Record<string, unknown> | null;
  taskRow?: unknown;
  download?: { data: Blob | null; error: { message: string } | null };
  downloadViaScopedFetch?: boolean;
  claimResult?: Record<string, unknown>;
  dueClaimResults?: Array<Record<string, unknown>>;
  dueClaimPayload?: unknown;
  objectVersions?: Array<Record<string, unknown> | null>;
  casUpdateMatched?: boolean;
}

export function createMockRescanClient(options: MockClientOptions): {
  client: unknown;
  updates: RecordedUpdate[];
  downloads: string[];
  rpcCalls: RecordedRpc[];
  queries: RecordedQuery[];
  storageLists: RecordedStorageList[];
} {
  const updates: RecordedUpdate[] = [];
  const downloads: string[] = [];
  const rpcCalls: RecordedRpc[] = [];
  const queries: RecordedQuery[] = [];
  const storageLists: RecordedStorageList[] = [];
  const objectVersions = [...(options.objectVersions ?? [])];
  let scopedFetch: typeof fetch | undefined;
  const defaultObjectVersion = {
    id: 'storage-object-version-1',
    updated_at: '2026-07-14T00:00:00.000Z',
    metadata: { size: options.download?.data?.size ?? 5, eTag: 'etag-1' },
  };

  const recordUpdate = (
    table: string,
    payload: Record<string, unknown>,
    filters: Array<[string, unknown]>,
  ): void => {
    if (!updates.some(update => update.table === table && update.payload === payload)) {
      updates.push({ table, payload, filters: [...filters] });
    }
  };

  const client = {
    auth: {},
    setGlobalFetch(fetcher: typeof fetch | undefined) {
      scopedFetch = fetcher;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (name === 'claim_due_attachment_scan_rescans') {
        return Promise.resolve({
          data: options.dueClaimPayload !== undefined
            ? options.dueClaimPayload
            : options.dueClaimResults ?? [],
          error: null,
        });
      }
      const defaultClaim = options.scanRecord === null
        ? { claimed: false, token: null, reason: 'not_found', current_status: null, retry_after_seconds: 0 }
        : { claimed: true, token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: 'claimed', current_status: 'scanning', retry_after_seconds: 0 };
      return Promise.resolve({ data: [options.claimResult ?? defaultClaim], error: null });
    },
    from(table: string) {
      let op: 'select' | 'update' = 'select';
      let payload: Record<string, unknown> = {};
      const filters: Array<[string, unknown]> = [];
      const builder: Record<string, unknown> = {};
      Object.assign(builder, {
        select: () => builder,
        contains: () => builder,
        limit: () => builder,
        in: () => builder,
        lte: () => builder,
        order: () => builder,
        abortSignal: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        update: (values: Record<string, unknown>) => {
          op = 'update';
          payload = values;
          return builder;
        },
        maybeSingle: () => {
          queries.push({ table, filters: [...filters] });
          if (op === 'update') {
            recordUpdate(table, payload, filters);
            return Promise.resolve({
              data: options.casUpdateMatched === false
                ? null
                : { file_id: String(options.scanRecord?.['file_id'] ?? 'updated-file') },
              error: null,
            });
          }
          if (table === 'attachment_scans') {
            return Promise.resolve({ data: options.scanRecord ?? null, error: null });
          }
          return Promise.resolve({ data: options.taskRow ?? null, error: null });
        },
        single: () => Promise.resolve({
          data: table === 'attachment_scans' ? options.scanRecord ?? null : options.taskRow ?? null,
          error: null,
        }),
        then: (
          resolve: (value: { data: unknown[] | null; error: { message: string } | null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          if (op === 'update') {
            recordUpdate(table, payload, filters);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          queries.push({ table, filters: [...filters] });
          const data = table === 'tasks'
            ? (options.taskRow ? [options.taskRow] : [])
            : null;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return builder;
    },
    storage: {
      from: (_bucket: string) => ({
        list: (folder = '', listOptions: { limit?: number; search?: string } = {}) => {
          storageLists.push({ folder, options: listOptions });
          const version = objectVersions.length > 0 ? objectVersions.shift() ?? null : defaultObjectVersion;
          return Promise.resolve({
            data: version
              ? [{ name: listOptions.search ?? '', ...version }]
              : [],
            error: null,
          });
        },
        download: async (storagePath: string) => {
          downloads.push(storagePath);
          if (options.downloadViaScopedFetch) {
            if (!scopedFetch) {
              throw new Error('Storage download did not receive the deadline-scoped fetch');
            }
            const response = await scopedFetch(`https://storage.test/object/${storagePath}`);
            return { data: await response.blob(), error: null };
          }
          return options.download ?? { data: null, error: { message: 'Object not found' } };
        },
      }),
    },
  };

  return { client, updates, downloads, rpcCalls, queries, storageLists };
}

export function clamAvResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}
