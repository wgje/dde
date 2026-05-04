import { describe, expect, it } from 'vitest';
import { isValidSiyuanBlockId, normalizeSiyuanUri, parseSiyuanBlockLink } from './siyuan-link-parser';

describe('siyuan-link-parser', () => {
  it('parses siyuan block deep links and normalizes focus uri', () => {
    const parsed = parseSiyuanBlockLink(' siyuan://blocks/20260426123456-abc1234?focus=0 ');

    expect(parsed).toEqual({
      blockId: '20260426123456-abc1234',
      uri: 'siyuan://blocks/20260426123456-abc1234?focus=1',
    });
  });

  it('accepts bare block ids', () => {
    expect(parseSiyuanBlockLink('20260426123456-abc1234')?.uri).toBe(
      normalizeSiyuanUri('20260426123456-abc1234'),
    );
  });

  it('rejects unsafe protocols and multiline input', () => {
    expect(parseSiyuanBlockLink('javascript:alert(1)')).toBeNull();
    expect(parseSiyuanBlockLink('https://example.com/20260426123456-abc1234')).toBeNull();
    expect(parseSiyuanBlockLink('20260426123456-abc1234\nother')).toBeNull();
  });

  it('validates SiYuan block id format exactly', () => {
    expect(isValidSiyuanBlockId('20260426123456-abc1234')).toBe(true);
    expect(isValidSiyuanBlockId('20260426123456-abc123')).toBe(false);
    expect(isValidSiyuanBlockId('20260426123456-ABC1234')).toBe(false);
    expect(parseSiyuanBlockLink('siyuan://blocks/20260426123456-ABC1234')).toBeNull();
  });
});
