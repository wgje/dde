/**
 * 地质层服务
 * 
 * 负责已完成任务的堆叠可视化
 * 整合黑匣子完成条目和任务系统完成任务
 */

import { Injectable, inject, computed } from '@angular/core';
import { Task } from '../models';
import { StrataItem, StrataLayer } from '../models/focus';
import { FOCUS_CONFIG } from '../config/focus.config';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { LoggerService } from './logger.service';
import {
  strataLayers,
  todayCompletedCount,
  blackBoxEntriesMap,
  getTodayDate,
  getDaysAgoDate
} from '../state/focus-stores';

@Injectable({
  providedIn: 'root'
})
export class StrataService {
  private blackBoxService = inject(BlackBoxService);
  private projectState = inject(ProjectStateService);
  private logger = inject(LoggerService);
  
  // 暴露状态给组件
  readonly layers = strataLayers;
  readonly todayCount = todayCompletedCount;
  
  /**
   * 总完成数量
   */
  readonly totalCount = computed(() => {
    return strataLayers().reduce((sum, layer) => sum + layer.items.length, 0);
  });
  
  /**
   * 刷新地质层数据
   */
  refresh(): void {
    const config = FOCUS_CONFIG.STRATA;
    const layers: StrataLayer[] = [];
    
    for (let i = 0; i < config.MAX_DISPLAY_DAYS; i++) {
      const date = getDaysAgoDate(i);
      const items = this.getItemsForDate(date);
      
      if (items.length > 0) {
        // 计算透明度：越旧越透明
        const opacity = Math.max(
          config.MIN_OPACITY,
          1 - (i * config.OPACITY_DECAY)
        );
        
        layers.push({
          date,
          items,
          opacity
        });
      }
    }
    
    strataLayers.set(layers);
    this.logger.debug('Strata', `Strata layers refreshed: ${layers.length} layers`);
  }
  
  /**
   * 获取指定日期的完成项目
   */
  private getItemsForDate(date: string): StrataItem[] {
    const blackBoxItems = this.getBlackBoxItemsForDate(date);
    const taskItems = this.getTaskItemsForDate(date);
    
    // 合并并按完成时间排序
    return [...blackBoxItems, ...taskItems]
      .sort((a, b) => 
        new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime()
      );
  }
  
  /**
   * 获取指定日期完成的黑匣子条目
   */
  private getBlackBoxItemsForDate(date: string): StrataItem[] {
    return Array.from(blackBoxEntriesMap().values())
      .filter(e => 
        e.isCompleted && 
        !e.deletedAt &&
        this.getDateFromTimestamp(e.updatedAt) === date
      )
      .map(e => ({
        type: 'black_box' as const,
        id: e.id,
        title: (e.content || '').slice(0, 100),
        completedAt: e.updatedAt,
        source: e
      }));
  }
  
  /**
   * 获取指定日期完成的任务
   */
  private getTaskItemsForDate(date: string): StrataItem[] {
    const projectId = this.projectState.activeProjectId();
    if (!projectId) return [];
    
    const tasks = this.projectState.tasks();
    
    return tasks
      .filter((t: Task) =>
        t.status === 'completed' &&
        !t.deletedAt &&
        t.updatedAt &&
        this.getDateFromTimestamp(t.updatedAt) === date
      )
      .map((t: Task) => ({
        type: 'task' as const,
        id: t.id,
        title: t.title,
        completedAt: t.updatedAt || new Date().toISOString(),
        source: t
      }));
  }
  
  /**
   * 从时间戳提取日期 YYYY-MM-DD
   */
  private getDateFromTimestamp(timestamp: string): string {
    return timestamp.split('T')[0];
  }
  
  /**
   * 获取今日完成项目
   */
  getTodayItems(): StrataItem[] {
    const today = getTodayDate();
    return this.getItemsForDate(today);
  }
  
  /**
   * 获取本周完成数量
   */
  getWeeklyCount(): number {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const date = getDaysAgoDate(i);
      count += this.getItemsForDate(date).length;
    }
    return count;
  }
  
  /**
   * 获取特定层
   */
  getLayer(date: string): StrataLayer | undefined {
    return strataLayers().find(l => l.date === date);
  }
  
  /**
   * 获取层的显示标签
   */
  getLayerLabel(date: string): string {
    const today = getTodayDate();
    const yesterday = getDaysAgoDate(1);
    
    if (date === today) return '今日';
    if (date === yesterday) return '昨日';
    
    // 格式化日期
    const d = new Date(date);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}月${day}日`;
  }
  
  /**
   * 获取层的颜色类
   */
  getLayerColorClass(index: number): string {
    // 越近的层颜色越深
    if (index === 0) return 'bg-stone-100 dark:bg-stone-800';
    if (index === 1) return 'bg-stone-200/70 dark:bg-stone-700/70';
    return 'bg-stone-300/40 dark:bg-stone-600/40';
  }
  
  // ========== 测试兼容方法 ==========
  
  /**
   * 加载层（测试兼容方法，等同于 refresh）
   */
  async loadLayers(): Promise<void> {
    this.refresh();
  }
  
  /**
   * 添加项目到对应日期的层
   */
  addItem(item: StrataItem): void {
    const date = this.getDateFromTimestamp(item.completedAt);
    const layers = strataLayers();
    const existingLayer = layers.find(l => l.date === date);
    
    if (existingLayer) {
      // 更新现有层
      strataLayers.set(
        layers.map(l => 
          l.date === date 
            ? { ...l, items: [...l.items, item] }
            : l
        )
      );
    } else {
      // 创建新层
      const newLayer: StrataLayer = {
        date,
        items: [item],
        opacity: 1,
        collapsed: false
      };
      strataLayers.set([newLayer, ...layers]);
    }
  }
  
  /**
   * 计算层的透明度
   */
  getLayerOpacity(layer: StrataLayer): number {
    const config = FOCUS_CONFIG.STRATA;
    const today = getTodayDate();
    const daysDiff = Math.floor(
      (new Date(today).getTime() - new Date(layer.date).getTime()) / (1000 * 60 * 60 * 24)
    );
    return Math.max(config.MIN_OPACITY, 1 - (daysDiff * config.OPACITY_DECAY));
  }
  
  /**
   * 获取所有项目总数（方法版本）
   */
  getTotalCount(): number {
    return this.totalCount();
  }
  
  /**
   * 清除超过保留天数的旧层
   */
  clearOldLayers(retentionDays: number): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    
    strataLayers.set(
      strataLayers().filter(l => l.date >= cutoffDateStr)
    );
  }
  
  /**
   * 切换层的折叠状态
   */
  collapseLayer(date: string): void {
    strataLayers.set(
      strataLayers().map(l => 
        l.date === date 
          ? { ...l, collapsed: !l.collapsed }
          : l
      )
    );
  }
}
