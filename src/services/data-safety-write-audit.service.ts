import { DataSafetyAuditLog } from './data-safety-audit-log';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import type { BuildLastWriteExplainInput, DataSafetyLastWriteExplain } from './data-safety-package';

const DEFAULT_MAX_ENTRIES = 100;

export interface DataSafetyWriteAuditServiceOptions {
  persistence?: DataSafetyAuditPersistence;
  maxEntries?: number;
}

export type DataSafetyWriteAuditInput = BuildLastWriteExplainInput & {
  ownerUserId: string | null | undefined;
};

export class DataSafetyWriteAuditService {
  private readonly persistence: DataSafetyAuditPersistence;
  private readonly maxEntries: number;

  constructor(options: DataSafetyWriteAuditServiceOptions = {}) {
    this.persistence = options.persistence ?? new DataSafetyAuditPersistence({ maxEntries: options.maxEntries });
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
  }

  recordWrite(input: DataSafetyWriteAuditInput): DataSafetyLastWriteExplain {
    const log = new DataSafetyAuditLog({ maxEntries: this.maxEntries });
    if (input.ownerUserId) {
      log.hydrate(this.persistence.load(input.ownerUserId));
    }

    const explain = log.recordWrite(input);
    if (input.ownerUserId) {
      this.persistence.save(input.ownerUserId, log.snapshot());
    }

    return explain;
  }
}
