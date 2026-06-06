/**
 * UserSessionService 的「启动快照预水合投影」纯函数模块。
 *
 * 从 UserSessionService「下切」出的无状态投影助手：把 launch-snapshot / 离线项目
 * 投影成可用于秒开预填充的 Project 列表，并对快照字段做安全消毒。
 *
 * 职责单一、纯函数（无 `this`、无副作用）：
 * - sanitizeSnapshotString：截断过长文本 + 去除 HTML 标签（多一层 XSS 防护）
 * - buildPrehydrateProjects：launch-snapshot 摘要 → 占位 Project（UUID 校验 + 数量上限）
 * - cloneOfflineProjectsForPrehydrate：深拷贝离线项目的 tasks/connections 数组
 * - buildHintScopedPlaceholderProjects：仅暴露非敏感字段的 hint 占位项目
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；UserSessionService 长期越界，
 * 这些纯投影助手自洽且零依赖服务态，最适合先行下切。
 */
import { Project } from '../models';
import type { LaunchSnapshotProject } from '../models/launch-shell';
import { isValidUUID } from '../utils/validation';

/** 清理快照字段：截断过长文本，去除可能的 HTML 标签 */
export function sanitizeSnapshotString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  // 去除可能的 HTML 标签（Angular 模板默认转义，但多一层防护）
  const cleaned = value.replace(/<[^>]*>/g, '');
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export function buildPrehydrateProjects(snapshotProjects: LaunchSnapshotProject[]): Project[] {
  // 安全限制：最多预填充 50 个项目，防止恶意 localStorage 注入导致内存/渲染爆炸
  const MAX_PREHYDRATE_PROJECTS = 50;
  const MAX_NAME_LENGTH = 200;
  const now = new Date().toISOString();
  const results: Project[] = [];

  for (const sp of snapshotProjects.slice(0, MAX_PREHYDRATE_PROJECTS)) {
    // 安全校验：ID 必须是合法 UUID，防止注入恶意字符串
    if (!sp.id || typeof sp.id !== 'string' || !isValidUUID(sp.id)) continue;

    results.push({
      id: sp.id,
      name: sanitizeSnapshotString(sp.name, MAX_NAME_LENGTH) || 'Untitled',
      description: sanitizeSnapshotString(sp.description, MAX_NAME_LENGTH),
      createdDate: now,
      updatedAt: sp.updatedAt ?? now,
      // launch-snapshot 里的 recentTasks 只是秒开摘要，不包含 stage/parentId/content 等
      // 完整字段；不能 materialize 到 TaskStore，否则会被当成真实待分配任务展示。
      tasks: [],
      connections: [],
    });
  }

  return results;
}

export function cloneOfflineProjectsForPrehydrate(projects: Project[]): Project[] {
  return projects.map((project) => ({
    ...project,
    tasks: Array.isArray(project.tasks) ? [...project.tasks] : [],
    connections: Array.isArray(project.connections) ? [...project.connections] : [],
  }));
}

export function buildHintScopedPlaceholderProjects(projects: Project[]): Project[] {
  return projects.map((project, index) => ({
    id: project.id,
    name: `Project ${index + 1}`,
    description: '',
    createdDate: project.createdDate,
    updatedAt: project.updatedAt,
    version: project.version,
    syncSource: project.syncSource,
    pendingSync: project.pendingSync,
    tasks: [],
    connections: [],
  }));
}
