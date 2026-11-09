import { Injectable, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SupabaseClientService } from './supabase-client.service';
import type { ExternalSourceLink } from '../app/core/external-sources/external-source.model';
import {
  externalSourceLinkToRow,
  type ExternalSourceLinkRow,
} from '../app/core/external-sources/external-source-link.helpers';
import { assertSyncOperationId } from '../utils/sync-operation-id';

interface ExternalSourceLinkTableSchema {
  public: {
    Tables: {
      external_source_links: {
        Row: ExternalSourceLinkRow;
        Insert: ExternalSourceLinkRow;
        Update: Partial<ExternalSourceLinkRow>;
        Relationships: [];
      };
    };
  };
}

type ExternalSourceSupabaseClient = SupabaseClient<ExternalSourceLinkTableSchema>;

@Injectable({ providedIn: 'root' })
export class ExternalSourceLinkRemoteWriterService {
  private readonly supabase = inject(SupabaseClientService);

  async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    const client = await this.supabase.clientAsync();
    return client as unknown as ExternalSourceSupabaseClient | null;
  }

  async upsertLink(
    client: ExternalSourceSupabaseClient,
    link: ExternalSourceLink,
    userId: string,
    operationId: string,
  ): Promise<{ error: unknown | null }> {
    assertSyncOperationId(operationId);
    return client
      .from('external_source_links')
      .upsert(externalSourceLinkToRow(link, userId, operationId) as unknown as never, {
        onConflict: 'id',
      });
  }
}

export type { ExternalSourceSupabaseClient };
