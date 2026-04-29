/**
 * 数据完整性测试
 * 
 * 【数据安全 - 最深度验证】
 * 
 * 职责：
 * - 验证导出/导入的完整往返（roundtrip）
 * - 确保所有字段都不会丢失
 * - 验证回收站数据的正确处理
 * - 验证附件元数据完整性
 * 
 * 设计理念：
 * - 每个数据模型字段都必须有对应的测试
 * - 测试数据使用完整的真实数据结构
 * - 导入后的数据应与原始数据在业务上完全一致
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ExportService, ExportData, ExportProject, ExportTask, ExportConnection, ExportAttachment } from '../../services/export.service';
import { ImportService } from '../../services/import.service';
import { LoggerService } from '../../services/logger.service';
import { ToastService } from '../../services/toast.service';
import { PreferenceService } from '../../services/preference.service';
import { LayoutService } from '../../services/layout.service';
import { ExternalSourceLinkService } from '../../app/core/external-sources/external-source-link.service';
import { Project, Task, Connection, Attachment, TaskStatus, AttachmentType } from '../../models';

describe('数据完整性验证', () => {
  let exportService: ExportService;
  let importService: ImportService;
  
  const mockLogger = {
    category: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
  
  const mockToast = {
    show: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  };
  
  const mockPreference = {
    set: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(null),
    lastBackupProofAt: vi.fn(() => null),
    recordBackupProof: vi.fn().mockResolvedValue(true),
  };

  const mockLayoutService = {
    validateAndFixTree: vi.fn((project: Project) => ({ project, issues: [] })),
  };

  const mockExternalSourceLinks = {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    activeLinksForTask: vi.fn(() => []),
    importPointers: vi.fn().mockResolvedValue(undefined),
  };
  
  beforeEach(() => {
    vi.clearAllMocks();
    
    TestBed.configureTestingModule({
      providers: [
        ExportService,
        ImportService,
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: PreferenceService, useValue: mockPreference },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: ExternalSourceLinkService, useValue: mockExternalSourceLinks },
      ],
    });
    
    exportService = TestBed.inject(ExportService);
    importService = TestBed.inject(ImportService);
  });
  
  // ============================================
  // 辅助函数：创建完整测试数据
  // ============================================
  
  /**
   * 创建包含所有字段的完整附件
   */
  function createCompleteAttachment(id: string): Attachment {
    return {
      id,
      type: 'image' as AttachmentType,
      name: `attachment-${id}.png`,
      url: `https://storage.example.com/${id}`,
      thumbnailUrl: `https://storage.example.com/${id}/thumb`,
      mimeType: 'image/png',
      size: 1024 * 100, // 100KB
      createdAt: '2024-01-15T10:30:00.000Z',
      signedAt: '2024-01-15T10:30:00.000Z', // 不应导出
    };
  }
  
  /**
   * 创建包含所有字段的完整任务
   */
  function createCompleteTask(id: string, overrides: Partial<Task> = {}): Task {
    return {
      id,
      title: `Task ${id}`,
      content: `# Markdown Content for ${id}\n\nThis is **bold** and *italic*.`,
      stage: 1,
      parentId: null,
      order: 0,
      rank: 10000,
      status: 'active' as TaskStatus,
      x: 150.5,
      y: 250.75,
      createdDate: '2024-01-10T08:00:00.000Z',
      updatedAt: '2024-01-15T14:30:00.000Z',
      displayId: '1',
      shortId: 'NF-A1B2',
      hasIncompleteTask: true,
      deletedAt: null,
      tags: ['important', 'urgent'],
      priority: 'high',
      dueDate: '2024-02-01T00:00:00.000Z',
      attachments: [createCompleteAttachment(`att-${id}-1`)],
      // 客户端临时字段（不应导出）
      deletedConnections: [],
      deletedMeta: undefined,
      ...overrides,
    };
  }
  
  /**
   * 创建包含所有字段的完整连接
   */
  function createCompleteConnection(id: string, source: string, target: string): Connection {
    return {
      id,
      source,
      target,
      title: `Connection ${id} Title`,
      description: `Detailed description for connection ${id}`,
      deletedAt: null,
    };
  }
  
  /**
   * 创建包含所有字段的完整项目
   */
  function createCompleteProject(): Project {
    const task1 = createCompleteTask('task-1');
    const task2 = createCompleteTask('task-2', {
      parentId: 'task-1',
      displayId: '1,a',
      stage: 2,
    });
    const task3 = createCompleteTask('task-3', {
      deletedAt: '2024-01-14T00:00:00.000Z', // 回收站任务
    });
    
    const conn1 = createCompleteConnection('conn-1', 'task-1', 'task-2');
    const conn2 = createCompleteConnection('conn-2', 'task-2', 'task-3');
    conn2.deletedAt = '2024-01-14T00:00:00.000Z'; // 回收站连接
    
    return {
      id: 'project-complete',
      name: 'Complete Test Project',
      description: 'A project with all fields populated for integrity testing',
      createdDate: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-15T18:00:00.000Z',
      version: 5,
      tasks: [task1, task2, task3],
      connections: [conn1, conn2],
      viewState: {
        scale: 1.5,
        positionX: 100,
        positionY: 200,
      },
      flowchartUrl: 'https://storage.example.com/flowchart.png',
      flowchartThumbnailUrl: 'https://storage.example.com/flowchart-thumb.png',
    };
  }
  
  // ============================================
  // Task 字段完整性测试
  // ============================================
  
  describe('Task 字段完整性', () => {
    it('应导出所有 Task 核心字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      expect(result.success).toBe(true);
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedTask = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      
      // 核心字段验证
      expect(exportedTask.id).toBe('task-1');
      expect(exportedTask.title).toBe('Task task-1');
      expect(exportedTask.content).toContain('# Markdown Content');
      expect(exportedTask.stage).toBe(1);
      expect(exportedTask.parentId).toBeNull();
      expect(exportedTask.order).toBe(0);
      expect(exportedTask.rank).toBe(10000);
      expect(exportedTask.status).toBe('active');
      expect(exportedTask.x).toBe(150.5);
      expect(exportedTask.y).toBe(250.75);
      expect(exportedTask.displayId).toBe('1');
    });
    
    it('应导出 Task 可选字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedTask = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      
      // 可选字段验证
      expect(exportedTask.shortId).toBe('NF-A1B2');
      expect(exportedTask.createdAt).toBe('2024-01-10T08:00:00.000Z');
      expect(exportedTask.updatedAt).toBe('2024-01-15T14:30:00.000Z');
      expect(exportedTask.hasIncompleteTask).toBe(true);
    });
    
    it('应导出 Task 扩展字段（tags/priority/dueDate）', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedTask = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      
      // 扩展字段验证
      expect(exportedTask.tags).toEqual(['important', 'urgent']);
      expect(exportedTask.priority).toBe('high');
      expect(exportedTask.dueDate).toBe('2024-02-01T00:00:00.000Z');
    });
    
    it('应导出回收站任务（含 deletedAt）', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const deletedTask = data.projects[0].tasks.find(t => t.id === 'task-3');
      
      expect(deletedTask).toBeDefined();
      expect(deletedTask!.deletedAt).toBe('2024-01-14T00:00:00.000Z');
    });
    
    it('不应导出客户端临时字段（deletedConnections/deletedMeta）', async () => {
      const project = createCompleteProject();
      // 添加临时字段
      project.tasks[0].deletedConnections = [createCompleteConnection('temp', 'a', 'b')];
      project.tasks[0].deletedMeta = {
        parentId: 'old-parent',
        stage: 0,
        order: 1,
        rank: 5000,
        x: 0,
        y: 0,
      };
      
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedTask = data.projects[0].tasks[0];
      
      // 临时字段不应存在
      expect('deletedConnections' in exportedTask).toBe(false);
      expect('deletedMeta' in exportedTask).toBe(false);
    });
  });
  
  // ============================================
  // Connection 字段完整性测试
  // ============================================
  
  describe('Connection 字段完整性', () => {
    it('应导出所有 Connection 字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedConn = data.projects[0].connections.find(c => c.id === 'conn-1')!;
      
      expect(exportedConn.id).toBe('conn-1');
      expect(exportedConn.source).toBe('task-1');
      expect(exportedConn.target).toBe('task-2');
      expect(exportedConn.title).toBe('Connection conn-1 Title');
      expect(exportedConn.description).toContain('Detailed description');
    });
    
    it('应导出回收站连接（含 deletedAt）', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const deletedConn = data.projects[0].connections.find(c => c.id === 'conn-2');
      
      expect(deletedConn).toBeDefined();
      expect(deletedConn!.deletedAt).toBe('2024-01-14T00:00:00.000Z');
    });
  });
  
  // ============================================
  // Project 字段完整性测试
  // ============================================
  
  describe('Project 字段完整性', () => {
    it('应导出所有 Project 核心字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedProject = data.projects[0];
      
      expect(exportedProject.id).toBe('project-complete');
      expect(exportedProject.name).toBe('Complete Test Project');
      expect(exportedProject.description).toContain('all fields populated');
      expect(exportedProject.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(exportedProject.updatedAt).toBe('2024-01-15T18:00:00.000Z');
    });
    
    it('应导出 Project 可选字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedProject = data.projects[0];
      
      expect(exportedProject.version).toBe(5);
      expect(exportedProject.flowchartUrl).toBe('https://storage.example.com/flowchart.png');
      expect(exportedProject.flowchartThumbnailUrl).toBe('https://storage.example.com/flowchart-thumb.png');
    });
    
    it('应导出 viewState 字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const exportedProject = data.projects[0];
      
      expect(exportedProject.viewState).toEqual({
        scale: 1.5,
        positionX: 100,
        positionY: 200,
      });
    });
  });
  
  // ============================================
  // Attachment 字段完整性测试
  // ============================================
  
  describe('Attachment 字段完整性', () => {
    it('应导出附件核心字段', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const task = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      const attachment = task.attachments![0];
      
      expect(attachment.id).toBe('att-task-1-1');
      expect(attachment.name).toBe('attachment-att-task-1-1.png');
      expect(attachment.size).toBe(1024 * 100);
      expect(attachment.mimeType).toBe('image/png');
      expect(attachment.url).toContain('storage.example.com');
      expect(attachment.createdAt).toBe('2024-01-15T10:30:00.000Z');
    });
    
    it('应导出附件类型和缩略图', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const task = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      const attachment = task.attachments![0];
      
      expect(attachment.type).toBe('image');
      expect(attachment.thumbnailUrl).toContain('thumb');
    });
    
    it('不应导出临时字段（signedAt）', async () => {
      const project = createCompleteProject();
      const result = await exportService.exportProject(project);
      
      const data: ExportData = JSON.parse(await result.blob!.text());
      const task = data.projects[0].tasks.find(t => t.id === 'task-1')!;
      const attachment = task.attachments![0] as unknown as Record<string, unknown>;
      
      expect('signedAt' in attachment).toBe(false);
    });
  });
  
  // ============================================
  // 导入往返测试（Roundtrip）
  // ============================================
  
  describe('导入往返完整性', () => {
    it('导入后数据应与导出数据业务等价', async () => {
      const originalProject = createCompleteProject();
      
      // 导出
      const exportResult = await exportService.exportProject(originalProject);
      expect(exportResult.success).toBe(true);
      
      // 解析导出数据
      const exportData: ExportData = JSON.parse(await exportResult.blob!.text());
      
      // 导入
      let importedProject: Project | null = null;
      await importService.executeImport(
        exportData,
        [],
        { conflictStrategy: 'skip' },
        async (project) => {
          importedProject = project;
        }
      );
      
      expect(importedProject).not.toBeNull();
      
      // 验证项目级别字段
      expect(importedProject!.id).toBe(originalProject.id);
      expect(importedProject!.name).toBe(originalProject.name);
      expect(importedProject!.description).toBe(originalProject.description);
      expect(importedProject!.viewState).toEqual(originalProject.viewState);
      expect(importedProject!.flowchartUrl).toBe(originalProject.flowchartUrl);
      expect(importedProject!.flowchartThumbnailUrl).toBe(originalProject.flowchartThumbnailUrl);
      expect(importedProject!.version).toBe(originalProject.version);
    });
    
    it('导入后任务数据应保持完整', async () => {
      const originalProject = createCompleteProject();
      const exportResult = await exportService.exportProject(originalProject);
      const exportData: ExportData = JSON.parse(await exportResult.blob!.text());
      
      let importedProject: Project | null = null;
      await importService.executeImport(
        exportData,
        [],
        { conflictStrategy: 'skip' },
        async (project) => {
          importedProject = project;
        }
      );
      
      const originalTask = originalProject.tasks.find(t => t.id === 'task-1')!;
      const importedTask = importedProject!.tasks.find(t => t.id === 'task-1')!;
      
      // 核心字段
      expect(importedTask.title).toBe(originalTask.title);
      expect(importedTask.content).toBe(originalTask.content);
      expect(importedTask.stage).toBe(originalTask.stage);
      expect(importedTask.parentId).toBe(originalTask.parentId);
      expect(importedTask.order).toBe(originalTask.order);
      expect(importedTask.rank).toBe(originalTask.rank);
      expect(importedTask.status).toBe(originalTask.status);
      expect(importedTask.x).toBe(originalTask.x);
      expect(importedTask.y).toBe(originalTask.y);
      expect(importedTask.displayId).toBe(originalTask.displayId);
      
      // 扩展字段
      expect(importedTask.shortId).toBe(originalTask.shortId);
      expect(importedTask.tags).toEqual(originalTask.tags);
      expect(importedTask.priority).toBe(originalTask.priority);
      expect(importedTask.dueDate).toBe(originalTask.dueDate);
      expect(importedTask.hasIncompleteTask).toBe(originalTask.hasIncompleteTask);
    });
    
    it('导入后回收站任务应保持 deletedAt', async () => {
      const originalProject = createCompleteProject();
      const exportResult = await exportService.exportProject(originalProject);
      const exportData: ExportData = JSON.parse(await exportResult.blob!.text());
      
      let importedProject: Project | null = null;
      await importService.executeImport(
        exportData,
        [],
        { conflictStrategy: 'skip' },
        async (project) => {
          importedProject = project;
        }
      );
      
      const deletedTask = importedProject!.tasks.find(t => t.id === 'task-3');
      expect(deletedTask).toBeDefined();
      expect(deletedTask!.deletedAt).toBe('2024-01-14T00:00:00.000Z');
    });
    
    it('导入后连接数据应保持完整', async () => {
      const originalProject = createCompleteProject();
      originalProject.tasks.find(t => t.id === 'task-2')!.parentId = null;
      const exportResult = await exportService.exportProject(originalProject);
      const exportData: ExportData = JSON.parse(await exportResult.blob!.text());
      
      let importedProject: Project | null = null;
      await importService.executeImport(
        exportData,
        [],
        { conflictStrategy: 'skip' },
        async (project) => {
          importedProject = project;
        }
      );
      
      const originalConn = originalProject.connections.find(c => c.id === 'conn-1')!;
      const importedConn = importedProject!.connections.find(c => c.id === 'conn-1')!;
      
      expect(importedConn.source).toBe(originalConn.source);
      expect(importedConn.target).toBe(originalConn.target);
      expect(importedConn.title).toBe(originalConn.title);
      expect(importedConn.description).toBe(originalConn.description);
    });
    
    it('导入后回收站连接应保持 deletedAt', async () => {
      const originalProject = createCompleteProject();
      const exportResult = await exportService.exportProject(originalProject);
      const exportData: ExportData = JSON.parse(await exportResult.blob!.text());
      
      let importedProject: Project | null = null;
      await importService.executeImport(
        exportData,
        [],
        { conflictStrategy: 'skip' },
        async (project) => {
          importedProject = project;
        }
      );
      
      const deletedConn = importedProject!.connections.find(c => c.id === 'conn-2');
      expect(deletedConn).toBeDefined();
      expect(deletedConn!.deletedAt).toBe('2024-01-14T00:00:00.000Z');
    });
  });
  
  // ============================================
  // 字段计数验证
  // ============================================
  
  describe('字段计数验证', () => {
    it('ExportTask 应包含所有必需字段', () => {
      // 这是一个类型级别的测试，确保 ExportTask 定义了所有业务字段
      const requiredFields: (keyof ExportTask)[] = [
        'id', 'title', 'content', 'stage', 'parentId',
        'order', 'rank', 'status', 'x', 'y', 'displayId',
        'shortId', 'createdAt', 'updatedAt', 'attachments',
        'tags', 'priority', 'dueDate', 'hasIncompleteTask', 'deletedAt'
      ];
      
      // 通过编译即验证类型正确
      const mockTask: ExportTask = {
        id: '1',
        title: 'test',
        content: '',
        stage: 0,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: '1',
        shortId: 'NF-1',
        createdAt: '',
        updatedAt: '',
        attachments: [],
        tags: [],
        priority: 'medium',
        dueDate: null,
        hasIncompleteTask: false,
        deletedAt: null,
      };
      
      expect(requiredFields.every(f => f in mockTask)).toBe(true);
    });
    
    it('ExportConnection 应包含所有必需字段', () => {
      const requiredFields: (keyof ExportConnection)[] = [
        'id', 'source', 'target', 'title', 'description', 'deletedAt'
      ];
      
      const mockConn: ExportConnection = {
        id: '1',
        source: 'a',
        target: 'b',
        title: '',
        description: '',
        deletedAt: null,
      };
      
      expect(requiredFields.every(f => f in mockConn)).toBe(true);
    });
    
    it('ExportProject 应包含所有必需字段', () => {
      const requiredFields: (keyof ExportProject)[] = [
        'id', 'name', 'description', 'tasks', 'connections',
        'createdAt', 'updatedAt', 'viewState',
        'flowchartUrl', 'flowchartThumbnailUrl', 'version'
      ];
      
      const mockProject: ExportProject = {
        id: '1',
        name: 'test',
        description: '',
        tasks: [],
        connections: [],
        createdAt: '',
        updatedAt: '',
        viewState: { scale: 1, positionX: 0, positionY: 0 },
        flowchartUrl: '',
        flowchartThumbnailUrl: '',
        version: 1,
      };
      
      expect(requiredFields.every(f => f in mockProject)).toBe(true);
    });
    
    it('ExportAttachment 应包含所有必需字段', () => {
      const requiredFields: (keyof ExportAttachment)[] = [
        'id', 'name', 'size', 'mimeType', 'url', 'createdAt',
        'type', 'thumbnailUrl'
      ];
      
      const mockAtt: ExportAttachment = {
        id: '1',
        name: 'test',
        size: 0,
        mimeType: '',
        url: '',
        createdAt: '',
        type: 'file',
        thumbnailUrl: '',
      };
      
      expect(requiredFields.every(f => f in mockAtt)).toBe(true);
    });
  });
  
  // ============================================
  // 边界情况测试
  // ============================================
  
  describe('边界情况', () => {
    it('应正确处理空项目', async () => {
      const emptyProject: Project = {
        id: 'empty',
        name: 'Empty Project',
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [],
        connections: [],
      };
      
      const result = await exportService.exportProject(emptyProject);
      
      expect(result.success).toBe(true);
      expect(result.metadata?.taskCount).toBe(0);
      expect(result.metadata?.connectionCount).toBe(0);
    });
    
    it('应正确处理空附件列表', async () => {
      const task = createCompleteTask('task-1');
      task.attachments = [];
      
      const project: Project = {
        id: 'p1',
        name: 'Project',
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [task],
        connections: [],
      };
      
      const result = await exportService.exportProject(project);
      const data: ExportData = JSON.parse(await result.blob!.text());
      
      // 空数组不应导出或应为空数组
      expect(
        data.projects[0].tasks[0].attachments === undefined ||
        data.projects[0].tasks[0].attachments?.length === 0
      ).toBe(true);
    });
    
    it('应正确处理 null 值字段', async () => {
      const task = createCompleteTask('task-1', {
        parentId: null,
        stage: null,
        dueDate: null,
        deletedAt: null,
      });
      
      const project: Project = {
        id: 'p1',
        name: 'Project',
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [task],
        connections: [],
      };
      
      const result = await exportService.exportProject(project);
      const data: ExportData = JSON.parse(await result.blob!.text());
      
      expect(data.projects[0].tasks[0].parentId).toBeNull();
      expect(data.projects[0].tasks[0].stage).toBeNull();
      expect(data.projects[0].tasks[0].dueDate).toBeNull();
    });
    
    it('应正确处理特殊字符', async () => {
      const task = createCompleteTask('task-1', {
        title: '任务 "测试" <script>alert(1)</script>',
        content: '内容包含 emoji 🎉 和 unicode ñ ü ö',
      });
      
      const project: Project = {
        id: 'p1',
        name: '项目名称 with "quotes"',
        description: 'Description with\nnewlines\tand\ttabs',
        createdDate: new Date().toISOString(),
        tasks: [task],
        connections: [],
      };
      
      const result = await exportService.exportProject(project);
      const data: ExportData = JSON.parse(await result.blob!.text());
      
      expect(data.projects[0].name).toBe('项目名称 with "quotes"');
      expect(data.projects[0].tasks[0].title).toContain('测试');
      expect(data.projects[0].tasks[0].content).toContain('🎉');
    });
    
    it('应正确处理浮点数坐标', async () => {
      const task = createCompleteTask('task-1', {
        x: 123.456789,
        y: 987.654321,
      });
      
      const project: Project = {
        id: 'p1',
        name: 'Project',
        description: '',
        createdDate: new Date().toISOString(),
        tasks: [task],
        connections: [],
      };
      
      const result = await exportService.exportProject(project);
      const data: ExportData = JSON.parse(await result.blob!.text());
      
      expect(data.projects[0].tasks[0].x).toBeCloseTo(123.456789);
      expect(data.projects[0].tasks[0].y).toBeCloseTo(987.654321);
    });
  });
});
