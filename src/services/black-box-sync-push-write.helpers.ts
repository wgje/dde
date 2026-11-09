import { type BlackBoxEntry } from '../models/focus';
import { type TablesInsert, type TablesUpdate } from '../types/supabase';
import {
  type BlackBoxSupabaseClient,
  type BlackBoxUpsertWriteResult,
} from './black-box-sync.types';

type BlackBoxPushWriteLogger = {
  warn: (message: string, data?: Record<string, unknown>) => void;
};

interface BlackBoxPushWriteOptions {
  client: BlackBoxSupabaseClient;
  entry: BlackBoxEntry;
  sessionUserId: string;
  preflightServerEntry: BlackBoxEntry | null;
  logger: BlackBoxPushWriteLogger;
  buildInsertPayload: (entry: BlackBoxEntry) => TablesInsert<'black_box_entries'>;
  buildUpdatePayload: (entry: BlackBoxEntry) => TablesUpdate<'black_box_entries'>;
}

export async function writeBlackBoxEntryByPreflightState(
  options: BlackBoxPushWriteOptions,
): Promise<BlackBoxUpsertWriteResult> {
  const { client, entry, preflightServerEntry, logger } = options;
  if (preflightServerEntry?.updatedAt) {
    return await updateExistingBlackBoxEntryWithCas(options, preflightServerEntry.updatedAt);
  }

  if (preflightServerEntry) {
    logger.warn('黑匣子预检命中缺失 updated_at 的远端行，放弃本轮写入避免覆盖未对账状态', {
      entryId: entry.id,
    });
    return { savedRow: null, error: null, deferred: true };
  }

  const { data: savedRow, error } = await client
    .from('black_box_entries')
    .insert(options.buildInsertPayload(entry))
    .select('id, updated_at')
    .single();

  const code = (error as { code?: string | number } | null)?.code;
  if (error && (code === '23505' || code === 23505)) {
    logger.warn('黑匣子 insert 命中并发主键冲突，延后到下一轮重试', {
      entryId: entry.id,
    });
    return { savedRow: null, error: null, deferred: true };
  }

  return { savedRow, error };
}

async function updateExistingBlackBoxEntryWithCas(
  options: BlackBoxPushWriteOptions,
  baseUpdatedAt: string,
): Promise<BlackBoxUpsertWriteResult> {
  const { client, entry, sessionUserId, logger } = options;
  const { data: savedRow, error } = await client
    .from('black_box_entries')
    .update(options.buildUpdatePayload(entry))
    .eq('id', entry.id)
    .eq('user_id', sessionUserId)
    .eq('updated_at', baseUpdatedAt)
    .select('id, updated_at')
    .maybeSingle();

  if (!error && !savedRow) {
    logger.warn('黑匣子 CAS 写入被并发更新打断，延后到下一轮重试', {
      entryId: entry.id,
      baseUpdatedAt,
    });
    return { savedRow: null, error: null, deferred: true };
  }

  return { savedRow, error };
}
