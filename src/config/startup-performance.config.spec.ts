import { describe, it, expect } from 'vitest';
import { STARTUP_PERF_CONFIG } from './startup-performance.config';

describe('STARTUP_PERF_CONFIG', () => {
  it('should expose tiered startup delays', () => {
    expect(STARTUP_PERF_CONFIG.P1_INTERACTION_HYDRATE_DELAY_MS).toBe(500);
    expect(STARTUP_PERF_CONFIG.P2_SYNC_HYDRATE_DELAY_MS).toBe(2000);
    expect(STARTUP_PERF_CONFIG.P2_SYNC_MIN_VISIBLE_MS).toBe(1200);
  });

  it('should expose tightened startup guards', () => {
    expect(STARTUP_PERF_CONFIG.STARTUP_INITIAL_STATIC_JS_MAX_KB).toBe(340);
    expect(STARTUP_PERF_CONFIG.STARTUP_WORKSPACE_CHUNK_MAX_KB).toBe(125);
    expect(STARTUP_PERF_CONFIG.STARTUP_MAIN_STATIC_IMPORT_MAX).toBe(10);
  });

  it('should expose aggressive font defer and authenticated weak-network budgets', () => {
    expect(STARTUP_PERF_CONFIG.FONT_ENHANCED_INTERACTION_ONLY_V2).toBe(true);
    expect(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS).toBe(8000);
    expect(STARTUP_PERF_CONFIG.FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS).toBe(15000);
    expect(STARTUP_PERF_CONFIG.FONT_ENHANCED_SKIP_ON_CONSTRAINED_NETWORK).toBe(true);
    expect(STARTUP_PERF_CONFIG.STARTUP_INITIAL_DATA_FETCH_MAX).toBe(20);
  });

  // ========== 配置间逻辑不变量验证 ==========

  it('P1 交互层延迟应小于 P2 同步层延迟', () => {
    expect(STARTUP_PERF_CONFIG.P1_INTERACTION_HYDRATE_DELAY_MS)
      .toBeLessThan(STARTUP_PERF_CONFIG.P2_SYNC_HYDRATE_DELAY_MS);
  });

  it('main 入口上限应小于 initial static JS 总上限', () => {
    expect(STARTUP_PERF_CONFIG.STARTUP_MAIN_MAX_KB)
      .toBeLessThan(STARTUP_PERF_CONFIG.STARTUP_INITIAL_STATIC_JS_MAX_KB);
  });

  it('workspace chunk 上限应小于 initial static JS 总上限', () => {
    expect(STARTUP_PERF_CONFIG.STARTUP_WORKSPACE_CHUNK_MAX_KB)
      .toBeLessThan(STARTUP_PERF_CONFIG.STARTUP_INITIAL_STATIC_JS_MAX_KB);
  });

  it('字体强制兜底延迟应大于常规延迟', () => {
    expect(STARTUP_PERF_CONFIG.FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS)
      .toBeGreaterThan(STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
  });

  // ========== 覆盖剩余配置值 ==========

  it('should expose Focus remote startup config', () => {
    expect(STARTUP_PERF_CONFIG.FOCUS_REMOTE_STARTUP_DELAY_MS).toBe(4000);
    expect(STARTUP_PERF_CONFIG.FOCUS_REMOTE_MIN_VISIBLE_MS).toBe(1200);
  });

  it('should expose Flow restore config', () => {
    expect(STARTUP_PERF_CONFIG.FLOW_RESTORE_IDLE_DELAY_MS).toBe(1200);
    expect(STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_DELAY_MS).toBe(3000);
    expect(STARTUP_PERF_CONFIG.FLOW_RESTORE_MAX_RTT_MS).toBe(280);
    expect(STARTUP_PERF_CONFIG.FLOW_IDLE_PRELOAD_MIN_DOWNLINK_MBPS).toBe(1.5);
  });

  it('should expose sync heartbeat and cooldown config', () => {
    expect(STARTUP_PERF_CONFIG.SYNC_HEARTBEAT_VISIBLE_INTERVAL_MS).toBe(300000);
    expect(STARTUP_PERF_CONFIG.SYNC_EVENT_COOLDOWN_MS).toBe(10000);
    expect(STARTUP_PERF_CONFIG.TAB_SYNC_LOCAL_REFRESH_COOLDOWN_MS).toBe(3000);
  });

  it('should expose remaining build gate values', () => {
    expect(STARTUP_PERF_CONFIG.STARTUP_MAIN_MAX_KB).toBe(260);
    expect(STARTUP_PERF_CONFIG.STARTUP_INITIAL_FETCH_MAX).toBe(12);
    expect(STARTUP_PERF_CONFIG.STARTUP_MODULEPRELOAD_MAX).toBe(0);
    expect(STARTUP_PERF_CONFIG.INDEX_PRELOAD_FETCH_ENABLED).toBe(false);
  });
});
