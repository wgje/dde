import { describe, expect, it } from 'vitest';

import {
  buildSupabaseRequestSignature,
  getSupabaseRequestMethod,
  redactSupabaseRequestUrl,
} from './supabase-fetch-request.helpers';

describe('supabase request signature method authority', () => {
  const url = 'https://example.test/resource';

  it('uses a Request HEAD method when options.method is absent', () => {
    const request = new Request(url, { method: 'HEAD' });

    expect(getSupabaseRequestMethod(request, {})).toBe('HEAD');
    expect(buildSupabaseRequestSignature(request, {})).toBe(`HEAD:${url}:`);
  });

  it('keeps same-URL GET and HEAD signatures distinct', () => {
    const getSignature = buildSupabaseRequestSignature(new Request(url, { method: 'GET' }), {});
    const headSignature = buildSupabaseRequestSignature(new Request(url, { method: 'HEAD' }), {});

    expect(getSignature).toBe(`GET:${url}:`);
    expect(headSignature).toBe(`HEAD:${url}:`);
    expect(getSignature).not.toBe(headSignature);
  });

  it('lets an explicit options.method override the Request method', () => {
    const request = new Request(url, { method: 'POST' });

    expect(buildSupabaseRequestSignature(request, { method: 'get' })).toBe(`GET:${url}:`);
  });

  it('keeps string and URL inputs defaulting to GET', () => {
    expect(buildSupabaseRequestSignature(url, {})).toBe(`GET:${url}:`);
    expect(buildSupabaseRequestSignature(new URL(url), {})).toBe(`GET:${url}:`);
  });

  it('keeps body truncation at 100 characters', () => {
    const body = 'a'.repeat(150);

    expect(buildSupabaseRequestSignature(url, { method: 'POST', body })).toBe(`POST:${url}:${'a'.repeat(100)}`);
  });

  it('keeps URL redaction query-stripped', () => {
    const signedUrl = 'https://example.test/resource?a=1&b=2';

    expect(redactSupabaseRequestUrl(signedUrl)).toBe(url);
  });
});
