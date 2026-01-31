/**
 * 持久化相关类型定义
 * 
 * @description
 * 集中管理持久化模块的类型定义
 */

/**
 * 数据完整性校验结果
 */
export interface OfflineIntegrityResult {
  valid: boolean;
  issues: OfflineIntegrityIssue[];
  stats: {
    projectCount: number;
    taskCount: number;
    connectionCount: number;
    orphanedTasks: number;
    brokenConnections: number;
  };
  timestamp: number;
}

/**
 * 数据完整性问题
 */
export interface OfflineIntegrityIssue {
  type: 'orphaned-task' | 'broken-connection' | 'missing-project' | 'invalid-data' | 'index-mismatch';
  entityId: string;
  projectId?: string;
  message: string;
  severity: 'error' | 'warning';
}
