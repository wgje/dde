import { describe, expect, it } from 'vitest';
import type { Attachment, Project, Task } from '../models';
import { SCAN_STATUS } from '../config/virus-scan.config';
import {
  isValidUUID,
  sanitizeAttachment,
  sanitizeTask,
  validateAttachment,
  validateConnection,
  validateProject,
  validateTask,
} from './validation';
import { createAttachment, createConnection, createTask } from './validation-fixtures.spec-helpers';
import { registerValidationProjectGraphSpecs } from './validation-project-graph.spec-helpers';

// ============================================
// isValidUUID
// ============================================

describe('validation — isValidUUID', () => {
  it('接受标准 v4 UUID', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('接受 crypto.randomUUID() 生成的 UUID', () => {
    expect(isValidUUID(crypto.randomUUID())).toBe(true);
  });

  it('拒绝长度不对的字符串', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('')).toBe(false);
  });

  it('拒绝非法字符（hex 之外）', () => {
    expect(isValidUUID('zzzzzzzz-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('拒绝变体位非法（不是 8/9/a/b）的字符串', () => {
    // variant 位为 'c' 是非法的 RFC4122
    expect(isValidUUID('550e8400-e29b-41d4-c716-446655440000')).toBe(false);
  });
});

// ============================================
// validateAttachment
// ============================================

describe('validation — validateAttachment', () => {
  it('合法附件通过验证', () => {
    const result = validateAttachment(createAttachment());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('缺失 id / name / url / type 时不通过', () => {
    const result = validateAttachment({ name: '', url: '', type: undefined as never, id: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ID'))).toBe(true);
    expect(result.errors.some((e) => e.includes('名称'))).toBe(true);
    expect(result.errors.some((e) => e.includes('URL'))).toBe(true);
    expect(result.errors.some((e) => e.includes('类型'))).toBe(true);
  });

  it('名称过长（>255）报错', () => {
    const result = validateAttachment(createAttachment({ name: 'a'.repeat(256) }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('过长'))).toBe(true);
  });

  it('文件超过 10MB 报错（oversize upload 防护）', () => {
    const result = validateAttachment(createAttachment({ size: 11 * 1024 * 1024 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('过大'))).toBe(true);
  });

  it('size 为负数时报错', () => {
    const result = validateAttachment(createAttachment({ size: -1 }));
    expect(result.valid).toBe(false);
  });

  it('size 刚好等于上限时通过', () => {
    const result = validateAttachment(createAttachment({ size: 10 * 1024 * 1024 }));
    expect(result.valid).toBe(true);
  });

  it('mimeType 与 type 不匹配产生 warning 但不阻断', () => {
    const result = validateAttachment(
      createAttachment({ type: 'image', mimeType: 'application/x-executable' }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('非 http(s) URL 产生 warning', () => {
    const result = validateAttachment(createAttachment({ url: 'not-a-url' }));
    // 未被识别为绝对 URL，但不以 / 或 storage/ 开头 → warning
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('createdAt 缺失产生 warning', () => {
    const result = validateAttachment(createAttachment({ createdAt: undefined }));
    expect(result.warnings.some((w) => w.includes('创建时间'))).toBe(true);
  });
});

// ============================================
// validateTask
// ============================================

describe('validation — validateTask', () => {
  it('合法任务通过', () => {
    const result = validateTask(createTask());
    expect(result.valid).toBe(true);
  });

  it('缺失 id 报错', () => {
    const result = validateTask({ title: 'x' });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ID'))).toBe(true);
  });

  it('title 非字符串报错', () => {
    const result = validateTask(createTask({ title: 123 as unknown as string }));
    expect(result.valid).toBe(false);
  });

  it('rank 非有限数报错', () => {
    const result = validateTask(createTask({ rank: Number.NaN }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rank'))).toBe(true);
  });

  it('rank 负数产生 warning（非 error）', () => {
    const result = validateTask(createTask({ rank: -1 }));
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('负数'))).toBe(true);
  });

  it('stage < 1 报错', () => {
    const result = validateTask(createTask({ stage: 0 }));
    expect(result.valid).toBe(false);
  });

  it('status 非法值报错', () => {
    const result = validateTask(createTask({ status: 'invalid' as Task['status'] }));
    expect(result.valid).toBe(false);
  });

  it('无效的 dueDate 字符串报错', () => {
    const result = validateTask(createTask({ dueDate: 'not-a-date' }));
    expect(result.valid).toBe(false);
  });

  it('合法的 dueDate ISO 字符串通过', () => {
    const result = validateTask(createTask({ dueDate: '2026-12-01T00:00:00.000Z' }));
    expect(result.valid).toBe(true);
  });

  it('expected_minutes 非正数报错', () => {
    expect(validateTask(createTask({ expected_minutes: 0 })).valid).toBe(false);
    expect(validateTask(createTask({ expected_minutes: -10 })).valid).toBe(false);
  });

  it('cognitive_load 非法值报错', () => {
    const result = validateTask(createTask({ cognitive_load: 'medium' as unknown as 'high' }));
    expect(result.valid).toBe(false);
  });

  it('wait_minutes > expected_minutes 时报错', () => {
    const result = validateTask(
      createTask({ expected_minutes: 30, wait_minutes: 60 }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('等待时长不能超过预计时长'))).toBe(true);
  });

  it('priority 非法值报错', () => {
    const result = validateTask(createTask({ priority: 'critical' as Task['priority'] }));
    expect(result.valid).toBe(false);
  });

  it('attachments 非数组报错', () => {
    const result = validateTask(createTask({ attachments: 'nope' as unknown as Attachment[] }));
    expect(result.valid).toBe(false);
  });

  it('tags 中包含非字符串报错', () => {
    const result = validateTask(createTask({ tags: ['ok', '', 42 as unknown as string] }));
    expect(result.valid).toBe(false);
  });
});

// ============================================
// validateConnection
// ============================================

describe('validation — validateConnection', () => {
  const taskIds = new Set(['t1', 't2']);

  it('合法连接通过', () => {
    const result = validateConnection(createConnection({ source: 't1', target: 't2' }), taskIds);
    expect(result.valid).toBe(true);
  });

  it('source 不存在于任务集报错', () => {
    const result = validateConnection(createConnection({ source: 'missing', target: 't2' }), taskIds);
    expect(result.valid).toBe(false);
  });

  it('自环（source === target）报错', () => {
    const result = validateConnection(createConnection({ source: 't1', target: 't1' }), taskIds);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('自身'))).toBe(true);
  });

  it('空 source/target 报错', () => {
    const result = validateConnection(
      createConnection({ source: '', target: '' }),
      taskIds,
    );
    expect(result.valid).toBe(false);
  });
});

// ============================================
// validateProject
// ============================================

describe('validation — validateProject', () => {
  it('合法项目通过', () => {
    const project: Partial<Project> = {
      id: 'p1',
      name: 'P',
      tasks: [createTask({ id: 't1' })],
      connections: [],
    };
    const result = validateProject(project);
    expect(result.valid).toBe(true);
  });

  it('缺 id 报错', () => {
    const result = validateProject({ tasks: [] });
    expect(result.valid).toBe(false);
  });

  it('tasks 重复 id 报错', () => {
    const project: Partial<Project> = {
      id: 'p1',
      name: 'P',
      tasks: [createTask({ id: 't1' }), createTask({ id: 't1' })],
      connections: [],
    };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('重复'))).toBe(true);
  });

  it('task.parentId 指向不存在任务报错', () => {
    const project: Partial<Project> = {
      id: 'p1',
      name: 'P',
      tasks: [createTask({ id: 't1', parentId: 'missing' })],
      connections: [],
    };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
  });

  it('connections 引用缺失任务报错', () => {
    const project: Partial<Project> = {
      id: 'p1',
      name: 'P',
      tasks: [createTask({ id: 't1' })],
      connections: [createConnection({ source: 't1', target: 'missing' })],
    };
    const result = validateProject(project);
    expect(result.valid).toBe(false);
  });

  it('connections 未定义时产生 warning 而非 error', () => {
    const project: Partial<Project> = {
      id: 'p1',
      name: 'P',
      tasks: [],
    };
    const result = validateProject(project);
    // connections === undefined 只是 warning
    expect(result.warnings.some((w) => w.includes('连接列表'))).toBe(true);
  });
});

// ============================================
// sanitizeAttachment — SECURITY SURFACE（XSS URL 过滤）
// ============================================

describe('validation — sanitizeAttachment (URL/XSS 过滤)', () => {
  it('剥离 javascript: URL（XSS 防护）', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'javascript:alert(1)',
    });
    expect(att.url).toBe('');
  });

  it('剥离 data: URL（XSS 防护）', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'data:text/html,<script>alert(1)</script>',
    });
    expect(att.url).toBe('');
  });

  it('剥离 vbscript: URL', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'VBSCRIPT:msgbox(1)',
    });
    expect(att.url).toBe('');
  });

  it('保留合法 https URL', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'https://example.com/photo.png',
    });
    expect(att.url).toBe('https://example.com/photo.png');
  });

  it('保留 blob: URL', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'blob:https://example.com/uuid',
    });
    expect(att.url).toBe('blob:https://example.com/uuid');
  });

  it('保留 storage/ 相对路径', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'storage/attachments/foo.png',
    });
    expect(att.url).toBe('storage/attachments/foo.png');
  });

  it('阻断路径穿越（包含 ..）', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: '/foo/../../etc/passwd',
    });
    expect(att.url).toBe('');
  });

  it('未知类型回退到 file', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'bogus',
      name: 'x',
      url: 'https://example.com/a',
    });
    expect(att.type).toBe('file');
  });

  it('缺少 id 时生成新的 UUID', () => {
    const att = sanitizeAttachment({
      type: 'image',
      name: 'x',
      url: 'https://example.com/a',
    });
    expect(isValidUUID(att.id)).toBe(true);
  });

  it('非字符串 thumbnailUrl → undefined', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'https://example.com/a',
      thumbnailUrl: 123,
    });
    expect(att.thumbnailUrl).toBeUndefined();
  });

  it('恶意 thumbnailUrl 被剥离为空字符串', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'image',
      name: 'x',
      url: 'https://example.com/a',
      thumbnailUrl: 'javascript:alert(1)',
    });
    expect(att.thumbnailUrl).toBe('');
  });

  it('保留软删除、签名时间和有效扫描元数据', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'file',
      name: 'safe.pdf',
      url: 'https://example.com/a.pdf',
      deletedAt: '2026-06-01T00:00:00.000Z',
      signedAt: '2026-06-01T01:00:00.000Z',
      scanMetadata: {
        fileId: 'scan-file-1',
        fileHash: 'a'.repeat(64),
        scanStatus: SCAN_STATUS.CLEAN,
        lastScannedAt: '2026-06-01T00:30:00.000Z',
        scanHistory: [
          {
            scannedAt: '2026-06-01T00:30:00.000Z',
            status: SCAN_STATUS.CLEAN,
            scanner: 'edge-function',
          },
        ],
      },
    });

    expect(att.deletedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(att.signedAt).toBe('2026-06-01T01:00:00.000Z');
    expect(att.scanMetadata).toEqual({
      fileId: 'scan-file-1',
      fileHash: 'a'.repeat(64),
      scanStatus: SCAN_STATUS.CLEAN,
      lastScannedAt: '2026-06-01T00:30:00.000Z',
      scanHistory: [
        {
          scannedAt: '2026-06-01T00:30:00.000Z',
          status: SCAN_STATUS.CLEAN,
          scanner: 'edge-function',
        },
      ],
    });
  });

  it('丢弃无效扫描元数据字段，避免重新引入不可信结构', () => {
    const att = sanitizeAttachment({
      id: 'a',
      type: 'file',
      name: 'safe.pdf',
      url: 'https://example.com/a.pdf',
      scanMetadata: {
        fileId: '',
        fileHash: 42,
        scanStatus: 'unknown',
        lastScannedAt: 123,
        scanHistory: [
          { scannedAt: '2026-06-01T00:00:00.000Z', status: SCAN_STATUS.CLEAN, scanner: 'ok' },
          { scannedAt: '2026-06-01T00:00:00.000Z', status: 'bad', scanner: 'bad' },
        ],
      },
    });

    expect(att.scanMetadata).toEqual({
      scanHistory: [
        {
          scannedAt: '2026-06-01T00:00:00.000Z',
          status: SCAN_STATUS.CLEAN,
          scanner: 'ok',
        },
      ],
    });
  });
});

