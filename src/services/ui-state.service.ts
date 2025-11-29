import { Injectable, signal, computed } from '@angular/core';
import { ThemeType } from '../models';
import { CACHE_CONFIG } from '../config/constants';

/**
 * UI 状态服务
 * 负责管理与视图相关的 UI 状态，从 StoreService 中分离出来
 * 实现关注点分离，UI 状态变更不会触发数据相关的重计算
 */
@Injectable({
  providedIn: 'root'
})
export class UiStateService {
  // ========== 响应式 UI 状态 ==========
  
  /** 是否为移动端 */
  readonly isMobile = signal(false);
  
  /** 侧边栏宽度 */
  readonly sidebarWidth = signal(280);
  
  /** 文本栏比例 */
  readonly textColumnRatio = signal(50);
  
  /** 布局方向 */
  readonly layoutDirection = signal<'ltr' | 'rtl'>('ltr');
  
  /** 浮动窗口偏好 */
  readonly floatingWindowPref = signal<'auto' | 'fixed'>('auto');
  
  /** 主题 */
  readonly theme = signal<ThemeType>('default');
  
  // ========== 视图折叠状态 ==========
  
  /** 文本视图 - 未完成列表是否展开 */
  readonly isTextUnfinishedOpen = signal(true);
  
  /** 文本视图 - 未分配列表是否展开 */
  readonly isTextUnassignedOpen = signal(true);
  
  /** 流程图视图 - 未完成列表是否展开 */
  readonly isFlowUnfinishedOpen = signal(true);
  
  /** 流程图视图 - 未分配列表是否展开 */
  readonly isFlowUnassignedOpen = signal(true);
  
  /** 流程图视图 - 详情面板是否展开 */
  readonly isFlowDetailOpen = signal(false);
  
  // ========== 派生状态 ==========
  
  /** 是否为桌面端 */
  readonly isDesktop = computed(() => !this.isMobile());
  
  constructor() {
    this.loadLocalPreferences();
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 设置主题
   */
  setTheme(theme: ThemeType) {
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
  }
  
  /**
   * 检测并更新移动端状态
   */
  checkMobile(): boolean {
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    this.isMobile.set(isMobile);
    return isMobile;
  }
  
  /**
   * 设置侧边栏宽度
   */
  setSidebarWidth(width: number) {
    const clampedWidth = Math.max(200, Math.min(600, width));
    this.sidebarWidth.set(clampedWidth);
  }
  
  /**
   * 设置文本栏比例
   */
  setTextColumnRatio(ratio: number) {
    const clampedRatio = Math.max(25, Math.min(75, ratio));
    this.textColumnRatio.set(clampedRatio);
  }
  
  /**
   * 设置布局方向
   */
  setLayoutDirection(direction: 'ltr' | 'rtl') {
    this.layoutDirection.set(direction);
  }
  
  /**
   * 设置浮动窗口偏好
   */
  setFloatingWindowPref(pref: 'auto' | 'fixed') {
    this.floatingWindowPref.set(pref);
  }
  
  /**
   * 切换文本视图未完成列表
   */
  toggleTextUnfinished() {
    this.isTextUnfinishedOpen.update(v => !v);
  }
  
  /**
   * 切换文本视图未分配列表
   */
  toggleTextUnassigned() {
    this.isTextUnassignedOpen.update(v => !v);
  }
  
  /**
   * 切换流程图视图未完成列表
   */
  toggleFlowUnfinished() {
    this.isFlowUnfinishedOpen.update(v => !v);
  }
  
  /**
   * 切换流程图视图未分配列表
   */
  toggleFlowUnassigned() {
    this.isFlowUnassignedOpen.update(v => !v);
  }
  
  /**
   * 切换流程图视图详情面板
   */
  toggleFlowDetail() {
    this.isFlowDetailOpen.update(v => !v);
  }
  
  /**
   * 设置流程图视图详情面板状态
   */
  setFlowDetailOpen(open: boolean) {
    this.isFlowDetailOpen.set(open);
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 应用主题到 DOM
   */
  private applyThemeToDOM(theme: string) {
    if (typeof document === 'undefined') return;
    
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
  
  /**
   * 加载本地偏好设置
   */
  private loadLocalPreferences() {
    if (typeof localStorage === 'undefined') return;
    
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }
}
