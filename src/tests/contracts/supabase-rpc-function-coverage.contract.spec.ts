import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

type RpcReferenceKind = 'direct-rpc' | 'sync-rpc-transport';
interface RpcReference {
  column: number;
  kind: RpcReferenceKind;
  line: number;
  name: string;
  path: string;
}
interface StaticRpcReferenceReport {
  references: RpcReference[];
  unresolvedDynamicSites: Array<{
    column: number;
    line: number;
    path: string;
    reason: string;
  }>;
}
interface FreshInitRpcDeclarationReport {
  indeterminate: string[];
  missing: string[];
  present: string[];
}
interface RepositoryRpcFunctionCoverageReport {
  freshInitRpcDeclarations: FreshInitRpcDeclarationReport;
  generatedPublicFunctions: string[];
  missingFromFreshInit: string[];
  missingFromGeneratedTypes: string[];
  references: RpcReference[];
  rpcNames: string[];
  sqlClaimScope: {
    deployedStateEvaluated: false;
    kind: 'FRESH_INIT_ONLY';
    migrationReplayEvaluated: false;
    sourcePath: 'scripts/init-supabase.sql';
  };
  unresolvedDynamicSites: StaticRpcReferenceReport['unresolvedDynamicSites'];
}
interface RpcCoverageContractError extends Error {
  position: Pick<RpcReference, 'column' | 'line' | 'path'>;
  reasonCode: string;
}
interface RpcFunctionCoverageModule {
  analyzeFreshInitRpcDeclarationCoverage(
    source: string,
    requiredNames: readonly string[],
    filePath?: string,
  ): FreshInitRpcDeclarationReport;
  analyzeRepositoryRpcFunctionCoverage(root: string): RepositoryRpcFunctionCoverageReport;
  extractGeneratedPublicFunctionNames(source: string, filePath?: string): string[];
  extractStaticRpcFunctionReferences(source: string, filePath: string): StaticRpcReferenceReport;
  isRpcCoverageRuntimeFile(filePath: string): boolean;
}
const projectRoot = process.cwd();
const modulePath = path.join(projectRoot, 'scripts', 'lib', 'supabase-rpc-function-coverage.cjs');
const require = createRequire(import.meta.url);
const generatedTypeGaps = [
  'claim_attachment_cleanup_jobs', 'claim_attachment_scan_rescan',
  'claim_due_attachment_scan_rescans', 'claim_task_attachment_cleanup',
  'complete_attachment_cleanup_job', 'consume_transcription_quota',
  'fail_attachment_cleanup_job', 'list_project_heads_page',
  'list_widget_notify_devices', 'release_transcription_quota',
];
const syncTransportNames = [
  'sync_delete_project', 'sync_delete_tasks',
  'sync_increment_routine_completion', 'sync_upsert_blackbox_entry',
  'sync_upsert_connection', 'sync_upsert_focus_session',
  'sync_upsert_project', 'sync_upsert_routine_task',
  'sync_upsert_task', 'sync_upsert_user_preferences',
];
const directFixturePath = 'supabase/functions/cleanup-attachments/cleanup-outbox.ts';
function authorizedDirectSource(body: string): string {
  return `
    interface AttachmentCleanupOutboxClient { rpc(name: string, args?: unknown): unknown }
    function claimTaskAttachmentCleanup(client: AttachmentCleanupOutboxClient) { ${body} }
  `;
}
const repositoryRpcIdentityRows = [
  'direct-rpc|supabase/functions/widget-black-box-action/index.ts|apply_widget_black_box_action',
  'direct-rpc|src/app/core/services/sync/tombstone.service.ts|batch_get_tombstones',
  'direct-rpc|supabase/functions/cleanup-attachments/cleanup-outbox.ts|claim_attachment_cleanup_jobs',
  'direct-rpc|supabase/functions/virus-scan/index.ts|claim_attachment_scan_rescan',
  'direct-rpc|supabase/functions/virus-scan/index.ts|claim_due_attachment_scan_rescans',
  'direct-rpc|supabase/functions/cleanup-attachments/cleanup-outbox.ts|claim_task_attachment_cleanup',
  'direct-rpc|supabase/functions/cleanup-attachments/cleanup-outbox.ts|complete_attachment_cleanup_job',
  'direct-rpc|supabase/functions/transcribe/index.ts|consume_transcription_quota',
  'direct-rpc|supabase/functions/_shared/widget-common.ts|consume_widget_rate_limit',
  'direct-rpc|supabase/functions/cleanup-attachments/cleanup-outbox.ts|fail_attachment_cleanup_job',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|get_accessible_project_probe',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|get_black_box_sync_watermark',
  'direct-rpc|src/services/black-box-sync-pull.helpers.ts|get_black_box_sync_watermark',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|get_project_sync_watermark',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|get_resume_recovery_probe',
  'direct-rpc|src/services/clock-sync.service.ts|get_server_time',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|get_user_projects_watermark',
  'direct-rpc|src/app/core/services/sync/project-sync-probe.service.ts|list_project_heads_page',
  'direct-rpc|supabase/functions/widget-notify/index.ts|list_widget_notify_devices',
  'direct-rpc|supabase/functions/transcribe/index.ts|release_transcription_quota',
  'direct-rpc|src/services/sync-rpc-client.service.ts|sync_check_protocol',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_delete_project',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_delete_tasks',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_increment_routine_completion',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_blackbox_entry',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_connection',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_focus_session',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_project',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_routine_task',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_task',
  'sync-rpc-transport|src/services/sync-rpc-client.service.ts|sync_upsert_user_preferences',
  'direct-rpc|supabase/functions/widget-summary/index.ts|widget_summary_wave1',
];
function loadCoverage(): RpcFunctionCoverageModule {
  expect(existsSync(modulePath), `${modulePath} must exist`).toBe(true);
  return require(modulePath) as RpcFunctionCoverageModule;
}
const coverage = loadCoverage();
function captureContractError(action: () => unknown): RpcCoverageContractError {
  try {
    action();
  } catch (error) {
    return error as RpcCoverageContractError;
  }
  throw new Error('expected RPC coverage contract failure');
}
function positionOf(source: string, needle: string, filePath: string): RpcCoverageContractError['position'] {
  const offset = source.indexOf(needle);
  const prefix = source.slice(0, offset);
  const lines = prefix.split('\n');
  return { column: lines.at(-1)!.length + 1, line: lines.length, path: filePath };
}
function expectIndeterminate(sql: string, names: string[]): void {
  expect(coverage.analyzeFreshInitRpcDeclarationCoverage(sql, names)).toEqual({
    indeterminate: [...names].sort(), missing: [], present: [],
  });
}
describe('Supabase RPC function coverage', () => {
  it('includes production helpers and context files while excluding explicit test forms', () => {
    for (const included of [
      'src/services/black-box-sync-pull.helpers.ts',
      'src/services/sync-coordinator-persist-auth-context.helpers.ts',
      'src/app/core/services/sync/project-push-retry-context.ts',
      'supabase/functions/widget-summary/index.ts',
    ]) {
      expect(coverage.isRpcCoverageRuntimeFile(included), included).toBe(true);
    }

    for (const excluded of [
      'src/tests/contracts/example.ts',
      'src/services/example.spec.ts',
      'src/services/example.test.ts',
      'src/services/example.spec-context.ts',
      'src/services/example.test-context.ts',
      'src/services/example.spec-helpers.ts',
      'src/test-setup.mocks.ts',
      'src/services/fixtures/example.ts',
      'src/services/harnesses/example.ts',
      'src/services/example.d.ts',
      'supabase/functions/node_modules/.deno/pkg/node_modules/example/client.js',
      'supabase/functions/node_modules/.deno/@grpc+grpc-js@1.14.4/node_modules/@grpc/grpc-js/build/src/client.js',
      'supabase/functions/node_modules/dependency/index.ts',
    ]) {
      expect(coverage.isRpcCoverageRuntimeFile(excluded), excluded).toBe(false);
    }
  });
  it('unwraps supported TypeScript expressions and reports unresolved generic dispatch', () => {
    const report = coverage.extractStaticRpcFunctionReferences(authorizedDirectSource(`
      const dynamicName = chooseRpc();
      (client.rpc)((('alpha' as const)!));
      client.rpc((\`beta\`) satisfies string);
      client.rpc(<const>'gamma');
      client.rpc(\`delta\`);
      client.rpc(dynamicName);
    `), directFixturePath);

    expect(report.references.map(reference => reference.name)).toEqual([
      'alpha',
      'beta',
      'delta',
      'gamma',
    ]);
    expect(report.references.every(reference => reference.kind === 'direct-rpc')).toBe(true);
    expect(report.unresolvedDynamicSites).toHaveLength(1);
    expect(report.unresolvedDynamicSites[0]?.reason).toBe('dynamic-rpc-name');
  });
  it('admits only anchored domain rpc data and authentic injected wrapper imports', () => {
    const projection = coverage.extractStaticRpcFunctionReferences(`
      export interface DataSafetyReplayEntry { queue: unknown; rpc: unknown; lww: unknown; lastSyncTime: unknown }
      function toAuditReplayPlanStep(entry: DataSafetyReplayEntry): DataSafetyReplayPlanStep {
        return { rpc: entry.rpc } as DataSafetyReplayPlanStep;
      }
    `, 'src/services/data-safety-package.ts');
    const wrapper = coverage.extractStaticRpcFunctionReferences(`
      import { inject as ngInject } from '@angular/core';
      import { SyncRpcClientService as RpcService } from './sync-rpc-client.service';
      class ProjectConflictDirectSyncService { private readonly rpc = ngInject(RpcService); async run() { return this.rpc.upsertProject(payload); } }
    `, 'src/services/project-conflict-direct-sync.service.ts');
    expect(projection.references).toEqual([]);
    expect(wrapper.references).toEqual([]);
    expect(() => coverage.extractStaticRpcFunctionReferences(
      'interface DataSafetyReplayEntry { rpc: unknown } function toAuditReplayPlanStep(entry: DataSafetyReplayEntry) { return { rpc: entry.rpc }; }',
      'src/services/data-safety-package.ts',
    )).toThrow(/rpc.*(?:alias|provenance)/i);
  });
  it.each([
    ['rpc alias', "const callRpc = client.rpc; callRpc('alpha');"],
    ['conditional computed rogue dispatch', "rogue[enabled ? 'rpc' : 'from']('alpha');"],
    ['partial declared key union', "type Level = 'debug' | string; function log(rogue: any, key: Level) { rogue[key]('alpha'); }"],
    ['named dynamic unauthorized receiver', 'rogue.rpc(chooseRpcName());'],
    ['arbitrary receiver alias', "const sb = client; const callRpc = sb.rpc; callRpc('alpha');"],
    ['workspace anchor inactive callback decoy', "import type { WorkspaceShellLazyLifecycleGroupControllerLike } from './workspace-shell-lazy-lifecycle-group.factory'; class WorkspaceShellLazyLifecycleGroupLazyDelegateController { run(method: keyof WorkspaceShellLazyLifecycleGroupControllerLike) { const invoke = (controller: any) => controller[method](); invoke(rogue); } }", 'src/app/core/shell/workspace-shell-lazy-lifecycle-group-lazy-delegate.controller.ts'],
    ['workspace anchor reassigned host', "import type { WorkspaceShellLazyLifecycleGroupControllerLike } from './workspace-shell-lazy-lifecycle-group.factory'; import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller'; class WorkspaceShellLazyLifecycleGroupLazyDelegateController { private readonly host: WorkspaceShellLazyDelegateCallHostController<WorkspaceShellLazyLifecycleGroupControllerLike>; constructor() { this.host = new WorkspaceShellLazyDelegateCallHostController({} as any); this.host = rogueHost as any; } run(method: keyof WorkspaceShellLazyLifecycleGroupControllerLike) { this.host.run(controller => controller[method](), 'failure'); } }", 'src/app/core/shell/workspace-shell-lazy-lifecycle-group-lazy-delegate.controller.ts'],
    ['renamed rpc projection alias', "const holder = { callRpc: entry.rpc }; holder.callRpc('alpha');"],
    ['black-box anchor constructor receiver override', "import { BlackBoxSyncQueueRealtimeLayer } from './black-box-sync-queue-realtime.service'; import type { BlackBoxLocalHydrationLogEvent } from './black-box-sync-local-hydration.helpers'; abstract class BlackBoxSyncLocalLayer extends BlackBoxSyncQueueRealtimeLayer { constructor(override readonly logger: any) { super(); } private logLocalHydrationEvents(events: BlackBoxLocalHydrationLogEvent[]) { for (const event of events) this.logger[event.level](event.message); } }", 'src/services/black-box-sync-local.service.ts'],
    ['black-box anchor receiver write', "import { BlackBoxSyncQueueRealtimeLayer } from './black-box-sync-queue-realtime.service'; import type { BlackBoxLocalHydrationLogEvent } from './black-box-sync-local-hydration.helpers'; abstract class BlackBoxSyncLocalLayer extends BlackBoxSyncQueueRealtimeLayer { private redirect(source: any) { ({ logger: this.logger } = source); } private logLocalHydrationEvents(events: BlackBoxLocalHydrationLogEvent[]) { for (const event of events) this.logger[event.level](event.message); } }", 'src/services/black-box-sync-local.service.ts'],
    ['black-box anchor alternate key', "import { BlackBoxSyncQueueRealtimeLayer } from './black-box-sync-queue-realtime.service'; import type { BlackBoxLocalHydrationLogEvent } from './black-box-sync-local-hydration.helpers'; abstract class BlackBoxSyncLocalLayer extends BlackBoxSyncQueueRealtimeLayer { private logLocalHydrationEvents(events: BlackBoxLocalHydrationLogEvent[]) { for (const event of events) this.logger[event.rpcName](event.message); } }", 'src/services/black-box-sync-local.service.ts'],
    ['implicit return rpc alias', "const sb = client; const callRpc = () => sb.rpc;"],
    ['rpc callable chain', "client.rpc.valueOf().call(client, 'hidden');"],
    ['this rpc callable chain', "class Example { private readonly rpc = inject(SyncRpcClientService); run() { this.rpc.valueOf().call(this, 'hidden'); } }"],
    ['awaited this rpc callable chain', "class Example { private readonly rpc = inject(SyncRpcClientService); async run() { (await this.rpc.valueOf()).call(this, 'hidden'); } }"],
    ['foreign rpc in injected class', "class Example { private readonly rpc = inject(SyncRpcClientService); run(client: any) { client.rpc.call(client, 'hidden'); } }"],
    ['shadowed rpc injection', "function inject(){} class SyncRpcClientService {} class Example { private rpc = inject(SyncRpcClientService); async run() { const call = await this.rpc.valueOf(); } }"],
    ['nested imported injection shadow', "import { inject } from '@angular/core'; import { SyncRpcClientService } from './sync-rpc-client.service'; function outer(inject: any, SyncRpcClientService: any) { class Example { private rpc = inject(SyncRpcClientService); async run() { const call = await this.rpc.valueOf(); } } }"],
    ['awaited rpc result callable', "import { inject } from '@angular/core'; import { SyncRpcClientService } from './sync-rpc-client.service'; class Example { private rpc = inject(SyncRpcClientService); async run() { const call = await this.rpc.valueOf(); call('hidden'); } }"],
    ['rpc bracket access', "client['rpc']('alpha');"],
    ['computed rpc bracket access', "client['r' + 'pc']('hidden');"],
    ['template rpc bracket access', "client[`r${''}pc`]('hidden');"],
    ['constant-bound rpc bracket access', "const key = 'rpc'; client[key]('hidden');"],
    ['temporal rpc key access', "client[key]('hidden'); const key = 'rpc';"],
    ['mutated rpc key access', "let key = 'rpc'; key = choose(); client[key]('hidden');"],
    ['cyclic rpc key access', "const first = second; const second = first; client[first]('hidden');"],
    ['mutated array rpc key access', "const keys = ['other']; keys[0] = 'rpc'; client[keys[0]]('hidden');"],
    ['conditional rpc key access', "const key = flag ? 'rpc' : 'other'; client[key]('hidden');"],
    ['dead AND rpc branch', "false && client.rpc('hidden');"],
    ['dead OR rpc branch', "true || client.rpc('hidden');"],
    ['loop-scoped rpc key access', "for (const key of ['rpc']) { client[key]('hidden'); }"],
    ['catch-scoped rpc callable', "try { work(); } catch (rpc) { rpc('hidden'); }"],
    ['rpc destructuring alias', "const { rpc } = client; rpc('alpha');"],
    ['dynamic computed rogue dispatch', "rogue[chooseMember()]('alpha');"],
    ['rpc parameter destructuring', "const call = ({ rpc }: any) => rpc('alpha');"],
    ['computed rpc destructuring', "const call = ({ ['rpc']: invoke }: any) => invoke('alpha');"],
    ['dynamic computed rogue destructuring', "const key = chooseMember(); const { [key]: invoke } = rogue; invoke('alpha');"],
    ['rpc assignment destructuring', "let rpc; ({ rpc } = client); rpc('alpha');"],
    ['nested rpc assignment destructuring', "let invoke; ({ holder: { rpc: invoke } } = client); invoke('alpha');"],
    ['array rpc assignment destructuring', "let invoke; ([{ rpc: invoke }] = clients); invoke('alpha');"],
    ['for-of rpc destructuring', "for ({ rpc: invoke } of clients) { invoke('alpha'); }"],
    ['array rpc binding', "const [rpc] = clients; rpc('alpha');"],
    ['partially unknown computed rogue dispatch', "rogue[enabled ? 'info' : chooseMember()]('alpha');"],
    ['partially unknown computed rogue destructuring', "const key = enabled ? 'info' : chooseMember(); const { [key]: invoke } = rogue; invoke('alpha');"],
    ['rpc spread arguments', "client.rpc('alpha', ...dynamicArgs);"],
    ['rpc arity', "client.rpc('alpha', {}, {}, {});"],
    ['anchored wrapper decoy receiver', "import { inject } from '@angular/core'; import { SyncRpcClientService } from './sync-rpc-client.service'; class ProjectConflictDirectSyncService { private rpc = inject(SyncRpcClientService); run(other: any) { return other.rpc.upsertProject(payload); } }", 'src/services/project-conflict-direct-sync.service.ts'],
    ['type-only wrapper imports', "import type { inject } from '@angular/core'; import type { SyncRpcClientService } from './sync-rpc-client.service'; class ProjectConflictDirectSyncService { private rpc = inject(SyncRpcClientService); run() { return this.rpc.upsertProject(payload); } }", 'src/services/project-conflict-direct-sync.service.ts'],
  ])('fails closed for ambiguous direct dispatch: %s', (_label, source, filePath?: string) => {
    expect(() => coverage.extractStaticRpcFunctionReferences(
      filePath ? source : authorizedDirectSource(source),
      filePath ?? directFixturePath,
    )).toThrow(/rpc.*(?:alias|arity|authority|dispatch)/i);
  });
  it('closes the exact SyncRpcClientService invokeRpc transport to literal callers', () => {
    const report = coverage.extractStaticRpcFunctionReferences(`
      class SyncRpcClientService {
        upsertTask(payload: object) {
          return (this).invokeRpc('sync_upsert_task', payload);
        }
        deleteTasks(payload: object, signal: AbortSignal) {
          return this.invokeRpc((\`sync_delete_tasks\` as const), payload, signal);
        }
        private async invokeRpc(name: string, payload: object, signal?: AbortSignal, current?: () => boolean) {
          const client = await this.supabase.clientAsync();
          const rpcBuilder = client.rpc(name as never, { payload } as never);
          const [pending] = [rpcBuilder];
          const send = async () => { return pending; };
          return await send();
        }
      }
    `, 'src/services/sync-rpc-client.service.ts');

    expect(report.references.map(reference => [reference.name, reference.kind])).toEqual([
      ['sync_delete_tasks', 'sync-rpc-transport'],
      ['sync_upsert_task', 'sync-rpc-transport'],
    ]);
    expect(report.unresolvedDynamicSites).toEqual([]);
  });
  const validCaller = "return this.invokeRpc('sync_upsert_task', payload);";
  const validSink = 'const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never);';
  it.each([
    ['dynamic caller', 'return this.invokeRpc(name, payload);', validSink],
    ['caller arity', "return this.invokeRpc('sync_upsert_task');", validSink],
    ['transport sink alias', validCaller, 'return client.rpc(otherName as never, { payload } as never);'],
    ['transport payload alias', validCaller, 'return client.rpc(name as never, { payload: differentValue } as never);'],
    ['transport payload spread override', validCaller, 'return client.rpc(name as never, { payload, ...replacement } as never);'],
    ['transport name reassignment', validCaller, "name = 'other_rpc'; return client.rpc(name as never, { payload } as never);"],
    ['transport name update', validCaller, 'name++; return client.rpc(name as never, { payload } as never);'],
    ['transport parameter for-of assignment', validCaller, 'for ([name, payload] of values) {} return client.rpc(name as never, { payload } as never);'],
    ['transport payload reassignment', validCaller, 'payload = replacement; return client.rpc(name as never, { payload } as never);'],
    ['transport name shadowing', validCaller, "{ const name = 'other_rpc'; return client.rpc(name as never, { payload } as never); }"],
    ['transport payload shadowing', validCaller,
      'function send(payload: object) { return client.rpc(name as never, { payload } as never); } return send(replacement);'],
    ['transport bracket access', "return this['invoke' + 'Rpc']('sync_upsert_task', payload);", validSink],
    ['transport caller spread', "return this.invokeRpc('sync_upsert_task', ...args);", validSink],
    ['transport destructuring alias', "const { invokeRpc } = this; return invokeRpc('sync_upsert_task', payload);", validSink],
    ['transport wrapped destructuring alias', "const { invokeRpc } = (this); return invokeRpc('sync_upsert_task', payload);", validSink],
    ['transport assignment destructuring alias', "let call; ({ invokeRpc: call } = this); return call('sync_upsert_task', payload);", validSink],
    ['transport receiver alias', "const self = this; return self.invokeRpc('sync_upsert_task', payload);", validSink],
    ['transport aliased-source destructuring', "const self = this; const { invokeRpc } = self; return invokeRpc('sync_upsert_task', payload);", validSink],
    ['transport parameter destructuring', "function send({ invokeRpc }: any) { return invokeRpc('sync_upsert_task', payload); } return send(this);", validSink],
    ['transport for-of destructuring', "for ({ invokeRpc: call } of sources) { return call('sync_upsert_task', payload); }", validSink],
    ['transport computed destructuring', "const key = 'invokeRpc'; const { [key]: call } = this; return call('sync_upsert_task', payload);", validSink],
    ['transport computed caller', "const key = 'invokeRpc'; return this[key]('sync_upsert_task', payload);", validSink],
    ['transport foreign sink', validCaller, 'return foreign.rpc(name as never, { payload } as never);'],
    ['transport dead sink', validCaller, 'const client = await this.supabase.clientAsync(); client.rpc(name as never, { payload } as never); return other;'],
    ['transport shadowed observation', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); { const rpcBuilder = other; await rpcBuilder; } return other;'],
    ['transport uncalled nested sink', validCaller, 'const send = async () => { const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never); }; return other;'],
    ['transport mutated builder array', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); const builders = [rpcBuilder]; builders[0] = other; const [pending] = builders; return await pending;'],
    ['transport reassigned nested sink', validCaller, 'let send = async () => { const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never); }; send = async () => other; return send();'],
    ['transport temporal nested sink', validCaller, 'return send(); const send = async () => { const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never); };'],
    ['transport builder method mutation', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); const builders = [rpcBuilder]; builders.reverse(); const [pending] = builders; return await pending;'],
    ['transport compound builder write', validCaller, 'const client = await this.supabase.clientAsync(); let rpcBuilder = client.rpc(name as never, { payload } as never); rpcBuilder &&= rogue; return await rpcBuilder;'],
    ['transport builder escape', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); const builders = [rpcBuilder]; mutate(builders); const [pending] = builders; return await pending;'],
    ['transport discarded nested result', validCaller, 'const send = async () => { const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never); }; await send(); return other;'],
    ['transport try-only reaching definition', validCaller, 'let client = rogue; try { client = await this.supabase.clientAsync(); } catch {} return client.rpc(name as never, { payload } as never);'],
    ['transport cross-case reaching definition', validCaller, 'let client = rogue; switch (mode) { case 1: client = await this.supabase.clientAsync(); break; case 2: return client.rpc(name as never, { payload } as never); }'],
    ['transport sink after return', validCaller, 'return other; const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never);'],
    ['transport sink after throw', validCaller, 'throw failure; const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never);'],
    ['transport sink in dead branch', validCaller, 'if (false) { const client = await this.supabase.clientAsync(); return client.rpc(name as never, { payload } as never); } return other;'],
    ['transport helper fallthrough', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); function send() { if (enabled) return rpcBuilder; } return send();'],
    ['transport nested array escape', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); const builders = [rpcBuilder]; const alias = builders; mutate({ holder: [alias] }); const [pending] = builders; return await pending;'],
    ['transport assigned callback escape', validCaller, 'const client = await this.supabase.clientAsync(); const rpcBuilder = client.rpc(name as never, { payload } as never); const send = async () => { return rpcBuilder; }; register({ send }); return send();'],
    ['transport unknown callback activation', "return withRetry(() => this.invokeRpc('sync_upsert_task', payload));", validSink],
  ])('fails closed for ambiguous known transport: %s', (_label, caller, sink) => {
    const source = `
      class SyncRpcClientService {
        call(name: string, payload: object) { ${caller} }
        private async invokeRpc(name: string, payload: object, signal?: AbortSignal, current?: () => boolean) {
          ${sink}
        }
      }
    `;

    expect(() => coverage.extractStaticRpcFunctionReferences(
      source,
      'src/services/sync-rpc-client.service.ts',
    )).toThrow(/invokeRpc transport/i);
  });
  it('classifies unauthorized receivers before dynamic rpc names', () => {
    const source = "function run() { if (false) rogue[chooseRpcName()]('hidden'); } run();";
    const error = captureContractError(() => coverage.extractStaticRpcFunctionReferences(
      source, 'src/services/example.ts',
    ));
    expect(error.reasonCode).toBe('RPC_RECEIVER_UNAUTHORIZED');
    expect(error.position).toEqual(positionOf(source, 'rogue[chooseRpcName()]', 'src/services/example.ts'));
    expect(error.message).not.toContain('chooseRpcName');
    expect(coverage.extractStaticRpcFunctionReferences(
      "type Level = 'debug' | 'warn'; function log(logger: any, level: Level) { logger[level]('message'); }",
      'src/services/example.ts',
    )).toEqual({ references: [], unresolvedDynamicSites: [] });
  });
  it.each([
    ['authoritative single assignment', 'quotaReleaseClient = admin;', 'if (!quotaReleaseClient) return;', true],
    ['conflicting write', 'quotaReleaseClient = admin; quotaReleaseClient = replacement;', 'if (!quotaReleaseClient) return;', false],
    ['branch-only write', 'if (enabled) quotaReleaseClient = admin;', 'if (!quotaReleaseClient) return;', false],
    ['escaped closure write', 'register(() => { quotaReleaseClient = admin; });', 'if (!quotaReleaseClient) return;', false],
    ['conditional null guard', 'quotaReleaseClient = admin;', 'if (!quotaReleaseClient) { if (enabled) return; }', false],
    ['safe OR null guard', 'quotaReleaseClient = admin;', 'if (!quotaReleaseClient || disabled) return;', true],
    ['unsafe AND null guard', 'quotaReleaseClient = admin;', 'if (!quotaReleaseClient && enabled) return;', false],
    ['double-negated null guard', 'quotaReleaseClient = admin;', 'if (!!quotaReleaseClient) return;', false],
    ['short-circuit write', 'enabled && (quotaReleaseClient = admin);', 'if (!quotaReleaseClient) return;', false],
    ['logical OR compound write', 'quotaReleaseClient = admin; quotaReleaseClient ||= replacement;', 'if (!quotaReleaseClient) return;', false],
    ['logical AND compound write', 'quotaReleaseClient = admin; quotaReleaseClient &&= replacement;', 'if (!quotaReleaseClient) return;', false],
    ['nullish compound write', 'quotaReleaseClient = admin; quotaReleaseClient ??= replacement;', 'if (!quotaReleaseClient) return;', false],
    ['arithmetic compound write', 'quotaReleaseClient = admin; quotaReleaseClient += replacement;', 'if (!quotaReleaseClient) return;', false],
    ['bitwise compound write', 'quotaReleaseClient = admin; quotaReleaseClient |= replacement;', 'if (!quotaReleaseClient) return;', false],
    ['write after return', 'return; quotaReleaseClient = admin;', 'if (!quotaReleaseClient) return;', false],
    ['write after throw', 'throw failure; quotaReleaseClient = admin;', 'if (!quotaReleaseClient) return;', false],
  ])('checks transcribe quota receiver authority with %s', (_label, assignment, guard, accepted) => {
    const source = `
      import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.93.2';
      interface QuotaReleaseClient { rpc(name: string): unknown }
      Deno.serve(async () => { let quotaReleaseClient: QuotaReleaseClient | null = null;
       async function releaseQuotaReservation() {
         ${guard}
        return quotaReleaseClient.rpc('release_transcription_quota');
      }
      const admin = createClient(url, key);
      ${assignment}
      await releaseQuotaReservation(); });
    `;
    const action = () => coverage.extractStaticRpcFunctionReferences(
      source,
      'supabase/functions/transcribe/index.ts',
    );
    if (accepted) expect(action).not.toThrow();
    else expect(action).toThrow(/rpc receiver authority/i);
  });
  it.each([
    ['mutable provider', 'dependencies.getClient = replacement;', "return await dependencies.withAuthRetry('probe', async () => client.rpc('get_project_sync_watermark'));"],
    ['reassigned provider result', 'client = replacement;', "return await dependencies.withAuthRetry('probe', async () => client.rpc('get_project_sync_watermark'));"],
    ['wrong callback arity', '', "return await dependencies.withAuthRetry('probe', async () => client.rpc('get_project_sync_watermark'), extra);"],
    ['discarded callback', '', "dependencies.withAuthRetry('probe', async () => client.rpc('get_project_sync_watermark')); return null;"],
  ])('rejects ProjectSync authority for %s', (_label, mutation, execution) => {
    const source = `
      interface ProjectSyncProbeDependencies { getClient(): Promise<SupabaseClient | null>; withAuthRetry<T>(name: string, fn: () => Promise<T>): Promise<T> }
      class ProjectSyncProbeService {
        async getProjectSyncWatermark(dependencies: ProjectSyncProbeDependencies) {
          const client = await dependencies.getClient();
          if (!client) return null;
          ${mutation}
          ${execution}
        }
      }
    `;
    expect(() => coverage.extractStaticRpcFunctionReferences(
      source,
      'src/app/core/services/sync/project-sync-probe.service.ts',
    )).toThrow(/rpc receiver authority/i);
  });
  const projectDataPath = 'src/app/core/services/sync/project-data.service.ts';
  const projectDataProviderSource = `import { inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { ProjectSyncProbeService } from './project-sync-probe.service';
class ProjectDataService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly syncProbes = inject(ProjectSyncProbeService);
  private async getSupabaseClient() { return await this.supabase.clientAsync(); }
  private async withAuthRetry<T>(_name: string, fn: () => Promise<T>) { return await fn(); }
  private syncProbeDependencies() { return { getClient: () => this.getSupabaseClient(), withAuthRetry: <T>(name: string, fn: () => Promise<T>) => this.withAuthRetry(name, fn) }; }
  getProjectSyncWatermark(id: string) { return this.syncProbes.getProjectSyncWatermark(id, this.syncProbeDependencies()); }
  getUserProjectsWatermark() { return this.syncProbes.getUserProjectsWatermark(this.syncProbeDependencies()); }
  listProjectHeadsSince(a: string, b: string) { return this.syncProbes.listProjectHeadsSince(a, b, this.syncProbeDependencies()); }
  getAccessibleProjectProbe(id: string) { return this.syncProbes.getAccessibleProjectProbe(id, this.syncProbeDependencies()); }
  getBlackBoxSyncWatermark() { return this.syncProbes.getBlackBoxSyncWatermark(this.syncProbeDependencies()); }
  getResumeRecoveryProbe(id?: string) { return this.syncProbes.getResumeRecoveryProbe(id, this.syncProbeDependencies()); }
}`;
  it.each([
    {
      label: 'missing exact provider argument',
      source: projectDataProviderSource.replace('id, this.syncProbeDependencies()', 'id'),
      expectedReasonCode: 'PROJECT_PROVIDER_CALLER_INVALID',
      expectedPosition: 'this.syncProbes.getProjectSyncWatermark',
    },
    {
      label: 'wrong delegate receiver',
      source: projectDataProviderSource.replace('this.syncProbes.getUserProjectsWatermark', 'other.getUserProjectsWatermark'),
      expectedReasonCode: 'PROJECT_PROVIDER_CALLER_INVALID',
      expectedPosition: 'other.getUserProjectsWatermark',
    },
    { label: 'provider body side effect',
      source: projectDataProviderSource.replace('private syncProbeDependencies() { return', 'private syncProbeDependencies() { this.syncProbes = rogue; return'),
      expectedReasonCode: 'PROJECT_PROVIDER_FACTORY_INVALID', expectedPosition: 'private syncProbeDependencies' },
    { label: 'caller body side effect',
      source: projectDataProviderSource.replace('getBlackBoxSyncWatermark() { return', 'getBlackBoxSyncWatermark() { this.syncProbes = rogue; return'),
      expectedReasonCode: 'PROJECT_PROVIDER_CALLER_INVALID', expectedPosition: 'getBlackBoxSyncWatermark' },
  ])('rejects six-caller ProjectData provider mutation: $label', mutation => {
    const error = captureContractError(() => coverage.extractStaticRpcFunctionReferences(
      mutation.source, projectDataPath,
    ));
    expect(error.reasonCode).toBe(mutation.expectedReasonCode);
    expect(error.position).toEqual(positionOf(mutation.source, mutation.expectedPosition, projectDataPath));
  });
  it('extracts quoted and unquoted Database.public.Functions keys', () => {
    const source = `
      export type Database = {
        auth: { Functions: { ignored_auth: {} } };
        public: {
          Tables: { ignored_table: {} };
          Functions: {
            sync_check_protocol: { Args: never; Returns: Json };
            'quoted_rpc': { Args: never; Returns: boolean };
          };
        };
      };
    `;

    expect(coverage.extractGeneratedPublicFunctionNames(source)).toEqual([
      'quoted_rpc',
      'sync_check_protocol',
    ]);
    expect(() => coverage.extractGeneratedPublicFunctionNames(
      'export type Database = { public: { Tables: {} } };',
    )).toThrow(/Database\.public\.Functions/);
  });
  it.each([
    ['folds unquoted schema and name', 'PUBLIC.AlPhA', 'alpha', true],
    ['preserves quoted name case', '"public"."Alpha"', 'Alpha', true],
    ['rejects uppercase quoted schema', '"PUBLIC".alpha', 'alpha', false],
    ['does not fold quoted requirements from unquoted names', 'public.Alpha', 'Alpha', false],
    ['unescapes doubled identifier quotes', 'public."alpha""beta"', 'alpha"beta', true],
    ['does not truncate at doubled identifier quotes', 'public."alpha""beta"', 'alpha', false],
  ])('parses PostgreSQL identifiers: %s', (_label, qualified, required, present) => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(
      `CREATE FUNCTION ${qualified}() RETURNS void LANGUAGE sql AS $$ SELECT $$;`, [required],
    );
    expect(report).toEqual({
      indeterminate: [], missing: present ? [] : [required], present: present ? [required] : [],
    });
  });

  it('fails closed when a relevant DO block contains unresolved dynamic function DDL', () => {
    const sql = `
      CREATE FUNCTION public.sync_upsert_task(payload jsonb) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT payload $$;
      CREATE FUNCTION public.sync_delete_tasks(payload jsonb) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT payload $$;
      DO $body$
      BEGIN
        EXECUTE 'ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO hidden_name';
        EXECUTE 'DROP ROUTINE public.sync_delete_tasks(JSONB)';
      END;
      $body$;
    `;

    expectIndeterminate(sql, ['sync_delete_tasks', 'sync_upsert_task']);
  });

  it.each([
    "ddl || ' SELECT 1'",
    "format('SELECT 1') || ddl",
    "format('SELECT %s', ddl)",
  ])('fails closed for unresolved procedural SQL: %s', expression => {
    const sql = `
      CREATE FUNCTION public.sync_upsert_task(payload jsonb) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT payload $$;
      DO $body$
      DECLARE ddl text := 'ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO hidden_name';
      BEGIN
        EXECUTE ${expression};
      END;
      $body$;
    `;

    expectIndeterminate(sql, ['sync_upsert_task']);
  });

  it('quarantines the full lifecycle domain for mixed dynamic DDL expressions', () => {
    const sql = `
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.beta() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$
      DECLARE suffix text;
      BEGIN
        EXECUTE 'ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY' || suffix;
      END;
      $body$;
    `;

    expectIndeterminate(sql, ['alpha', 'beta']);
  });
  it('does not interpret commented or nested-dollar function text as static procedural DDL', () => {
    const sql = `
      CREATE FUNCTION public.sync_upsert_task(payload jsonb) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT payload $$;
      DO $body$
      BEGIN
        -- ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO commented_name;
        /* outer comment
          /* nested comment */
          ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO block_comment_name;
        */
        PERFORM $sql$ALTER FUNCTION public.sync_upsert_task(JSONB) RENAME TO string_name$sql$;
      END;
      $body$;
    `;

    expect(coverage.analyzeFreshInitRpcDeclarationCoverage(
      sql,
      ['sync_upsert_task'],
    )).toEqual({
      indeterminate: [],
      missing: [],
      present: ['sync_upsert_task'],
    });
  });
  it('uses quote-aware procedural lifecycle statement boundaries', () => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(`
      CREATE FUNCTION public.sync_upsert_task(payload jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT payload $$;
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public."alpha;danger"() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.keep() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.comment_bearing() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      ALTER FUNCTION public.sync_upsert_task(JSONB) SET SCHEMA private;
      DO LANGUAGE plpgsql $body$ BEGIN
        ALTER FUNCTION "public"."comment_bearing"(/* ; */ "t😀;ype") RENAME TO "hidden_name";
        ALTER FUNCTION public.alpha("t;ype") SET SCHEMA private;
        ALTER FUNCTION public."alpha;danger"() SET SCHEMA private;
        PERFORM "DROP FUNCTION public.keep";
      END; $body$;
    `, ['alpha', 'alpha;danger', 'comment_bearing', 'keep', 'sync_upsert_task']);
    expect(report.indeterminate).toEqual([]);
    expect(report.missing).toEqual(['alpha', 'alpha;danger', 'comment_bearing', 'sync_upsert_task']);
    expect(report.present).toEqual(['keep']);
  });
  it('applies direct procedural and ROUTINE removals in source order', () => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(`
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.beta() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.gamma() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.delta() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.epsilon() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.zeta() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$
      BEGIN
        DROP FUNCTION public.alpha();
        ALTER FUNCTION public.beta() SET SCHEMA private;
        ALTER FUNCTION public.epsilon RENAME TO retired_epsilon;
      END;
      $body$;
      DROP ROUTINE public.gamma();
      ALTER ROUTINE public.delta() SET SCHEMA private;
      ALTER ROUTINE public.zeta(/* ; */ integer) RENAME TO retired_zeta;
    `, ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta']);
    expect(report).toEqual({
      indeterminate: [],
      missing: ['alpha', 'beta', 'delta', 'epsilon', 'gamma', 'zeta'],
      present: [],
    });
  });
  it.each([
    ['top-level splitting', `
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      SELECT foo$tag$bar, 名$tag$bar, 𐐀$tag$left;
      DROP FUNCTION public.alpha();
      SELECT right$tag$tail;
    `],
    ['procedural masking', `
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$ BEGIN
        PERFORM foo$tag$bar, 名$tag$bar, 𐐀$wide$left;
        DROP FUNCTION public.alpha();
        PERFORM right$wide$tail, baz$tag$qux;
      END; $body$;
    `],
  ])('does not recognize embedded dollar markers during %s', (_label, sql) => {
    expect(coverage.analyzeFreshInitRpcDeclarationCoverage(sql, ['alpha']))
      .toEqual({ indeterminate: [], missing: ['alpha'], present: [] });
  });
  it('admits only the exact static function ACL format exception', () => {
    const sqlFor = (expression: string) => `
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$ BEGIN EXECUTE ${expression}; END; $body$;
    `;

    expect(coverage.analyzeFreshInitRpcDeclarationCoverage(
      sqlFor("format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_signature)"),
      ['alpha'],
    )).toEqual({ indeterminate: [], missing: [], present: ['alpha'] });
    expect(coverage.analyzeFreshInitRpcDeclarationCoverage(
      sqlFor("format('GRANT EXECUTE ON FUNCTION %s TO authenticated', function_signature)"),
      ['alpha'],
    )).toEqual({ indeterminate: [], missing: [], present: ['alpha'] });
    expectIndeterminate(
      sqlFor("format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', function_signature) || suffix"),
      ['alpha'],
    );
    expectIndeterminate(
      sqlFor("format('REVOKE ALL ON FUNCTION %s FROM PUBLIC; DROP FUNCTION public.alpha', function_signature)"),
      ['alpha'],
    );
  });

  it('joins bounded procedural control paths without treating source order as dominance', () => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(`
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      CREATE FUNCTION public.beta() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$ BEGIN
        IF false THEN DROP FUNCTION public.alpha(); END IF;
        IF runtime_flag THEN DROP FUNCTION public.beta(); END IF;
      END; $body$;
    `, ['alpha', 'beta']);

    expect(report).toEqual({ indeterminate: ['beta'], missing: [], present: ['alpha'] });
  });

  it('treats runtime ELSIF lifecycle branches as indeterminate', () => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(`
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$ BEGIN
        IF false THEN NULL;
        ELSIF runtime_flag THEN DROP FUNCTION public.alpha();
        END IF;
      END; $body$;
    `, ['alpha']);
    expect(report).toEqual({ indeterminate: ['alpha'], missing: [], present: [] });
  });

  it.each([
    ['CASE', 'CASE WHEN runtime_flag THEN DROP FUNCTION public.alpha(); END CASE;'],
    ['RETURN', 'RETURN; DROP FUNCTION public.alpha();'],
    ['EXIT', 'EXIT; DROP FUNCTION public.alpha();'],
    ['RAISE', "RAISE NOTICE 'stop'; DROP FUNCTION public.alpha();"],
    ['EXCEPTION', 'BEGIN DROP FUNCTION public.alpha(); EXCEPTION WHEN OTHERS THEN NULL; END;'],
  ])('quarantines lifecycle events inside %s procedural control', (_label, body) => {
    expectIndeterminate(`
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      DO $body$ BEGIN
        ${body}
      END; $body$;
    `, ['alpha']);
  });

  it.each([
    ['nested block comment', '/* unterminated'],
    ['nested dollar string', '$nested$ unterminated'],
    ['nested quoted string', "'unterminated"],
    ['nested quoted identifier', '"unterminated'],
  ])('rejects procedural lexical damage: %s', (_label, damage) => {
    expect(() => coverage.analyzeFreshInitRpcDeclarationCoverage(`
      DO $body$
      BEGIN
        ${damage}
      END;
      $body$;
    `, ['alpha'])).toThrow(/unterminated procedural/i);
  });

  it('parses accepted JavaScript and rejects source or SQL lexical damage', () => {
    expect(coverage.extractStaticRpcFunctionReferences(
      "import { createServiceRoleClient } from '../_shared/widget-common.ts'; const client = createServiceRoleClient(); client.rpc('alpha');",
      'supabase/functions/widget-summary/index.js',
    ).references.map(reference => reference.name)).toEqual(['alpha']);
    expect(() => coverage.extractStaticRpcFunctionReferences(
      'client.rpc(;',
      'src/services/example.js',
    )).toThrow(/source parse error/i);
    expect(() => coverage.analyzeFreshInitRpcDeclarationCoverage(
      'CREATE FUNCTION public.alpha() RETURNS void AS $body$ SELECT 1;',
      ['alpha'],
    )).toThrow(/unterminated SQL dollar/i);
    expect(() => coverage.analyzeFreshInitRpcDeclarationCoverage(
      "DO 'BEGIN NULL; END'",
      ['alpha'],
    )).toThrow(/unresolved DO body/i);
    expect(() => coverage.analyzeFreshInitRpcDeclarationCoverage(
      "DO $body$ BEGIN RAISE NOTICE E'hello'; END $body$;",
      ['alpha'],
    )).toThrow(/unsupported procedural escape string/i);
    expect(() => coverage.analyzeFreshInitRpcDeclarationCoverage(
      "SELECT E'hello';",
      [],
    )).toThrow(/unsupported SQL escape string/i);
  });

  it('applies lifecycle statements after nested leading comments', () => {
    const report = coverage.analyzeFreshInitRpcDeclarationCoverage(`
      CREATE FUNCTION public.alpha() RETURNS void LANGUAGE sql AS $$ SELECT $$;
      /* outer /* inner */ ALTER FUNCTION public.alpha() STABLE; */
      DROP FUNCTION public.alpha();
    `, ['alpha']);
    expect(report.missing).toEqual(['alpha']);
  });

  it('binds the current repository to the exact 32-site identity matrix and ten generated-type gaps', () => {
    const report = coverage.analyzeRepositoryRpcFunctionCoverage(projectRoot);

    expect(report.references.map(reference =>
      `${reference.kind}|${reference.path}|${reference.name}`
    )).toEqual(repositoryRpcIdentityRows);
    expect(report.rpcNames).toHaveLength(31);
    expect(report.references.filter(reference => reference.kind === 'sync-rpc-transport'))
      .toHaveLength(10);
    expect(report.references
      .filter(reference => reference.kind === 'sync-rpc-transport')
      .map(reference => reference.name)).toEqual(syncTransportNames);
    expect(report.missingFromFreshInit).toEqual([]);
    expect(report.freshInitRpcDeclarations.indeterminate).toEqual([]);
    expect(report.missingFromGeneratedTypes).toEqual(generatedTypeGaps);
    expect(report.sqlClaimScope).toEqual({
      deployedStateEvaluated: false,
      kind: 'FRESH_INIT_ONLY',
      migrationReplayEvaluated: false,
      sourcePath: 'scripts/init-supabase.sql',
    });
    expect(report.unresolvedDynamicSites.every(site => site.reason === 'dynamic-rpc-name')).toBe(true);
  }, 30_000);

  it('keeps lexical and control-flow helpers policy-free', () => {
    const typescript = require('typescript') as typeof import('typescript');
    const lexicalModule = require(path.join(projectRoot, 'scripts/lib/supabase-rpc-lexical-binding.cjs')) as {
      createRpcLexicalResolver: (compiler: typeof typescript, source: import('typescript').SourceFile) => Record<string, unknown>;
    };
    const flowModule = require(path.join(projectRoot, 'scripts/lib/supabase-rpc-control-flow.cjs')) as {
      createRpcControlFlowAnalyzer: (...args: unknown[]) => Record<string, unknown>;
    };
    const flowSource = readFileSync(path.join(projectRoot, 'scripts/lib/supabase-rpc-control-flow.cjs'), 'utf8');
    for (const policyLiteral of ["'@angular/core'", "'inject'", "'getClient'", "'withAuthRetry'"]) {
      expect(flowSource).not.toContain(policyLiteral);
    }
    expect(Object.keys(lexicalModule)).toEqual(['createRpcLexicalResolver']);
    expect(Object.keys(flowModule)).toEqual(['createRpcControlFlowAnalyzer']);
    const source = typescript.createSourceFile('fixture.ts', 'const value = 1;', typescript.ScriptTarget.Latest, true);
    const lexical = lexicalModule.createRpcLexicalResolver(typescript, source);
    const flow = flowModule.createRpcControlFlowAnalyzer(typescript, source, lexical);
    expect(lexical).not.toHaveProperty('provesProviderContract');
    expect(flow).not.toHaveProperty('proveReceiver');
    expect(flow).not.toHaveProperty('inspectTransport');
  });
});
