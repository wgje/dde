/**
 * SearchService 单元测试（Injector 隔离，依赖 happy-dom 的 document）
 *
 * 覆盖重点：
 * - normalizeSearchQuery（保留连字符以支持 shortId）
 * - fuzzyMatch（包含 + 字符序列）
 * - searchResults computed（当前项目 + 跨项目停泊任务去重）
 * - filteredProjects computed
 * - searchTasks / searchProjects 手动调用
 * - highlightMatch XSS escape
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { SearchService } from './search.service';
import { ProjectStateService } from './project-state.service';
import { UiStateService } from './ui-state.service';
import { TaskStore } from '../app/core/state/stores';
import type { Project, Task } from '../models';

// escapeHtml 使用 document.createElement — 需要 happy-dom
beforeAll(() => {
  if (typeof document === 'undefined') {
    throw new Error('SearchService.highlightMatch 需要 DOM 环境');
  }
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 't1',
    title: 'Hello World',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-01-01T00:00:00Z',
    displayId: '1',
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'p1',
    name: 'Project',
    description: '',
    createdDate: '2026-01-01T00:00:00Z',
    tasks: [],
    connections: [],
    ...overrides,
  };
}

describe('SearchService', () => {
  let service: SearchService;
  let searchQuery: ReturnType<typeof signal<string>>;
  let projectSearchQuery: ReturnType<typeof signal<string>>;
  let tasks: ReturnType<typeof signal<Task[]>>;
  let projects: ReturnType<typeof signal<Project[]>>;
  let parkedTaskIds: ReturnType<typeof signal<Set<string>>>;
  let tasksMap: ReturnType<typeof signal<Map<string, Task>>>;

  beforeEach(() => {
    searchQuery = signal<string>('');
    projectSearchQuery = signal<string>('');
    tasks = signal<Task[]>([]);
    projects = signal<Project[]>([]);
    parkedTaskIds = signal<Set<string>>(new Set());
    tasksMap = signal<Map<string, Task>>(new Map());

    const injector = Injector.create({
      providers: [
        {
          provide: UiStateService,
          useValue: { searchQuery, projectSearchQuery },
        },
        {
          provide: ProjectStateService,
          useValue: { tasks, projects },
        },
        {
          provide: TaskStore,
          useValue: { parkedTaskIds, tasksMap },
        },
      ],
    });

    service = runInInjectionContext(injector, () => new SearchService());
  });

  // ==========================================================================
  // searchResults computed — 当前项目
  // ==========================================================================

  describe('searchResults — 当前项目任务', () => {
    it('查询为空时返回空数组', () => {
      tasks.set([makeTask()]);
      searchQuery.set('');
      expect(service.searchResults()).toEqual([]);
    });

    it('按标题匹配', () => {
      tasks.set([
        makeTask({ id: 't1', title: 'Buy milk' }),
        makeTask({ id: 't2', title: 'Write code' }),
      ]);
      searchQuery.set('milk');
      const r = service.searchResults();
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('t1');
    });

    it('按 content 匹配', () => {
      tasks.set([makeTask({ id: 't1', content: 'some PR description' })]);
      searchQuery.set('description');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('按 displayId 匹配', () => {
      tasks.set([makeTask({ id: 't1', displayId: '42', title: 'x' })]);
      searchQuery.set('42');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('按 shortId 匹配（连字符必须保留）', () => {
      tasks.set([makeTask({ id: 't1', shortId: 'NF-A1B2', title: 'x' })]);
      searchQuery.set('nf-a1b2');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('按 tags 匹配', () => {
      tasks.set([makeTask({ id: 't1', title: 'x', tags: ['urgent', 'backend'] })]);
      searchQuery.set('backend');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('按 attachment.name 匹配', () => {
      tasks.set([
        makeTask({
          id: 't1',
          title: 'x',
          attachments: [
            {
              id: 'a1',
              type: 'image',
              name: 'blueprint.png',
              url: 'https://example.com/a',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      ]);
      searchQuery.set('blueprint');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('deletedAt 任务被过滤', () => {
      tasks.set([makeTask({ id: 't1', title: 'trash', deletedAt: '2026-01-02' })]);
      searchQuery.set('trash');
      expect(service.searchResults()).toEqual([]);
    });

    it('结果项带有 _isParked=false 标识（非停泊）', () => {
      tasks.set([makeTask({ id: 't1', title: 'hi' })]);
      searchQuery.set('hi');
      const r = service.searchResults() as Array<Task & { _isParked: boolean }>;
      expect(r[0]._isParked).toBe(false);
    });
  });

  // ==========================================================================
  // searchResults computed — 跨项目停泊任务（A3.10）
  // ==========================================================================

  describe('searchResults — 跨项目停泊任务', () => {
    it('当前项目结果在前、跨项目停泊结果在后', () => {
      const curTask = makeTask({ id: 't1', title: 'current hello' });
      const parkedTask = makeTask({ id: 't2', title: 'parked hello' });
      tasks.set([curTask]);
      parkedTaskIds.set(new Set(['t2']));
      tasksMap.set(new Map([['t2', parkedTask]]));
      searchQuery.set('hello');

      const r = service.searchResults() as Array<Task & { _isParked: boolean }>;
      expect(r.map((t) => t.id)).toEqual(['t1', 't2']);
      expect(r[0]._isParked).toBe(false);
      expect(r[1]._isParked).toBe(true);
    });

    it('已在当前项目的停泊任务不重复', () => {
      const task = makeTask({ id: 't1', title: 'hello' });
      tasks.set([task]);
      parkedTaskIds.set(new Set(['t1']));
      tasksMap.set(new Map([['t1', task]]));
      searchQuery.set('hello');

      const r = service.searchResults();
      expect(r).toHaveLength(1);
      // 在当前项目结果中应标记 _isParked=true
      expect((r[0] as Task & { _isParked: boolean })._isParked).toBe(true);
    });

    it('停泊任务 deletedAt 时被过滤', () => {
      const parked = makeTask({ id: 't2', title: 'parked trash', deletedAt: '2026-01-02' });
      tasks.set([]);
      parkedTaskIds.set(new Set(['t2']));
      tasksMap.set(new Map([['t2', parked]]));
      searchQuery.set('trash');
      expect(service.searchResults()).toEqual([]);
    });

    it('tasksMap 缺少停泊任务时安全跳过', () => {
      tasks.set([]);
      parkedTaskIds.set(new Set(['orphan']));
      tasksMap.set(new Map());
      searchQuery.set('x');
      expect(service.searchResults()).toEqual([]);
    });
  });

  // ==========================================================================
  // filteredProjects
  // ==========================================================================

  describe('filteredProjects', () => {
    it('无查询时返回全部', () => {
      const all = [makeProject({ id: 'p1' }), makeProject({ id: 'p2', name: 'Other' })];
      projects.set(all);
      projectSearchQuery.set('');
      expect(service.filteredProjects()).toEqual(all);
    });

    it('按名称匹配', () => {
      projects.set([
        makeProject({ id: 'p1', name: 'Alpha project' }),
        makeProject({ id: 'p2', name: 'Beta' }),
      ]);
      projectSearchQuery.set('alpha');
      const r = service.filteredProjects();
      expect(r).toHaveLength(1);
      expect(r[0].id).toBe('p1');
    });

    it('按 description 匹配', () => {
      projects.set([
        makeProject({ id: 'p1', name: 'P1', description: 'internal tool' }),
        makeProject({ id: 'p2', name: 'P2', description: 'external api' }),
      ]);
      projectSearchQuery.set('internal');
      const r = service.filteredProjects();
      expect(r.map((p) => p.id)).toEqual(['p1']);
    });
  });

  // ==========================================================================
  // searchTasks / searchProjects 手动调用
  // ==========================================================================

  describe('searchTasks (manual)', () => {
    it('使用传入的 tasks 参数，不依赖 state', () => {
      const custom: Task[] = [
        makeTask({ id: 't1', title: 'A' }),
        makeTask({ id: 't2', title: 'B' }),
      ];
      const r = service.searchTasks('A', custom);
      expect(r.map((t) => t.id)).toEqual(['t1']);
    });

    it('空查询返回空数组', () => {
      expect(service.searchTasks('', [makeTask()])).toEqual([]);
    });

    it('不带 tasks 参数时使用 projectState.tasks', () => {
      tasks.set([makeTask({ id: 't1', title: 'searchable' })]);
      const r = service.searchTasks('searchable');
      expect(r).toHaveLength(1);
    });
  });

  describe('searchProjects (manual)', () => {
    it('空查询返回全部项目（包括默认列表）', () => {
      const list = [makeProject({ id: 'p1' })];
      projects.set(list);
      expect(service.searchProjects('')).toEqual(list);
    });

    it('按名称匹配过滤', () => {
      const list = [
        makeProject({ id: 'p1', name: 'Alpha' }),
        makeProject({ id: 'p2', name: 'Beta' }),
      ];
      expect(service.searchProjects('alpha', list).map((p) => p.id)).toEqual(['p1']);
    });
  });

  // ==========================================================================
  // searchResultCount / hasSearchResults
  // ==========================================================================

  describe('辅助 computed', () => {
    it('searchResultCount 与 hasSearchResults', () => {
      tasks.set([makeTask({ id: 't1', title: 'find me' })]);
      searchQuery.set('find');
      expect(service.searchResultCount()).toBe(1);
      expect(service.hasSearchResults()).toBe(true);
    });

    it('无匹配时 hasSearchResults=false', () => {
      tasks.set([makeTask({ id: 't1', title: 'nothing' })]);
      searchQuery.set('zzz');
      // 'zzz' 不在 'nothing' 中，且字符序列 z-z-z 无法在 'nothing' 中找到
      expect(service.hasSearchResults()).toBe(false);
      expect(service.searchResultCount()).toBe(0);
    });
  });

  // ==========================================================================
  // highlightMatch — XSS 防护
  // ==========================================================================

  describe('highlightMatch (XSS escape)', () => {
    it('正常匹配插入 <mark> 标签', () => {
      const html = service.highlightMatch('Hello World', 'world');
      expect(html).toContain('<mark class="search-highlight">');
      expect(html).toContain('World');
    });

    it('原文中的 <script> 被 HTML 转义，防止注入', () => {
      const html = service.highlightMatch('<script>alert(1)</script>hello', 'hello');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('<mark class="search-highlight">hello</mark>');
    });

    it('匹配文本本身含 HTML 也会被转义', () => {
      // query 经 normalize 后为 'img'（标点被去除），匹配原文 '<img'
      const html = service.highlightMatch('pre <img onerror=x> post', 'img');
      expect(html).toContain('&lt;');
      expect(html).toContain('<mark class="search-highlight">img</mark>');
      // 原始未转义的 <img 不应出现在最终 HTML 中
      expect(html).not.toMatch(/<img\s/);
    });

    it('空查询返回原文本', () => {
      expect(service.highlightMatch('Hello', '')).toBe('Hello');
    });

    it('无匹配返回原文本', () => {
      expect(service.highlightMatch('Hello', 'zzz')).toBe('Hello');
    });

    it('空文本返回空', () => {
      expect(service.highlightMatch('', 'x')).toBe('');
    });
  });

  // ==========================================================================
  // 模糊匹配（fuzzyMatch 通过 searchResults 间接验证）
  // ==========================================================================

  describe('fuzzyMatch 字符序列匹配', () => {
    it('"abc" 匹配 "axbycz"（字符序列，非连续）', () => {
      tasks.set([makeTask({ id: 't1', title: 'axbycz' })]);
      searchQuery.set('abc');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('包含匹配（连续子串）也命中', () => {
      tasks.set([makeTask({ id: 't1', title: 'xxxabcxxx' })]);
      searchQuery.set('abc');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('字符序列顺序不对时不命中', () => {
      tasks.set([makeTask({ id: 't1', title: 'cba' })]);
      searchQuery.set('abc');
      expect(service.searchResults()).toEqual([]);
    });
  });

  // ==========================================================================
  // normalizeSearchQuery — 边界
  // ==========================================================================

  describe('normalizeSearchQuery', () => {
    it('保留连字符（用于 shortId 搜索）', () => {
      tasks.set([makeTask({ id: 't1', shortId: 'NF-A1B2', title: 'x' })]);
      // 大写 + 标点围绕的 shortId 仍可命中
      searchQuery.set('  .NF-A1B2,  ');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('标点（逗号/句号/感叹号等）被去除', () => {
      tasks.set([makeTask({ id: 't1', title: 'hello world' })]);
      searchQuery.set('hello!!!');
      expect(service.searchResults()).toHaveLength(1);
    });

    it('多空格归一', () => {
      tasks.set([makeTask({ id: 't1', title: 'hello world' })]);
      searchQuery.set('   hello    ');
      expect(service.searchResults()).toHaveLength(1);
    });
  });
});
