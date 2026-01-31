/**
 * Persistence Services - 持久化子服务模块
 * 
 * Sprint 8 技术债务修复：从 StorePersistenceService 拆分的专注服务
 */

export { DataIntegrityService } from './data-integrity.service';
export type { IntegrityIssue, IntegrityCheckResult, WriteVerifyResult } from './data-integrity.service';
export { IndexedDBService, DB_CONFIG } from './indexeddb.service';
export { BackupService } from './backup.service';
