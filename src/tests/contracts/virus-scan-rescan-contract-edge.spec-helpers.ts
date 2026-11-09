import { expect, it, vi } from 'vitest';

import {
  clamAvResponse,
  createMockRescanClient,
  type RescanHelpers,
} from './virus-scan-rescan.contract.spec-helpers';

interface VirusScanRescanContractEdgeSpecContext {
  helpers: RescanHelpers;
  fileId: string;
  userId: string;
  taskRow: unknown;
}

export function registerVirusScanRescanContractEdgeSpecs(
  context: VirusScanRescanContractEdgeSpecContext,
): void {
  const { helpers, fileId, userId, taskRow } = context;

  it('does not download when the atomic rescan claim is already in progress', async () => {
    const { client, updates, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      claimResult: {
        claimed: false,
        token: null,
        reason: 'in_progress',
        current_status: 'scanning',
        retry_after_seconds: 30,
      },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body['error']).toBe('Rescan already in progress');
    expect(body['retryAfterSeconds']).toBe(30);
    expect(downloads).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('rejects an oversized stored object before downloading it', async () => {
    const { client, updates, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      objectVersions: [{
        id: 'storage-object-version-oversized',
        updated_at: '2026-07-14T00:00:00.000Z',
        metadata: { size: 10 * 1024 * 1024 + 1, eTag: 'etag-oversized' },
      }],
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(413);
    expect(body['error']).toBe('Stored file too large (max 10MB)');
    expect(downloads).toHaveLength(0);
    expect(updates.at(-1)?.payload['status']).toBe('failed');
    expect(updates.at(-1)?.payload['next_rescan_at']).toBeNull();
  });

  it('fails closed when the Storage object version changes during rescan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => clamAvResponse({ infected: false })));
    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['clean-file-bytes']), error: null },
      objectVersions: [{
        id: 'storage-object-version-1',
        updated_at: '2026-07-14T00:00:00.000Z',
        metadata: { size: 16, eTag: 'etag-1' },
      }, {
        id: 'storage-object-version-2',
        updated_at: '2026-07-14T00:00:01.000Z',
        metadata: { size: 16, eTag: 'etag-2' },
      }],
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body['error']).toBe('Storage object changed during rescan');
    expect(updates.at(-1)?.payload['status']).toBe('failed');
    expect(updates.some(update => update.payload['status'] === 'clean')).toBe(false);
  });

  it('returns 409 when the token-scoped final CAS update matches no row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => clamAvResponse({ infected: false })));
    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['clean-file-bytes']), error: null },
      casUpdateMatched: false,
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body['error']).toBe('Rescan result superseded');
    expect(updates.at(-1)?.filters).toEqual(expect.arrayContaining([
      ['rescan_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['status', 'scanning'],
    ]));
  });

  it('marks the rescan as threat_detected when ClamAV reports an infected file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => clamAvResponse({
      infected: true,
      virus_name: 'EICAR-Test-Signature',
      description: 'test signature',
    })));

    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['infected-bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ fileId, status: 'threat_detected', message: 'Rescan completed' });

    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.payload['status']).toBe('threat_detected');
    expect(finalUpdate?.payload['threat_name']).toBe('EICAR-Test-Signature');
  });

  it('returns a structured 404 and fails the scan record when no attachment references the fileId', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client, updates, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow: null,
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'File not found in storage' });

    expect(downloads).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.payload['status']).toBe('failed');
    expect(String(finalUpdate?.payload['error_message'])).toContain('not found');
    expect(finalUpdate?.payload['next_rescan_at']).toBeNull();
    expect(finalUpdate?.filters).toEqual([
      ['file_id', fileId],
      ['user_id', userId],
      ['rescan_token', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['status', 'scanning'],
    ]);
  });

  it('returns a structured 404 and fails the scan record when the storage object is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { client, updates, downloads } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: null, error: { message: 'Object not found' } },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'File not found in storage' });

    expect(downloads).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.payload['status']).toBe('failed');
    expect(String(finalUpdate?.payload['error_message'])).toContain('Storage download failed');
    expect(finalUpdate?.payload['next_rescan_at']).toBeNull();
  });

  it('persists failed status and returns the scan-failure shape when the scanner is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED clamav:3310');
    }));

    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body['fileId']).toBe(fileId);
    expect(body['status']).toBe('failed');
    expect(body['error']).toBe('File rescan could not be completed');
    expect(body['scanner']).toBe('clamav');
    expect(typeof body['scannedAt']).toBe('string');
    expect(body['message']).toBeUndefined();

    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.payload['status']).toBe('failed');
    expect(String(finalUpdate?.payload['error_message'])).toContain('ClamAV scan failed');
  });

  it.each([
    {},
    { infected: 'false' },
    { error: 'scanner warming up' },
  ])('fails closed when ClamAV returns a malformed successful response: %j', async payload => {
    vi.stubGlobal('fetch', vi.fn(async () => clamAvResponse(payload)));
    const { client, updates } = createMockRescanClient({
      scanRecord: { file_id: fileId },
      taskRow,
      download: { data: new Blob(['bytes']), error: null },
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(body['status']).toBe('failed');
    expect(body['message']).toBeUndefined();
    const finalUpdate = updates.at(-1);
    expect(finalUpdate?.payload['status']).toBe('failed');
    expect(String(finalUpdate?.payload['error_message'])).toContain('ClamAV scan failed');
  });

  it('returns 404 for a rescan of a scan record the user does not own', async () => {
    const { client, updates, downloads } = createMockRescanClient({
      scanRecord: null,
      taskRow,
    });
    helpers.__rescanTestState.client = client;

    const response = await helpers.handleRescan({ action: 'rescan', fileId }, userId, {});
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'Scan record not found' });
    expect(updates).toHaveLength(0);
    expect(downloads).toHaveLength(0);
  });
}
