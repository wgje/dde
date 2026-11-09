import { DataSafetyAuditLog } from './data-safety-audit-log';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import type { BuildLastWriteExplainInput, DataSafetyLastWriteExplain } from './data-safety-package';

const DEFAULT_MAX_ENTRIES = 100;

export interface DataSafetyWriteAuditServiceOptions {
  persistence?: DataSafetyAuditPersistence;
  maxEntries?: number;
  onPersistenceFailure?: (context: {
    ownerUserId: string;
    operationId: string;
  }) => void;
}

export type DataSafetyWriteAuditInput = BuildLastWriteExplainInput & {
  ownerUserId: string | null | undefined;
};

export class DataSafetyWriteAuditService {
  private readonly persistence: DataSafetyAuditPersistence;
  private readonly maxEntries: number;
  private readonly onPersistenceFailure: NonNullable<
    DataSafetyWriteAuditServiceOptions['onPersistenceFailure']
  >;

  constructor(options: DataSafetyWriteAuditServiceOptions = {}) {
    this.persistence = options.persistence ?? new DataSafetyAuditPersistence({ maxEntries: options.maxEntries });
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.onPersistenceFailure = options.onPersistenceFailure ?? ((context) => {
      console.error('[DataSafetyWriteAudit] persistence failed', context);
    });
  }

  recordWrite(input: DataSafetyWriteAuditInput): DataSafetyLastWriteExplain {
    const log = new DataSafetyAuditLog({ maxEntries: this.maxEntries });
    if (input.ownerUserId) {
      log.hydrate(this.persistence.load(input.ownerUserId));
    }

    const explain = log.recordWrite(input);
    if (input.ownerUserId) {
      const persisted = this.persistence.save(input.ownerUserId, log.snapshot());
      if (!persisted) {
        try {
          this.onPersistenceFailure({
            ownerUserId: input.ownerUserId,
            operationId: input.operationId,
          });
        } catch {
          // Audit observability failures must not affect the completed data write.
        }
      }
    }

    return explain;
  }
}
