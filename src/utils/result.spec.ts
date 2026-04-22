import { describe, expect, it } from 'vitest';
import {
  ErrorCodes,
  ErrorMessages,
  extractErrorMessage,
  failure,
  getErrorMessage,
  humanizeErrorMessage,
  isFailure,
  isSuccess,
  success,
  type OperationError,
} from './result';

describe('result — success/failure 构造器', () => {
  it('success 返回 ok=true 且携带 value', () => {
    const result = success(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('failure 返回 ok=false 且携带标准错误结构', () => {
    const result = failure(ErrorCodes.DATA_NOT_FOUND, '任务缺失', { taskId: 't-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCodes.DATA_NOT_FOUND);
      expect(result.error.message).toBe('任务缺失');
      expect(result.error.details).toEqual({ taskId: 't-1' });
    }
  });

  it('failure 的 details 允许省略', () => {
    const result = failure(ErrorCodes.UNKNOWN, 'boom');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details).toBeUndefined();
    }
  });
});

describe('result — 类型守卫', () => {
  it('isSuccess/isFailure 能正确窄化类型', () => {
    const ok = success('data');
    const err = failure(ErrorCodes.UNKNOWN, 'x');

    expect(isSuccess(ok)).toBe(true);
    expect(isFailure(ok)).toBe(false);
    expect(isSuccess(err)).toBe(false);
    expect(isFailure(err)).toBe(true);
  });
});

describe('result — getErrorMessage', () => {
  it('已知错误码返回映射消息', () => {
    const err: OperationError = { code: ErrorCodes.SYNC_CONFLICT, message: '内部' };
    expect(getErrorMessage(err)).toBe(ErrorMessages[ErrorCodes.SYNC_CONFLICT]);
  });

  it('未知错误码优先返回 message', () => {
    const err: OperationError = { code: 'NOT_MAPPED', message: '原始消息' };
    expect(getErrorMessage(err)).toBe('原始消息');
  });

  it('未知错误码且无 message 时返回 UNKNOWN 映射消息', () => {
    const err: OperationError = { code: 'NOT_MAPPED', message: '' };
    expect(getErrorMessage(err)).toBe(ErrorMessages[ErrorCodes.UNKNOWN]);
  });
});

describe('result — extractErrorMessage', () => {
  it('Error 实例返回 message', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('字符串原样返回', () => {
    expect(extractErrorMessage('raw')).toBe('raw');
  });

  it('带 message 字段的对象返回其 message', () => {
    expect(extractErrorMessage({ message: 'from-obj' })).toBe('from-obj');
  });

  it('message 字段为数字时字符串化', () => {
    expect(extractErrorMessage({ message: 42 })).toBe('42');
  });

  it('null / undefined 返回字符串化结果', () => {
    expect(extractErrorMessage(null)).toBe('null');
    expect(extractErrorMessage(undefined)).toBe('undefined');
  });

  it('任意对象回退到 String()', () => {
    expect(extractErrorMessage({ foo: 1 })).toBe('[object Object]');
  });
});

describe('result — humanizeErrorMessage', () => {
  it('空消息返回通用提示', () => {
    expect(humanizeErrorMessage('')).toBe('操作失败，请稍后重试');
  });

  it('匹配网络错误模式返回友好消息', () => {
    expect(humanizeErrorMessage('Failed to fetch')).toContain('网络');
    expect(humanizeErrorMessage('fetch failed')).toContain('网络');
    expect(humanizeErrorMessage('ETIMEDOUT')).toContain('超时');
    expect(humanizeErrorMessage('ECONNREFUSED')).toContain('服务器');
  });

  it('匹配鉴权/权限错误返回友好消息', () => {
    expect(humanizeErrorMessage('Unauthorized 401')).toContain('登录');
    expect(humanizeErrorMessage('Forbidden 403')).toContain('权限');
  });

  it('匹配限流/速率错误', () => {
    expect(humanizeErrorMessage('rate limit exceeded')).toContain('频繁');
    expect(humanizeErrorMessage('Too many requests')).toContain('频繁');
  });

  it('TypeError 前缀会被剥离后再匹配', () => {
    expect(humanizeErrorMessage('TypeError: Failed to fetch')).toContain('网络');
  });

  it('看起来是技术堆栈的消息返回通用提示', () => {
    // 形如 "SyntaxError: unexpected token" 的匹配
    expect(humanizeErrorMessage('SyntaxError: unexpected token')).toBe('操作失败，请稍后重试');
  });

  it('已经友好的中文消息保持不变', () => {
    expect(humanizeErrorMessage('密码长度至少8位')).toBe('密码长度至少8位');
  });
});

describe('result — ErrorMessages 完整性', () => {
  it('每个 ErrorCode 都有对应的映射消息', () => {
    for (const code of Object.values(ErrorCodes)) {
      expect(ErrorMessages[code]).toBeDefined();
      expect(ErrorMessages[code].length).toBeGreaterThan(0);
    }
  });
});
