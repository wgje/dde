import { Injectable, computed, inject } from '@angular/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseClientService } from '../../../services/supabase-client.service';
import { AuthService } from '../../../services/auth.service';
import { ToastService } from '../../../services/toast.service';
import { LoggerService } from '../../../services/logger.service';
import { AUTH_CONFIG } from '../../../config/auth.config';
import { ExternalSourceCacheService } from './external-source-cache.service';
import { ExternalSourceLinkStore } from './external-source-link.store';
import type { ExternalSourceLink, ExternalSourceRole } from './external-source.model';
import { parseSiyuanBlockLink, shortenSiyuanBlockId } from './siyuan/siyuan-link-parser';

interface ExternalSourceLinkRow {
  id: string;
  user_id: string;
  task_id: string;
  source_type: 'siyuan-block';
  target_id: string;
  uri: string;
  label: string | null;
  hpath: string | null;
  role: ExternalSourceRole | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ExternalSourceLinkTableSchema {
  public: {
    Tables: {
      external_source_links: {
        Row: ExternalSourceLinkRow;
        Insert: ExternalSourceLinkRow;
        Update: Partial<ExternalSourceLinkRow>;
      };
    };
  };
}

type ExternalSourceSupabaseClient = SupabaseClient<ExternalSourceLinkTableSchema>;

@Injectable({ providedIn: 'root' })
export class ExternalSourceLinkService {
  private readonly store = inject(ExternalSourceLinkStore);
  private readonly cache = inject(ExternalSourceCacheService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly logger = inject(LoggerService).category('ExternalSourceLink');

  readonly links = this.store.links;
  readonly activeLinks = computed(() => this.links().filter(link => !link.deletedAt));
  private initialized = false;

  async ensureLoaded(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const localLinks = await this.cache.loadLinks();
    this.store.replaceAll(localLinks);
    const remoteLinks = await this.pullRemoteLinks();
    if (remoteLinks.length > 0) {
      const merged = this.mergeLinks(localLinks, remoteLinks);
      this.store.replaceAll(merged);
      await this.cache.saveLinks(merged);
    }
  }

  activeLinksForTask(taskId: string): ExternalSourceLink[] {
    void this.ensureLoaded();
    return this.store.activeLinksForTask(taskId);
  }

  firstActiveLinkForTask(taskId: string): ExternalSourceLink | null {
    void this.ensureLoaded();
    return this.store.firstActiveLinkForTask(taskId);
  }

  async bindSiyuanBlock(taskId: string, input: string, role: ExternalSourceRole = 'context'): Promise<ExternalSourceLink | null> {
    const parsed = parseSiyuanBlockLink(input);
    if (!parsed) {
      this.toast.error('思源链接无效', '请粘贴 siyuan://blocks/{id} 或思源块 ID');
      return null;
    }

    await this.ensureLoaded();
    const existing = this.store.activeLinksForTask(taskId)
      .find(link => link.sourceType === 'siyuan-block' && link.targetId === parsed.blockId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const link: ExternalSourceLink = {
      id: crypto.randomUUID(),
      taskId,
      sourceType: 'siyuan-block',
      targetId: parsed.blockId,
      uri: parsed.uri,
      label: `思源 ${shortenSiyuanBlockId(parsed.blockId)}`,
      role,
      sortOrder: this.store.activeLinksForTask(taskId).length,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.persistLocal(link);
    void this.pushLink(link);
    this.toast.success('已关联思源块');
    return link;
  }

  async removeLink(linkId: string): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = { ...existing, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await this.persistLocal(link);
    await this.cache.deletePreviewsForLink(link.id);
    void this.pushLink(link);
    this.toast.info('已解除思源关联');
  }

  async updateMetadata(linkId: string, patch: Pick<Partial<ExternalSourceLink>, 'label' | 'hpath' | 'role' | 'sortOrder'>): Promise<void> {
    await this.ensureLoaded();
    const existing = this.store.getLink(linkId);
    if (!existing) return;
    const link = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.persistLocal(link);
    void this.pushLink(link);
  }

  openLink(link: ExternalSourceLink): void {
    if (typeof window === 'undefined') return;
    if (!parseSiyuanBlockLink(link.uri)) {
      this.toast.error('思源链接无效', '已阻止打开非 siyuan:// 块链接');
      return;
    }
    window.location.href = link.uri;
  }

  private async persistLocal(link: ExternalSourceLink): Promise<void> {
    this.store.upsert(link);
    await this.cache.saveLinks(this.links());
  }

  private async pullRemoteLinks(): Promise<ExternalSourceLink[]> {
    const client = await this.getClient();
    const userId = this.currentUserId();
    if (!client || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return [];
    try {
      const { data, error } = await client
        .from('external_source_links')
        .select('id,user_id,task_id,source_type,target_id,uri,label,hpath,role,sort_order,deleted_at,created_at,updated_at')
        .eq('user_id', userId);
      if (error) throw error;
      return (data ?? []).map(row => this.rowToLink(row));
    } catch (error) {
      this.logger.warn('拉取思源锚点失败，保留本地状态', { message: error instanceof Error ? error.message : 'unknown' });
      return [];
    }
  }

  private async pushLink(link: ExternalSourceLink): Promise<void> {
    const client = await this.getClient();
    const userId = this.currentUserId();
    if (!client || userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) return;
    try {
      const { error } = await client.from('external_source_links').upsert(this.linkToRow(link, userId), { onConflict: 'id' });
      if (error) throw error;
    } catch (error) {
      this.logger.warn('推送思源锚点失败，等待下次加载重试', { linkId: link.id, message: error instanceof Error ? error.message : 'unknown' });
    }
  }

  private async getClient(): Promise<ExternalSourceSupabaseClient | null> {
    const client = await this.supabase.clientAsync();
    return client as unknown as ExternalSourceSupabaseClient | null;
  }

  private currentUserId(): string {
    return this.auth.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private mergeLinks(localLinks: ExternalSourceLink[], remoteLinks: ExternalSourceLink[]): ExternalSourceLink[] {
    const map = new Map<string, ExternalSourceLink>();
    for (const link of [...localLinks, ...remoteLinks]) {
      const existing = map.get(link.id);
      if (!existing || (existing.updatedAt ?? '') < (link.updatedAt ?? '')) map.set(link.id, link);
    }
    return Array.from(map.values());
  }

  private linkToRow(link: ExternalSourceLink, userId: string): ExternalSourceLinkRow {
    return {
      id: link.id,
      user_id: userId,
      task_id: link.taskId,
      source_type: link.sourceType,
      target_id: link.targetId,
      uri: link.uri,
      label: link.label ?? null,
      hpath: link.hpath ?? null,
      role: link.role ?? null,
      sort_order: link.sortOrder,
      deleted_at: link.deletedAt ?? null,
      created_at: link.createdAt,
      updated_at: link.updatedAt,
    };
  }

  private rowToLink(row: ExternalSourceLinkRow): ExternalSourceLink {
    return {
      id: row.id,
      taskId: row.task_id,
      sourceType: row.source_type,
      targetId: row.target_id,
      uri: row.uri,
      label: row.label ?? undefined,
      hpath: row.hpath ?? undefined,
      role: row.role ?? undefined,
      sortOrder: row.sort_order,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