// ============================================
// sanitizeTask
// ============================================

describe('validation — sanitizeTask', () => {
  it('完全空对象回填所有必填字段', () => {
    const task = sanitizeTask({});
    expect(isValidUUID(task.id)).toBe(true);
    expect(task.title).toBe('未命名任务');
    expect(task.rank).toBe(10000);
    expect(task.status).toBe('active');
    expect(task.x).toBe(0);
    expect(task.y).toBe(0);
  });

  it('非法 status 回退到 active', () => {
    const task = sanitizeTask({ id: 'x', status: 'nope' });
    expect(task.status).toBe('active');
  });

  it('completed / archived 保持原值', () => {
    expect(sanitizeTask({ id: 'x', status: 'completed' }).status).toBe('completed');
    expect(sanitizeTask({ id: 'x', status: 'archived' }).status).toBe('archived');
  });

  it('completed 任务缺少 completedAt 时可从字段上线前的更新时间回填稳定完成时间', () => {
    const task = sanitizeTask({
      id: 'x',
      status: 'completed',
      updatedAt: '2026-04-20T10:00:00.000Z',
      createdDate: '2026-04-19T10:00:00.000Z',
    });

    expect(task.completedAt).toBe('2026-04-20T10:00:00.000Z');
  });

  it('completed 任务缺少 completedAt 时不把字段上线后的同步更新时间固化为完成时间', () => {
    const task = sanitizeTask({
      id: 'x',
      status: 'completed',
      updatedAt: '2026-05-31T09:00:00.000Z',
      createdDate: '2026-05-20T10:00:00.000Z',
    });

    expect(task.completedAt).toBe('2026-05-20T10:00:00.000Z');
  });

  it('非 completed 任务清空 completedAt', () => {
    const task = sanitizeTask({
      id: 'x',
      status: 'active',
      completedAt: '2026-04-20T10:00:00.000Z',
    });

    expect(task.completedAt).toBeNull();
  });

  it('NaN / Infinity 的坐标和 rank 被归零/回退', () => {
    const task = sanitizeTask({
      id: 'x',
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      rank: Number.NaN,
    });
    expect(task.x).toBe(0);
    expect(task.y).toBe(0);
    expect(task.rank).toBe(10000);
  });

  it('attachments 数组被截断到 MAX_ATTACHMENTS_PER_TASK (20)', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `a-${i}`,
      type: 'image',
      name: `f-${i}.png`,
      url: 'https://example.com/a.png',
    }));
    const task = sanitizeTask({ id: 'x', attachments: many });
    expect(task.attachments?.length).toBe(20);
  });

  it('tags 中的非字符串被过滤', () => {
    const task = sanitizeTask({
      id: 'x',
      tags: ['ok', 42, '', 'also-ok'],
    });
    expect(task.tags).toEqual(['ok', 'also-ok']);
  });

  it('非法 priority 字符串被丢弃', () => {
    const task = sanitizeTask({ id: 'x', priority: 'critical' });
    expect(task.priority).toBeUndefined();
  });

  it('显式 null dueDate 被保留为 null', () => {
    const task = sanitizeTask({ id: 'x', dueDate: null });
    expect(task.dueDate).toBeNull();
  });

  it('无法解析的 dueDate 字符串被丢弃', () => {
    const task = sanitizeTask({ id: 'x', dueDate: 'bogus-date' });
    expect(task.dueDate).toBeUndefined();
  });

  it('parkingMeta 非法 state 被丢弃', () => {
    const task = sanitizeTask({
      id: 'x',
      parkingMeta: { state: 'bogus' },
    });
    expect(task.parkingMeta).toBeUndefined();
  });

  it('空 parkingMeta 明确保留为 null', () => {
    const task = sanitizeTask({
      id: 'x',
      parkingMeta: null,
    });
    expect(task.parkingMeta).toBeNull();
  });

  it('合法 parkingMeta.state=parked 被保留', () => {
    const task = sanitizeTask({
      id: 'x',
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-01-01T00:00:00Z',
        pinned: true,
      },
    });
    expect(task.parkingMeta?.state).toBe('parked');
    expect(task.parkingMeta?.pinned).toBe(true);
  });

  it('合法 parkingMeta 嵌套上下文字段被清洗保留', () => {
    const task = sanitizeTask({
      id: 'x',
      parkingMeta: {
        state: 'focused',
        parkedAt: 123,
        lastVisitedAt: '2026-06-01T10:00:00.000Z',
        pinned: 'yes',
        contextSnapshot: {
          savedAt: 12345,
          contentHash: 'hash-1',
          viewMode: 'flow',
          cursorPosition: { line: 2, column: 4 },
          scrollAnchor: {
            anchorType: 'heading',
            anchorIndex: 3,
            anchorOffset: 12,
            scrollPercent: 0.5,
          },
          structuralAnchor: {
            type: 'gojs-node',
            label: 'Node A',
            line: 8,
          },
          flowViewport: {
            scale: 1.25,
            selectedNodeId: 'task-1',
          },
        },
        reminder: {
          reminderAt: '2026-06-02T10:00:00.000Z',
          snoozeCount: 2,
          maxSnoozeCount: 5,
        },
      },
    });

    expect(task.parkingMeta).toEqual({
      state: 'focused',
      parkedAt: null,
      lastVisitedAt: '2026-06-01T10:00:00.000Z',
      pinned: false,
      contextSnapshot: {
        savedAt: '12345',
        contentHash: 'hash-1',
        viewMode: 'flow',
        cursorPosition: { line: 2, column: 4 },
        scrollAnchor: {
          anchorType: 'heading',
          anchorIndex: 3,
          anchorOffset: 12,
          scrollPercent: 0.5,
        },
        structuralAnchor: {
          type: 'gojs-node',
          label: 'Node A',
          line: 8,
        },
        flowViewport: {
          scale: 1.25,
          selectedNodeId: 'task-1',
        },
      },
      reminder: {
        reminderAt: '2026-06-02T10:00:00.000Z',
        snoozeCount: 2,
        maxSnoozeCount: 5,
      },
    });
  });

  it('合法 attentionMeta 被保留并清理无效条目', () => {
    const task = sanitizeTask({
      id: 'x',
      attentionMeta: {
        pinned: true,
        updatedAt: '2026-06-01T10:00:00.000Z',
        items: [
          {
            id: 'att-1',
            text: '  保留这个提醒  ',
            level: 'warning',
            done: false,
            createdAt: '2026-06-01T09:00:00.000Z',
            updatedAt: '2026-06-01T10:00:00.000Z',
          },
          {
            id: 'att-2',
            text: '',
            level: 'blocker',
          },
          {
            id: 'att-3',
            text: '非法等级回退',
            level: 'critical',
            done: 1,
          },
        ],
      },
    });

    expect(task.attentionMeta).toEqual({
      pinned: true,
      updatedAt: '2026-06-01T10:00:00.000Z',
      items: [
        {
          id: 'att-1',
          text: '保留这个提醒',
          level: 'warning',
          done: false,
          createdAt: '2026-06-01T09:00:00.000Z',
          updatedAt: '2026-06-01T10:00:00.000Z',
        },
        {
          id: 'att-3',
          text: '非法等级回退',
          level: 'info',
          done: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  it('空 attentionMeta 明确保留为 null', () => {
    const task = sanitizeTask({
      id: 'x',
      attentionMeta: null,
    });

    expect(task.attentionMeta).toBeNull();
  });
});

registerValidationProjectGraphSpecs({ createTask });
