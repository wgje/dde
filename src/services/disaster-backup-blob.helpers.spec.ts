import { describe, expect, it } from 'vitest';

import { blobToBase64 } from './disaster-backup-blob.helpers';

describe('disaster backup blob helpers', () => {
  it('converts a blob payload to base64 for attachment backup export', async () => {
    const blob = new Blob(['NanoFlow']);

    await expect(blobToBase64(blob)).resolves.toBe('TmFub0Zsb3c=');
  });
});
