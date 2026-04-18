/**
 * FocusToolsLoaderService
 *
 * 从 WorkspaceShellComponent 抽离的"侧边栏 Focus 工具懒加载器"。
 *
 * 覆盖两个目标：
 * 1. FocusSessionTriggerComponent —— 侧边栏触发按钮
 * 2. BlackBoxRecorderComponent    —— 黑匣子录音器
 *
 * 设计要点：
 * - 信号 + promise 缓存由本服务持有；重复调用自动去重
 * - 动态 `import()` 失败时（SW 缓存偏移、chunk 丢失）记录 breadcrumb-style
 *   warn，不抛异常，返回 null 供调用方安全降级
 * - `providedIn: 'root'` 单例：同一启动周期内只真实加载一次
 *
 * 为什么与 FocusModePreloadService 分开：
 * - FocusMode 是"整个路由级组件"，需要 preloadAssets() 预热子资源
 * - 这里两个工具是"宿主侧的小组件引用"，只需拿到 `Type<unknown>` 即可
 * - 两类语义不同，合并会引入不必要的分支
 */
import { Injectable, Type, inject, signal } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';

@Injectable({ providedIn: 'root' })
export class FocusToolsLoaderService {
  private readonly logger = inject(LoggerService);

  /** FocusSessionTriggerComponent 类型引用；null 表示未加载/加载失败 */
  readonly focusSessionTriggerComponent = signal<Type<unknown> | null>(null);

  /** BlackBoxRecorderComponent 类型引用；null 表示未加载/加载失败 */
  readonly blackBoxRecorderComponent = signal<Type<unknown> | null>(null);

  private focusSessionTriggerLoadPromise: Promise<Type<unknown> | null> | null = null;
  private blackBoxRecorderLoadPromise: Promise<Type<unknown> | null> | null = null;

  /**
   * 懒加载 FocusSessionTriggerComponent。
   *
   * @returns 已缓存则立即返回；否则返回正在进行的 import promise
   */
  loadFocusSessionTrigger(): Promise<Type<unknown> | null> {
    const current = this.focusSessionTriggerComponent();
    if (current) return Promise.resolve(current);
    if (this.focusSessionTriggerLoadPromise) return this.focusSessionTriggerLoadPromise;

    this.focusSessionTriggerLoadPromise = import(
      '../components/focus-session-trigger.component'
    )
      .then((module) => {
        const component = module.FocusSessionTriggerComponent as Type<unknown>;
        // 防御性校验：SW 缓存不一致时 import 可能成功但导出 undefined
        if (typeof component !== 'function') {
          this.logger.warn(
            'FocusSessionTriggerComponent 导入值无效（疑似 chunk 版本偏移）',
            { type: typeof component },
          );
          return null;
        }
        this.focusSessionTriggerComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('FocusSessionTriggerComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.focusSessionTriggerLoadPromise = null;
      });

    return this.focusSessionTriggerLoadPromise;
  }

  /**
   * 懒加载 BlackBoxRecorderComponent。
   *
   * 与 FocusSessionTrigger 同样的语义；分成两个方法是因为两个组件常被单独触发。
   */
  loadBlackBoxRecorder(): Promise<Type<unknown> | null> {
    const current = this.blackBoxRecorderComponent();
    if (current) return Promise.resolve(current);
    if (this.blackBoxRecorderLoadPromise) return this.blackBoxRecorderLoadPromise;

    this.blackBoxRecorderLoadPromise = import(
      '../components/black-box/black-box-recorder.component'
    )
      .then((module) => {
        const component = module.BlackBoxRecorderComponent as Type<unknown>;
        if (typeof component !== 'function') {
          this.logger.warn(
            'BlackBoxRecorderComponent 导入值无效（疑似 chunk 版本偏移）',
            { type: typeof component },
          );
          return null;
        }
        this.blackBoxRecorderComponent.set(component);
        return component;
      })
      .catch((error: unknown) => {
        this.logger.warn('BlackBoxRecorderComponent 懒加载失败', error);
        return null;
      })
      .finally(() => {
        this.blackBoxRecorderLoadPromise = null;
      });

    return this.blackBoxRecorderLoadPromise;
  }
}
