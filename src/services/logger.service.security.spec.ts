/**
 * LoggerService 安全测试
 * 验证敏感数据清洗功能
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoggerService, LogLevel } from './logger.service';

describe('LoggerService Security', () => {
  let logger: LoggerService;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger = new LoggerService();
    // 设置为 DEBUG 级别以捕获所有日志
    logger.setLevel(LogLevel.DEBUG);
    // 监听 console.debug
    consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('Sensitive Field Redaction', () => {
    it('should redact password fields', () => {
      logger.debug('test', 'Login attempt', { 
        email: 'user@example.com', 
        password: 'secret123' 
      });

      expect(consoleSpy).toHaveBeenCalled();
      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.password).toBe('[REDACTED]');
      expect(loggedData.email).toBe('user@example.com');
    });

    it('should redact token fields', () => {
      logger.debug('test', 'Auth data', { 
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        userId: '123'
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.token).toBe('[REDACTED]');
      expect(loggedData.userId).toBe('123');
    });

    it('should redact access_token fields', () => {
      logger.debug('test', 'Session', { 
        access_token: 'eyJxxx',
        refresh_token: 'eyJyyy',
        expires_in: 3600
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.access_token).toBe('[REDACTED]');
      expect(loggedData.refresh_token).toBe('[REDACTED]');
      expect(loggedData.expires_in).toBe(3600);
    });

    it('should redact apiKey fields', () => {
      logger.debug('test', 'Config', { 
        apiKey: 'sk-xxxxxxxxxxxxx',
        endpoint: 'https://api.example.com'
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.apiKey).toBe('[REDACTED]');
      expect(loggedData.endpoint).toBe('https://api.example.com');
    });

    it('should redact secret fields', () => {
      logger.debug('test', 'Secrets', { 
        secret: 'my-secret-value',
        public: 'public-value'
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.secret).toBe('[REDACTED]');
      expect(loggedData.public).toBe('public-value');
    });

    it('should redact authorization headers', () => {
      logger.debug('test', 'Request', { 
        headers: {
          authorization: 'Bearer eyJtoken...',
          'content-type': 'application/json'
        }
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      const headers = loggedData.headers as Record<string, unknown>;
      expect(headers.authorization).toBe('[REDACTED]');
      expect(headers['content-type']).toBe('application/json');
    });
  });

  describe('JWT Token Detection', () => {
    it('should detect and redact JWT tokens in string values', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      logger.debug('test', 'Data', { 
        someField: jwt,
        normalField: 'normal value'
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.someField).toBe('[JWT_REDACTED]');
      expect(loggedData.normalField).toBe('normal value');
    });

    it('should not redact short strings starting with eyJ', () => {
      logger.debug('test', 'Data', { 
        shortValue: 'eyJabc' // 太短，不是 JWT
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      expect(loggedData.shortValue).toBe('eyJabc');
    });
  });

  describe('Nested Object Handling', () => {
    it('should redact sensitive fields in nested objects', () => {
      logger.debug('test', 'Nested', { 
        user: {
          email: 'user@example.com',
          profile: {
            password: 'secret',
            apiKey: 'key123'
          }
        }
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      const user = loggedData.user as Record<string, unknown>;
      const profile = user.profile as Record<string, unknown>;
      expect(user.email).toBe('user@example.com');
      expect(profile.password).toBe('[REDACTED]');
      expect(profile.apiKey).toBe('[REDACTED]');
    });

    it('should redact entire object when field name is sensitive', () => {
      logger.debug('test', 'Sensitive container', { 
        credentials: { username: 'admin', password: 'secret' }
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      // 整个 credentials 对象被替换，因为字段名本身是敏感的
      expect(loggedData.credentials).toBe('[REDACTED]');
    });

    it('should handle arrays with sensitive data', () => {
      logger.debug('test', 'Array', { 
        users: [
          { name: 'Alice', password: 'pass1' },
          { name: 'Bob', password: 'pass2' }
        ]
      });

      const loggedData = consoleSpy.mock.calls[0][2] as Record<string, unknown>;
      const users = loggedData.users as Array<Record<string, unknown>>;
      expect(users[0].name).toBe('Alice');
      expect(users[0].password).toBe('[REDACTED]');
      expect(users[1].password).toBe('[REDACTED]');
    });

    it('should handle max depth to prevent infinite recursion', () => {
      const deepObject: Record<string, unknown> = { level: 0 };
      let current = deepObject;
      for (let i = 1; i <= 10; i++) {
        current.nested = { level: i, password: 'secret' };
        current = current.nested as Record<string, unknown>;
      }

      // 不应该抛出错误
      expect(() => {
        logger.debug('test', 'Deep', deepObject);
      }).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle null data', () => {
      expect(() => {
        logger.debug('test', 'Null data', null);
      }).not.toThrow();
    });

    it('should handle undefined data', () => {
      expect(() => {
        logger.debug('test', 'No data');
      }).not.toThrow();
    });

    it('should handle primitive data types', () => {
      logger.debug('test', 'Number', 42);
      expect(consoleSpy.mock.calls[0][2]).toBe(42);

      logger.debug('test', 'String', 'hello');
      expect(consoleSpy.mock.calls[1][2]).toBe('hello');

      logger.debug('test', 'Boolean', true);
      expect(consoleSpy.mock.calls[2][2]).toBe(true);
    });

    it('should handle circular references gracefully via depth limit', () => {
      const obj: Record<string, unknown> = { name: 'test' };
      obj.self = obj; // 循环引用

      // 由于深度限制，不会无限递归
      expect(() => {
        logger.debug('test', 'Circular', obj);
      }).not.toThrow();
    });
  });
});
