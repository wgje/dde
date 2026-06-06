/**
 * SettingsModalComponent 的「任务索引构建」纯函数模块。
 *
 * 从 SettingsModalComponent「下切」出的无状态索引构建器：附件导入时需要把项目集合
 * 投影成 taskId→附件元数据 / taskId→projectId 的查找表。全部纯函数（无 `this`、无副作用）。
 *
 * - buildTaskAttachmentMap：taskId → 附件元数据列表（仅含有附件的任务）
 * - buildTaskProjectIndex：taskId → 所属 projectId
 *
 * 为什么抽离：AGENTS.md §12 单文件 ≤ 800 行硬线；SettingsModalComponent 长期越界，
 * 这些纯数据投影不属于组件视图职责，适合先行下切。
 */
import { Project } from '../../../models';

export interface TaskAttachmentMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export function buildTaskAttachmentMap(projects: Project[]): Map<string, TaskAttachmentMetadata[]> {
  const map = new Map<string, TaskAttachmentMetadata[]>();

  for (const project of projects) {
    for (const task of project.tasks) {
      if (!task.attachments || task.attachments.length === 0) continue;

      const attachments: TaskAttachmentMetadata[] = task.attachments.map(att => ({
        id: att.id,
        name: att.name,
        size: att.size ?? 0,
        mimeType: att.mimeType ?? 'application/octet-stream',
      }));

      map.set(task.id, attachments);
    }
  }

  return map;
}

export function buildTaskProjectIndex(projects: Project[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const project of projects) {
    for (const task of project.tasks) {
      index.set(task.id, project.id);
    }
  }

  return index;
}
