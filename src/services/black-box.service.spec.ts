/**
 * BlackBox 服务单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { BlackBoxService } from './black-box.service';
import { BlackBoxSyncService } from './black-box-sync.service';
import { AuthService } from './auth.service';
import { ProjectStateService } from './project-state.service';
import { 
  setBlackBoxEntries 
} from '../state/focus-stores';

describe('BlackBoxService', () => {
  let service: BlackBoxService;
  let mockSyncService: {
    scheduleSync: ReturnType<typeof vi.fn>;
    pullChanges: ReturnType<typeof vi.fn>;
  };
  let mockAuthService: {
    currentUserId: ReturnType<typeof vi.fn>;
  };
  let mockProjectStateService: {
    activeProjectId: ReturnType<typeof signal>;
  };

  beforeEach(() => {
    // 重置状态
    setBlackBoxEntries([]);

    mockSyncService = {
      scheduleSync: vi.fn(),
      pullChanges: vi.fn().mockResolvedValue(undefined)
    };

    mockAuthService = {
      currentUserId: vi.fn().mockReturnValue('test-user')
    };

    mockProjectStateService = {
      activeProjectId: signal('test-project')
    };

    TestBed.configureTestingModule({
      providers: [
        BlackBoxService,
        { provide: BlackBoxSyncService, useValue: mockSyncService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: ProjectStateService, useValue: mockProjectStateService }
      ]
    });

    service = TestBed.inject(BlackBoxService);
  });

  describe('create', () => {
    it('应该创建新条目', () => {
      const result = service.create({ content: '测试内容' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('测试内容');
        expect(result.value.userId).toBe('test-user');
      }
    });

    it('无用户时应该返回错误', () => {
      mockAuthService.currentUserId.mockReturnValue(null);

      const result = service.create({ content: '测试内容' });

      expect(result.ok).toBe(false);
    });

    it('应该调用同步服务', () => {
      service.create({ content: '测试内容' });

      expect(mockSyncService.scheduleSync).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('应该更新已有条目', () => {
      const createResult = service.create({ content: '原始内容' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.update(createResult.value.id, { content: '更新内容' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe('更新内容');
      }
    });

    it('条目不存在时应该返回错误', () => {
      const result = service.update('non-existent-id', { content: '更新' });

      expect(result.ok).toBe(false);
    });
  });

  describe('markAsRead', () => {
    it('应该标记条目为已读', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.markAsRead(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isRead).toBe(true);
      }
    });
  });

  describe('markAsCompleted', () => {
    it('应该标记条目为完成', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.markAsCompleted(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCompleted).toBe(true);
      }
    });
  });

  describe('delete', () => {
    it('应该软删除条目', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const result = service.delete(createResult.value.id);

      expect(result.ok).toBe(true);
    });

    it('条目不存在时应该返回错误', () => {
      const result = service.delete('non-existent-id');

      expect(result.ok).toBe(false);
    });
  });

  describe('getEntry', () => {
    it('应该返回指定条目', () => {
      const createResult = service.create({ content: '测试' });
      if (!createResult.ok) throw new Error('Create failed');

      const entry = service.getEntry(createResult.value.id);

      expect(entry).toBeDefined();
      expect(entry?.content).toBe('测试');
    });

    it('不存在时应该返回 undefined', () => {
      const entry = service.getEntry('non-existent-id');

      expect(entry).toBeUndefined();
    });
  });
});
