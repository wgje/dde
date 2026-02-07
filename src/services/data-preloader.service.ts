import { Injectable, inject } from '@angular/core';
import { environment } from '../environments/environment';

/**
 * 预加载数据接口
 */
interface PreloadedData {
  serverTime: number | null;
  projects: unknown[] | null;
  timestamp: number;
}

/**
 * 数据预加载服务
 *
 * 【性能优化 2026-02-05】
 *
 * 目的：
 * - 在 JavaScript 加载的同时并行请求初始数据
 * - 减少关键路径延迟 500-1000ms
 *
 * 策略：
 * 1. 在 index.html 中的内联脚本启动预加载（JS 加载期间）
 * 2. Angular 服务消费预加载的数据
 * 3. 如果预加载未完成，则正常请求
 *
 * 数据有效期：30 秒（防止过期数据）
 */
@Injectable({ providedIn: 'root' })
export class DataPreloaderService {
  /** 预加载数据存储（由 index.html 脚本设置） */
  private preloadedData: PreloadedData | null = null;

  /** 数据有效期（毫秒） */
  private readonly DATA_TTL = 30000;

  constructor() {
    // 从 window 获取预加载数据
    this.preloadedData = (window as unknown as { __PRELOADED_DATA__?: PreloadedData }).__PRELOADED_DATA__ || null;

    // 清理 window 上的引用
    if (this.preloadedData) {
      delete (window as unknown as { __PRELOADED_DATA__?: PreloadedData }).__PRELOADED_DATA__;
    }
  }

  /**
   * 获取预加载的服务器时间
   * @returns 服务器时间（如果有效），否则返回 null
   */
  getPreloadedServerTime(): number | null {
    if (!this.preloadedData || !this.isDataValid()) {
      return null;
    }

    const serverTime = this.preloadedData.serverTime;
    this.preloadedData.serverTime = null; // 只使用一次
    return serverTime;
  }

  /**
   * 获取预加载的项目列表
   * @returns 项目列表（如果有效），否则返回 null
   */
  getPreloadedProjects(): unknown[] | null {
    if (!this.preloadedData || !this.isDataValid()) {
      return null;
    }

    const projects = this.preloadedData.projects;
    this.preloadedData.projects = null; // 只使用一次
    return projects;
  }

  /**
   * 检查预加载数据是否仍然有效
   */
  private isDataValid(): boolean {
    if (!this.preloadedData) {
      return false;
    }
    return Date.now() - this.preloadedData.timestamp < this.DATA_TTL;
  }

  /**
   * 静态方法：生成预加载脚本（用于 index.html）
   *
   * 注意：此方法仅用于文档目的，实际脚本需要手动添加到 index.html
   */
  static getPreloadScript(): string {
    return `
<script>
  // 【性能优化】数据预加载 - 在 JS 加载期间并行请求
  (function() {
    window.__PRELOADED_DATA__ = {
      serverTime: null,
      projects: null,
      timestamp: Date.now()
    };

    // 检查是否已登录
    var authToken = null;
    try {
      var authKey = Object.keys(localStorage).find(function(k) {
        return k.startsWith('sb-') && k.endsWith('-auth-token');
      });
      if (authKey) {
        var authData = JSON.parse(localStorage.getItem(authKey));
        authToken = authData && authData.access_token;
      }
    } catch (e) { console.debug('[Preloader] 读取 auth token 失败', e); }

    if (!authToken) return;

    var headers = {
      'apikey': '${environment.supabaseAnonKey}',
      'Authorization': 'Bearer ' + authToken,
      'Content-Type': 'application/json'
    };
    var baseUrl = '${environment.supabaseUrl}/rest/v1';

    // 并行请求
    fetch(baseUrl + '/rpc/get_server_time', {
      method: 'POST',
      headers: headers
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (window.__PRELOADED_DATA__) {
        window.__PRELOADED_DATA__.serverTime = data;
      }
    }).catch(function(e) { console.debug('[Preloader] 预加载 serverTime 失败', e); }); {
      headers: headers
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (window.__PRELOADED_DATA__) {
        window.__PRELOADED_DATA__.projects = data;
      }
    }).catch(function(e) { console.debug('[Preloader] 预加载 projects 失败', e); });
  })();
</script>`;
  }
}
