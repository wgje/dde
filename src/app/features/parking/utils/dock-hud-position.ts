/**
 * HUD 位置管理工具 — 专注模式状态机面板的定位、持久化与视口约束。
 *
 * 从 ParkingDockComponent 提取的纯函数集合，
 * 处理 localStorage 读写和视口边界约束。
 */

import { PARKING_CONFIG } from '../../../../config/parking.config';

export interface HudSize {
  width: number;
  height: number;
}

export interface HudPosition {
  x: number;
  y: number;
}

/** 从 localStorage 加载 HUD 位置，缓存损坏时返回 null */
export function loadHudPosition(size: HudSize): HudPosition | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PARKING_CONFIG.FOCUS_HUD_LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return clampHudPosition(
      { x: Number(parsed.x), y: Number(parsed.y) },
      size,
    );
  } catch {
    // 本地布局缓存损坏时回退到默认 HUD 定位
  }
  return null;
}

/** 将 HUD 位置持久化到 localStorage */
export function persistHudPosition(position: HudPosition | null): void {
  if (typeof localStorage === 'undefined') return;
  if (!position) return;
  try {
    localStorage.setItem(
      PARKING_CONFIG.FOCUS_HUD_LAYOUT_STORAGE_KEY,
      JSON.stringify(position),
    );
  } catch {
    // Ignore storage errors in degraded environments.
  }
}

/** 计算默认 HUD 位置（视口右上角，留 minMargin 边距） */
export function defaultHudPosition(
  size: HudSize,
): HudPosition {
  if (typeof window === 'undefined') {
    return { x: 12, y: PARKING_CONFIG.HUD_FULL_DEFAULT_TOP_PX };
  }
  const minMargin = 12;
  return clampHudPosition(
    {
      x: window.innerWidth - size.width - minMargin,
      y: PARKING_CONFIG.HUD_FULL_DEFAULT_TOP_PX,
    },
    size,
  );
}

/** 从容器 DOMRect 推算 HUD 实际尺寸 */
export function resolveHudSize(
  rect: Pick<DOMRect, 'width' | 'height'> | null | undefined,
  fallback: HudSize,
): HudSize {
  return {
    width: Math.max(1, Math.round(rect?.width ?? fallback.width)),
    height: Math.max(1, Math.round(rect?.height ?? fallback.height)),
  };
}

/**
 * 将 HUD 位置约束在视口安全区域内。
 * 操作按钮已内嵌到 HUD 头部，外部 FAB 使用更高 z-index 自然浮于其上，
 * 因此四周只需统一 12px 最小边距，不再预留额外碰撞区。
 */
export function clampHudPosition(
  position: HudPosition,
  size: HudSize,
): HudPosition {
  if (typeof window === 'undefined') return position;
  const minMargin = 12;
  const maxX = Math.max(minMargin, window.innerWidth - size.width - minMargin);
  const maxY = Math.max(minMargin, window.innerHeight - size.height - minMargin);
  return {
    x: Math.min(maxX, Math.max(minMargin, Math.round(position.x))),
    y: Math.min(maxY, Math.max(minMargin, Math.round(position.y))),
  };
}
