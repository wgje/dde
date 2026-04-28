import { describe, expect, it } from 'vitest';
import { PermanentFailureError, isPermanentFailureError } from './permanent-failure-error';

describe('PermanentFailureError', () => {
  it('构造基本信息', () => {
    const err = new PermanentFailureError('conflict');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PermanentFailureError);
    expect(err.name).toBe('PermanentFailureError');
    expect(err.message).toBe('conflict');
    expect(err.isPermanentFailure).toBe(true);
  });

  it('保留 originalError 与 context', () => {
    const inner = new Error('inner');
    const err = new PermanentFailureError('outer', inner, { taskId: 't-1' });
    expect(err.originalError).toBe(inner);
    expect(err.context).toEqual({ taskId: 't-1' });
  });

  it('原型链保持正确，可被 instanceof 命中', () => {
    try {
      throw new PermanentFailureError('boom');
    } catch (e) {
      expect(e instanceof PermanentFailureError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });

  it('getFullMessage 无 originalError 时返回 message', () => {
    const err = new PermanentFailureError('solo');
    expect(err.getFullMessage()).toBe('solo');
  });

  it('getFullMessage 有 originalError 时追加原因', () => {
    const err = new PermanentFailureError('outer', new Error('root-cause'));
    expect(err.getFullMessage()).toContain('outer');
    expect(err.getFullMessage()).toContain('root-cause');
  });

  it('toJSON 包含核心字段且可序列化', () => {
    const inner = new Error('inner');
    const err = new PermanentFailureError('outer', inner, { op: 'push' });
    const json = err.toJSON();
    expect(json['name']).toBe('PermanentFailureError');
    expect(json['message']).toBe('outer');
    expect(json['isPermanentFailure']).toBe(true);
    expect(json['context']).toEqual({ op: 'push' });
    expect(json['originalError']).toEqual({ name: 'Error', message: 'inner' });
    // 应可被 JSON.stringify
    expect(() => JSON.stringify(json)).not.toThrow();
  });

  it('toJSON 在无 originalError 时 originalError 字段为 undefined', () => {
    const err = new PermanentFailureError('solo');
    const json = err.toJSON();
    expect(json['originalError']).toBeUndefined();
  });
});

describe('isPermanentFailureError (类型守卫)', () => {
  it('对 PermanentFailureError 返回 true', () => {
    expect(isPermanentFailureError(new PermanentFailureError('x'))).toBe(true);
  });

  it('对带 isPermanentFailure=true 标记的 Error 返回 true（跨 bundle 兼容）', () => {
    const marked = Object.assign(new Error('x'), { isPermanentFailure: true });
    expect(isPermanentFailureError(marked)).toBe(true);
  });

  it('对普通 Error 返回 false', () => {
    expect(isPermanentFailureError(new Error('plain'))).toBe(false);
  });

  it('对非 Error 值返回 false', () => {
    expect(isPermanentFailureError(null)).toBe(false);
    expect(isPermanentFailureError(undefined)).toBe(false);
    expect(isPermanentFailureError('string error')).toBe(false);
    expect(isPermanentFailureError({ isPermanentFailure: true })).toBe(false);
  });
});
