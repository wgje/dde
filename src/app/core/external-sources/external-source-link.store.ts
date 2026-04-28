import { Injectable, computed, signal } from '@angular/core';
import type { ExternalSourceLink } from './external-source.model';

@Injectable({ providedIn: 'root' })
export class ExternalSourceLinkStore {
  private readonly linksMap = signal<Map<string, ExternalSourceLink>>(new Map(), { equal: () => false });
  private readonly linksByTask = signal<Map<string, Set<string>>>(new Map(), { equal: () => false });

  readonly links = computed(() => Array.from(this.linksMap().values()));

  activeLinksForTask(taskId: string): ExternalSourceLink[] {
    const ids = this.linksByTask().get(taskId);
    if (!ids) return [];
    return Array.from(ids)
      .map(id => this.linksMap().get(id))
      .filter((link): link is ExternalSourceLink => !!link && !link.deletedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  firstActiveLinkForTask(taskId: string): ExternalSourceLink | null {
    return this.activeLinksForTask(taskId)[0] ?? null;
  }

  getLink(linkId: string): ExternalSourceLink | undefined {
    return this.linksMap().get(linkId);
  }

  replaceAll(links: ExternalSourceLink[]): void {
    const nextLinks = new Map<string, ExternalSourceLink>();
    const nextIndex = new Map<string, Set<string>>();
    for (const link of links) {
      nextLinks.set(link.id, link);
      if (!nextIndex.has(link.taskId)) nextIndex.set(link.taskId, new Set());
      nextIndex.get(link.taskId)!.add(link.id);
    }
    this.linksMap.set(nextLinks);
    this.linksByTask.set(nextIndex);
  }

  upsert(link: ExternalSourceLink): void {
    const previous = this.linksMap().get(link.id);
    this.linksMap.update(map => {
      map.set(link.id, link);
      return map;
    });
    this.linksByTask.update(index => {
      if (previous && previous.taskId !== link.taskId) index.get(previous.taskId)?.delete(link.id);
      if (!index.has(link.taskId)) index.set(link.taskId, new Set());
      index.get(link.taskId)!.add(link.id);
      return index;
    });
  }
}
