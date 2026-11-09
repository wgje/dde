/**
 * Virus-scan rescan 真实重扫合同测试
 *
 * 覆盖「目标5」重扫闭环：rescan API 不再只把状态改成 scanning，
 * 而是从 Storage 下载原文件、复用与首扫一致的 ClamAV 扫描实现，
 * 并按结果更新既有 attachment_scans 记录。
 *
 * 测试模式与 widget-backend.contract.spec.ts 一致：
 * 从 Deno Edge Function 源码抽取相关函数，经 TypeScript 转译后在
 * Node/Vitest 中直接执行，Supabase client 与 ClamAV fetch 均为 mock。
 *
 * @see supabase/functions/virus-scan/index.ts
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clamAvResponse,
  createMockRescanClient,
  flushMicrotasks,
  loadRescanHelpers,
} from './virus-scan-rescan.contract.spec-helpers';
import { registerVirusScanRescanContractEdgeSpecs } from './virus-scan-rescan-contract-edge.spec-helpers';

describe('virus-scan rescan real-scan contract', () => {
  const helpers = loadRescanHelpers();

  const fileId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const taskId = '33333333-3333-4333-8333-333333333333';
  const projectId = '44444444-4444-4444-8444-444444444444';
  const attachmentId = '55555555-5555-4555-8555-555555555555';

  const taskRow = {
    id: taskId,
    project_id: projectId,
    attachments: [
      { id: '66666666-6666-4666-8666-666666666666', name: 'other.txt', scanMetadata: { fileId: '77777777-7777-4777-8777-777777777777' } },
      { id: attachmentId, name: 'document.pdf', scanMetadata: { fileId } },
    ],
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    helpers.__rescanTestState.client = null;
  });

  it('accepts only the configured internal rescan secret', () => {
    expect(helpers.hasValidRescanCronSecret(new Request('https://example.test', {
      headers: { 'x-virus-rescan-secret': 'cron-secret' },
    }))).toBe(true);
    expect(helpers.hasValidRescanCronSecret(new Request('https://example.test', {
      headers: { 'x-virus-rescan-secret': 'wrong-secret' },
    }))).toBe(false);
    expect(helpers.hasValidRescanCronSecret(new Request('https://example.test'))).toBe(false);
  });

  it('hash verification checks the current Storage object instead of trusting two stale hashes', async () => {
    const scannedHash = createHash('sha256').update('scanned-bytes').digest('hex');
    const { client, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId, file_hash: scannedHash },
      taskRow,
      download: { data: new Blob(['replaced-bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleHashVerification(
      { action: 'verify-hash', fileId, expectedHash: scannedHash },
      userId,
      {},
    );
    const body = await response.json() as Record<string, unknown>;

    expect(body['valid']).toBe(false);
    expect(downloads).toEqual([`${userId}/${projectId}/${taskId}/${attachmentId}.pdf`]);
  });

  it('performs a real rescan: downloads the stored file, scans it, and persists the clean result', async () => {
    const fetchMock = vi.fn(async () => clamAvResponse({
      infected: false,
      engine_version: '1.4.3',
      signature_version: '27600',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { client, updates, downloads, rpcCalls, queries, storageLists } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['clean-file-bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ fileId, status: 'clean', message: 'Rescan completed' });

    // 存储路径与上传侧 buildAttachmentStoragePath 一致：userId/projectId/taskId/attachmentId.ext
    expect(downloads).toEqual([`${userId}/${projectId}/${taskId}/${attachmentId}.pdf`]);
    expect(storageLists).toEqual([
      {
        folder: `${userId}/${projectId}/${taskId}`,
        options: { search: `${attachmentId}.pdf`, limit: 10 },
      },
      {
        folder: `${userId}/${projectId}/${taskId}`,
        options: { search: `${attachmentId}.pdf`, limit: 10 },
      },
    ]);

    // 与首扫共用同一 ClamAV 端点
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://clamav:3310/scan',
      expect.objectContaining({ method: 'POST' }),
    );

    expect(rpcCalls).toEqual([{
      name: 'claim_attachment_scan_rescan',
      args: expect.objectContaining({ p_file_id: fileId, p_user_id: userId }),
    }]);
    expect(queries).toContainEqual({
      table: 'tasks',
      filters: expect.arrayContaining([['projects.owner_id', userId]]),
    });

    // 终态必须带 claim token + scanning 状态 CAS，旧任务不能覆盖新结果
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.table).toBe('attachment_scans');
    expect(finalUpdate?.payload['status']).toBe('clean');
    expect(finalUpdate?.payload['scanner']).toBe('clamav');
    expect(finalUpdate?.payload['engine_version']).toBe('1.4.3');
    expect(finalUpdate?.payload['error_message']).toBeNull();
    expect(finalUpdate?.payload['file_hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(finalUpdate?.payload['rescan_token']).toBeNull();
    expect(finalUpdate?.payload['next_rescan_at']).toEqual(expect.any(String));
    expect(finalUpdate?.filters).toEqual([
      ['file_id', fileId],
      ['user_id', userId],
      ['rescan_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['status', 'scanning'],
    ]);
  });

  it('claims and processes a bounded due batch concurrently without reclaiming each row', async () => {
    const secondFileId = '88888888-8888-4888-8888-888888888888';
    const secondAttachmentId = '99999999-9999-4999-8999-999999999999';
    const firstToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const dueTaskRow = {
      ...taskRow,
      attachments: [
        ...taskRow.attachments,
        { id: secondAttachmentId, name: 'notes.txt', scanMetadata: { fileId: secondFileId } },
      ],
    };

    let releaseScans: (() => void) | undefined;
    const scanGate = new Promise<void>(resolve => {
      releaseScans = resolve;
    });
    let activeScans = 0;
    let maxActiveScans = 0;
    const fetchMock = vi.fn(async () => {
      activeScans += 1;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      if (activeScans === 2) releaseScans?.();
      await scanGate;
      activeScans -= 1;
      return clamAvResponse({ infected: false });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { client, rpcCalls, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow: dueTaskRow,
      download: { data: new Blob(['clean-file-bytes']), error: null },
      dueClaimResults: [
        { file_id: fileId, user_id: userId, token: firstToken },
        { file_id: secondFileId, user_id: userId, token: secondToken },
      ],
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleDueRescan({ action: 'rescan-due', limit: 999 }, {});
    const body = await response.json() as Record<string, unknown>;

    expect(body).toEqual({ scanned: 2, deferred: 0, requested: 2 });
    expect(maxActiveScans).toBe(2);
    expect(downloads).toEqual(expect.arrayContaining([
      `${userId}/${projectId}/${taskId}/${attachmentId}.pdf`,
      `${userId}/${projectId}/${taskId}/${secondAttachmentId}.txt`,
    ]));
    expect(rpcCalls).toEqual([{
      name: 'claim_due_attachment_scan_rescans',
      args: { p_limit: 6, p_stale_after_seconds: 900 },
    }]);
  });

  it('fails closed when the due-claim RPC returns a non-array payload', async () => {
    const { client, downloads } = createMockRescanClient({
      dueClaimPayload: { file_id: fileId, user_id: userId },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleDueRescan({ action: 'rescan-due' }, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body['error']).toBe('Invalid due rescan claim result');
    expect(downloads).toHaveLength(0);
  });

  it('aborts a deferred Storage download and waits for its late success before failing the claim', async () => {
    vi.useFakeTimers();
    let resolveStorage: ((response: Response) => void) | undefined;
    let storageSignal: AbortSignal | undefined;
    const storageResponse = new Promise<Response>(resolve => {
      resolveStorage = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      storageSignal = init?.signal ?? undefined;
      return storageResponse;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      downloadViaScopedFetch: true,
    });
    helpers.__rescanTestState.client = client;

    const responsePromise = helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(storageSignal?.aborted).toBe(false);

    let responseSettled = false;
    void responsePromise.then(() => {
      responseSettled = true;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(storageSignal?.aborted).toBe(true);
    expect(responseSettled).toBe(false);
    expect(updates).toHaveLength(0);

    resolveStorage?.(new Response('late-storage-success'));
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const response = await responsePromise;
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(504);
    expect(body['error']).toBe('Rescan timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(updates.some(update => update.payload['status'] === 'clean')).toBe(false);
    expect(updates.at(-1)?.payload['status']).toBe('failed');
    expect(updates.at(-1)?.filters).toEqual(expect.arrayContaining([
      ['rescan_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['status', 'scanning'],
    ]));
  });

  it('aborts a deferred ClamAV fetch and rejects its late clean result before the success CAS write', async () => {
    vi.useFakeTimers();
    let resolveClamAv: ((response: Response) => void) | undefined;
    let clamAvSignal: AbortSignal | undefined;
    const clamAvResponsePromise = new Promise<Response>(resolve => {
      resolveClamAv = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      clamAvSignal = init?.signal ?? undefined;
      return clamAvResponsePromise;
    }));
    const { client, updates, storageLists } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['clean-file-bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const responsePromise = helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.waitFor(() => {
      expect(clamAvSignal).toBeDefined();
    }, { timeout: 1_000, interval: 1 });
    expect(clamAvSignal?.aborted).toBe(false);

    let responseSettled = false;
    void responsePromise.then(() => {
      responseSettled = true;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(clamAvSignal?.aborted).toBe(true);
    expect(responseSettled).toBe(false);
    expect(updates).toHaveLength(0);

    resolveClamAv?.(clamAvResponse({ infected: false }));
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    const response = await responsePromise;
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(504);
    expect(body['error']).toBe('Rescan timed out');
    expect(storageLists).toHaveLength(1);
    expect(updates.some(update => update.payload['status'] === 'clean')).toBe(false);
    expect(updates.at(-1)?.payload['status']).toBe('failed');
    expect(updates.at(-1)?.filters).toEqual(expect.arrayContaining([
      ['rescan_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['status', 'scanning'],
    ]));
  });

  registerVirusScanRescanContractEdgeSpecs({
    helpers,
    fileId,
    userId,
    taskRow,
  });

});
