import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const transcribeFunctionPath = 'supabase/functions/transcribe/index.ts';
const cleanupFunctionPath = 'supabase/functions/cleanup-attachments/index.ts';
const cleanupOutboxPath = 'supabase/functions/cleanup-attachments/cleanup-outbox.ts';
const virusScanFunctionPath = 'supabase/functions/virus-scan/index.ts';
const virusScanConfigPath = 'src/config/virus-scan.config.ts';
const supabaseConfigPath = 'supabase/config.toml';
const quotaMigrationPath =
  'supabase/migrations/20260606052000_transcription_quota_and_cleanup_hardening.sql';
const initScriptPath = 'scripts/init-supabase.sql';

function readWorkspaceFile(filePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), filePath), 'utf8');
}

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function blockAfter(source: string, marker: string): string {
  const index = source.indexOf(marker);
  expect(index).toBeGreaterThanOrEqual(0);
  return source.slice(index);
}

function blockBetween(source: string, startMarker: string, endMarker: string): string {
  const startIndex = source.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('transcription quota and maintenance hardening contract', () => {
  it('defines a service-role-only RPC that releases a reserved transcription quota row', () => {
    for (const sql of [readWorkspaceFile(quotaMigrationPath), readWorkspaceFile(initScriptPath)]) {
      const normalized = normalize(sql);

      expect(normalized).toContain('CREATE OR REPLACE FUNCTION public.release_transcription_quota(');
      expect(normalized).toContain('SECURITY DEFINER');
      expect(normalized).toContain('SET search_path = pg_catalog, pg_temp');
      expect(normalized).toContain('DELETE FROM public.transcription_usage');
      expect(normalized).toContain('WHERE id = p_usage_id AND user_id = p_user_id');
      expect(normalized).toContain(
        'REVOKE ALL ON FUNCTION public.release_transcription_quota(UUID, UUID) FROM PUBLIC, anon, authenticated',
      );
      expect(normalized).toContain(
        'GRANT EXECUTE ON FUNCTION public.release_transcription_quota(UUID, UUID) TO service_role',
      );
    }
  });

  it('creates quota reservation ids through the hardened pgcrypto schema', () => {
    for (const sql of [readWorkspaceFile(quotaMigrationPath), readWorkspaceFile(initScriptPath)]) {
      const normalized = normalize(sql);

      expect(normalized).toContain('v_usage_id := extensions.gen_random_uuid()');
      expect(normalized).not.toContain('v_usage_id := gen_random_uuid()');
    }
  });

  it('keeps the quota reservation usage_id and refunds it before every post-reservation failure', () => {
    const source = readWorkspaceFile(transcribeFunctionPath);
    const afterReservation = blockAfter(source, 'quotaReservation = quota;');

    expect(source).toContain('usageId');
    expect(source).toContain('releaseQuotaReservation');

    for (const code of [
      'SERVICE_NOT_CONFIGURED',
      'GROQ_TIMEOUT',
      'GROQ_UNREACHABLE',
      'GROQ_RATE_LIMITED',
      'SERVICE_UNAVAILABLE',
    ]) {
      const codeIndex = afterReservation.indexOf(code);
      expect(codeIndex, `${code} response must stay after quota reservation`).toBeGreaterThanOrEqual(0);
      const precedingFailureBranch = afterReservation.slice(Math.max(0, codeIndex - 900), codeIndex);
      expect(precedingFailureBranch, `${code} must release reserved quota before returning`).toContain(
        'await releaseQuotaReservation(',
      );
    }

    const catchBlock = blockAfter(source, '} catch (error: unknown) {');
    expect(catchBlock.slice(0, 500)).toContain('await releaseQuotaReservation(');
  });

  it('rejects unsupported methods before parsing request bodies in browser-callable functions', () => {
    for (const [filePath, bodyParseCall] of [
      [transcribeFunctionPath, 'readFormDataWithLimit(req)'],
      ['supabase/functions/virus-scan/index.ts', 'readJsonWithLimit<ScanRequest>(req)'],
    ]) {
      const source = readWorkspaceFile(filePath);
      const optionsIndex = source.indexOf("req.method === 'OPTIONS'");
      const methodGuardIndex = source.indexOf("req.method !== 'POST'");
      const bodyParseIndex = source.indexOf(bodyParseCall);

      expect(methodGuardIndex).toBeGreaterThan(optionsIndex);
      expect(methodGuardIndex).toBeGreaterThanOrEqual(0);
      expect(methodGuardIndex).toBeLessThan(bodyParseIndex);
      expect(source).toContain('METHOD_NOT_ALLOWED');
      expect(source).toContain('405');
    }
  });

  it('caps transcribe multipart request bodies before FormData parsing', () => {
    const source = readWorkspaceFile(transcribeFunctionPath);
    const normalized = normalize(source);

    expect(source).toContain('class RequestBodyTooLargeError extends Error');
    expect(source).toContain('async function readFormDataWithLimit(req: Request): Promise<FormData>');
    expect(source).not.toContain('await req.formData()');
    expect(normalized).toContain('if (receivedBytes > maxBytes)');
    expect(normalized).toContain('throw new RequestBodyTooLargeError();');
    expect(normalized).toContain('const formData = await readFormDataWithLimit(req)');
  });

  it('caps virus scan JSON request bodies before JSON parsing', () => {
    const source = readWorkspaceFile(virusScanFunctionPath);
    const normalized = normalize(source);

    expect(source).toContain('class RequestBodyTooLargeError extends Error');
    expect(source).toContain('async function readJsonWithLimit<T>(req: Request): Promise<T>');
    expect(source).not.toContain('await req.json() as ScanRequest');
    expect(normalized).toContain('if (receivedBytes > maxBytes)');
    expect(normalized).toContain('throw new RequestBodyTooLargeError();');
    expect(normalized).toContain('const body = await readJsonWithLimit<ScanRequest>(req)');
  });

  it('cancels bounded request readers before throwing size-limit errors', () => {
    for (const [filePath, functionName] of [
      [transcribeFunctionPath, 'readRequestBytesWithLimit'],
      [virusScanFunctionPath, 'readRequestTextWithLimit'],
    ]) {
      const source = readWorkspaceFile(filePath);
      const readerBlock = blockAfter(source, `async function ${functionName}`);
      const beforeNextFunction = readerBlock.slice(0, readerBlock.indexOf('\nasync function', 1));
      const normalized = normalize(beforeNextFunction);

      expect(normalized, `${filePath} must cancel the reader before throwing 413`).toContain(
        'await reader.cancel().catch(() => undefined); throw new RequestBodyTooLargeError();',
      );
      expect(normalized, `${filePath} must always release the reader lock`).toContain(
        'finally { reader.releaseLock(); }',
      );
    }
  });

  it('fails closed for stale or missing virus scan download status until real rescan exists', () => {
    const source = readWorkspaceFile(virusScanConfigPath);

    expect(source).toContain("ON_EXPIRED_STATUS: 'block'");
    expect(source).toContain("ON_UNSCANNED: 'block'");
    expect(source).not.toContain("ON_EXPIRED_STATUS: 'rescan'");
    expect(source).not.toContain("ON_UNSCANNED: 'warn'");
  });

  it('keeps frontend virus-scan upload limit aligned with the Edge function raw-file cap', () => {
    const config = readWorkspaceFile(virusScanConfigPath);
    const edgeFunction = readWorkspaceFile(virusScanFunctionPath);

    expect(config).toContain('MAX_FILE_SIZE: 10 * 1024 * 1024');
    expect(config).not.toContain('MAX_FILE_SIZE: 50 * 1024 * 1024');
    expect(edgeFunction).toContain('const MAX_FILE_BASE64_LENGTH = 10 * 1024 * 1024 * 1.37');
  });

  it('keeps transcribe production logs non-verbose and identifier-safe', () => {
    const source = readWorkspaceFile(transcribeFunctionPath);

    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('user.id.slice');
    expect(source).not.toContain('name: audioFile.name');
  });

  it('keeps browser-callable Edge success paths free of user-identifying console logs', () => {
    for (const filePath of [
      virusScanFunctionPath,
      'supabase/functions/widget-focus-action/index.ts',
      'supabase/functions/widget-black-box-action/index.ts',
    ]) {
      const source = readWorkspaceFile(filePath);

      expect(source).not.toContain('console.log(');
      expect(source).not.toContain('Authenticated user');
      expect(source).not.toContain('userId.slice');
      expect(source).not.toContain('widget_focus_${action}_success');
      expect(source).not.toContain('widget_black_box_action_success');
    }
  });

  it('keeps attachment cleanup authorization on a dedicated maintenance secret, not the service-role key', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const verifierBlock = blockBetween(
      source,
      'async function verifyMaintenanceBearer',
      'function redactCleanupError',
    );

    expect(source).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(source).toContain('MAINTENANCE_SECRET');
    expect(verifierBlock).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(verifierBlock).not.toContain('allowedSecrets');
    expect(verifierBlock).toMatch(/sha256Hex\(MAINTENANCE_SECRET\)/);
    expect(verifierBlock).toMatch(/actualHash === expectedHash/);
  });

  it('disables Supabase JWT verification for cleanup-attachments maintenance-secret auth', () => {
    const config = readWorkspaceFile(supabaseConfigPath);

    expect(config).toMatch(/\[functions\.cleanup-attachments]\s+verify_jwt\s*=\s*false/);
  });

  it('fails attachment cleanup with 503 before creating a service-role client when runtime Supabase config is missing', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const normalized = normalize(source);

    expect(normalized).toContain('const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""');
    expect(normalized).toContain('if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)');
    expect(normalized).toContain('Supabase service configuration is not configured');
    expect(normalized).toContain('status: 503');
    expect(normalized.indexOf('if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)')).toBeLessThan(
      normalized.indexOf('createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'),
    );
  });

  it('fails browser-callable service-role functions with 503 before creating clients when Supabase config is missing', () => {
    for (const filePath of [transcribeFunctionPath, virusScanFunctionPath]) {
      const source = readWorkspaceFile(filePath);
      const normalized = normalize(source);

      expect(normalized).toContain("const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''");
      expect(normalized).toContain("const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''");
      expect(normalized).toContain('if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)');
      expect(normalized).toContain('Supabase service configuration is not configured');
      expect(source).toMatch(/status\s*:\s*503|,\s*503\s*\)/);
      const serviceConfigGuardIndex = source.search(
        /if\s*\(\s*!SUPABASE_URL\s*\|\|\s*!SUPABASE_SERVICE_ROLE_KEY\s*\)/,
      );
      const serviceRoleClientIndex = source.search(
        /createClient\s*\(\s*SUPABASE_URL\s*,\s*SUPABASE_SERVICE_ROLE_KEY/,
      );
      expect(serviceConfigGuardIndex).toBeGreaterThanOrEqual(0);
      expect(serviceRoleClientIndex).toBeGreaterThanOrEqual(0);
      expect(serviceConfigGuardIndex).toBeLessThan(serviceRoleClientIndex);
    }
  });

  it('uses the same sanitized attachment storage extension semantics during cleanup', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);

    expect(source).toContain('function sanitizePathSegment(segment: string): string');
    expect(source).toContain('function isUuidLike(value: unknown): value is string');
    expect(source).toContain('function isTaskAttachment(value: unknown): value is TaskAttachment');
    expect(source).toContain('if (!Array.isArray(attachments) || attachments.length === 0) continue');
    expect(source).toContain('if (!isUuidLike(task.id)');
    expect(source).toContain('!isUuidLike(task.project_id)');
    expect(source).toContain('!isUuidLike(ownerId)');
    expect(source).toContain('if (!isTaskAttachment(rawAttachment))');
    expect(source).toContain('!isUuidLike(attachment.id)');
    expect(source).toContain('const fileExt = sanitizePathSegment(attachment.name.split(".").pop() || "bin")');
    expect(source).toContain('fileName: `${attachment.id}.${fileExt}`');
  });

  it('claims expired attachment rows with updated_at CAS before deleting Storage objects', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const outbox = readWorkspaceFile(cleanupOutboxPath);
    const claimIndex = source.lastIndexOf('await claimTaskAttachmentCleanup(');
    const drainIndex = source.indexOf('await drainAttachmentCleanupOutbox(');

    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(claimIndex).toBeLessThan(drainIndex);
    expect(source).toContain('claimedAttachmentsToDelete');
    expect(outbox).toContain('claim_task_attachment_cleanup');
    expect(outbox).toContain('p_expected_updated_at: request.expectedUpdatedAt');
    expect(outbox).toContain('client.storage.from(job.bucket).remove');
    expect(outbox).toContain('complete_attachment_cleanup_job');
    expect(outbox).toContain('fail_attachment_cleanup_job');
    expect(source).toContain('Skipped DB update - task changed during cleanup');
  });

  it('rotates attachment cleanup scans with a persisted cursor so later task batches are reachable', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const normalized = normalize(source);

    expect(source).toContain('readAttachmentCleanupCursor');
    expect(source).toContain('fetchCleanupTasks');
    expect(source).toContain('.eq("type", "attachment_cleanup")');
    expect(source).toContain('.order("created_at", { ascending: false })');
    expect(source).toContain('.gt("id", afterTaskId)');
    expect(source).toContain('.order("id", { ascending: true })');
    expect(source).toContain('nextCursor');
    expect(source).toContain('scanWrapped');
    expect(normalized).toContain('tasks = taskFetch.tasks');
  });

  it('logs no-op attachment cleanup runs so the scan cursor advances even without expired attachments', () => {
    const source = readWorkspaceFile(cleanupFunctionPath);
    const logIndex = source.indexOf('await logCleanup(');
    const noExpiredIndex = source.indexOf('attachmentsToDelete.length === 0');

    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(noExpiredIndex).toBeGreaterThanOrEqual(0);
    expect(logIndex).toBeLessThan(noExpiredIndex);
    expect(source).toContain('nextCursor');
    expect(source).toContain('tasksProcessed');
  });

  it('uses non-persistent service-role Supabase clients in Edge Functions', () => {
    const sources = [
      readWorkspaceFile(transcribeFunctionPath),
      readWorkspaceFile(virusScanFunctionPath),
      readWorkspaceFile('supabase/functions/_shared/widget-common.ts'),
      readWorkspaceFile('supabase/functions/widget-black-box-action/index.ts'),
      readWorkspaceFile(cleanupFunctionPath),
    ];

    for (const source of sources) {
      const normalized = normalize(source);
      expect(normalized).toContain('auth: { autoRefreshToken: false, persistSession: false }');
    }
  });

  it('fails widget service-role functions with controlled 503 before creating clients when Supabase config is missing', () => {
    const widgetEntryFiles = [
      'supabase/functions/widget-register/index.ts',
      'supabase/functions/widget-summary/index.ts',
      'supabase/functions/widget-notify/index.ts',
      'supabase/functions/widget-focus-action/index.ts',
      'supabase/functions/widget-black-box-action/index.ts',
    ];

    for (const filePath of widgetEntryFiles) {
      const source = readWorkspaceFile(filePath);
      const usesSharedPayload = source.includes('serviceNotConfiguredPayload');

      expect(
        usesSharedPayload || source.includes('SERVICE_NOT_CONFIGURED'),
        `${filePath} must use the shared or inline service-not-configured payload`,
      ).toBe(true);
      expect(
        usesSharedPayload || source.includes('Supabase service configuration is not configured'),
        `${filePath} must return a controlled service-not-configured message`,
      ).toBe(true);
      expect(source).toMatch(/status\s*:\s*503|,\s*503\s*\)/);

      const guardIndex = source.search(
        /hasServiceRoleConfig\s*\(\s*\)|if\s*\(\s*!SUPABASE_URL\s*\|\|\s*!SUPABASE_SERVICE_ROLE_KEY\s*\)/,
      );
      const serviceRoleClientIndex = source.indexOf('const client = createServiceRoleClient();');
      expect(guardIndex, `${filePath} must guard missing service-role config`).toBeGreaterThanOrEqual(0);
      expect(serviceRoleClientIndex, `${filePath} must create a service-role client`).toBeGreaterThanOrEqual(0);
      expect(guardIndex, `${filePath} must guard before creating a service-role client`).toBeLessThan(serviceRoleClientIndex);
    }

    const sharedSource = readWorkspaceFile('supabase/functions/_shared/widget-common.ts');
    expect(sharedSource).toContain('SERVICE_NOT_CONFIGURED');
    expect(sharedSource).toContain('Supabase service configuration is not configured');
  });

  it('virus scan must not report success when scan result persistence or rescan updates fail', () => {
    const source = readWorkspaceFile(virusScanFunctionPath);
    const normalized = normalize(source);

    expect(normalized).toContain("const { error: saveError } = await supabase.from('attachment_scans').upsert");
    expect(normalized).toContain("if (saveError) { throw new Error(`Failed to save scan result:");
    const markFailureIndex = source.indexOf('async function markRescanFailed(');
    expect(markFailureIndex).toBeGreaterThanOrEqual(0);
    const markFailureSource = normalize(source.slice(markFailureIndex));
    expect(markFailureSource).toContain('.update({');
    expect(markFailureSource).toContain('status: SCAN_STATUS.FAILED');
    expect(markFailureSource).toContain(".eq('rescan_token', rescanToken)");
    expect(markFailureSource).toContain(".eq('status', SCAN_STATUS.SCANNING)");
    expect(markFailureSource).toContain('failureUpdateError');
    expect(markFailureSource).toContain('return !!updatedScan');
  });

  it('virus scan status lookups use a narrow projection on service-role reads', () => {
    const source = readWorkspaceFile(virusScanFunctionPath);
    const normalized = normalize(source);
    const statusHandler = blockAfter(normalized, 'async function handleStatusCheck');

    expect(statusHandler).toContain(
      ".select('file_id,status,threat_name,threat_description,scanned_at,scanner,engine_version,signature_version')",
    );
    expect(statusHandler.slice(0, statusHandler.indexOf('async function handleHashVerification'))).not.toContain(
      ".select('*')",
    );
  });
});
