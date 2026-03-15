/**
 * 停泊坞 FLIP 过渡动画工具 — 进入/退出专注模式时的卡片映射过渡。
 *
 * 从 ParkingDockComponent 提取的纯函数集合，
 * 负责构建过渡状态、计算幽灵卡片矩形、管理 FLIP 动画生命周期。
 */

import { PARKING_CONFIG } from '../../../../config/parking.config';
import type { DockFlipRect, DockFocusTransitionState } from '../../../../models/parking-dock';

/** FLIP 幽灵卡片内部状态 */
export interface DockFlipGhostState {
  from: Required<DockFlipRect>;
  to: Required<DockFlipRect>;
  direction: 'enter' | 'exit';
}

/**
 * 构建专注模式进入/退出过渡状态对象。
 * 返回 null 表示无法获取有效矩形、应跳过动画直接切换状态。
 *
 * @param sourceEl 可选：源元素引用（避免 document.querySelector）
 * @param targetEl 可选：目标元素引用（避免 document.querySelector）
 */
export function buildFocusTransition(
  direction: 'enter' | 'exit',
  motionConfig: { enterMs: number; exitMs: number },
  dockExpanded: boolean,
  sourceEl?: HTMLElement | null,
  targetEl?: HTMLElement | null,
): DockFocusTransitionState | null {
  const fromRect = direction === 'enter'
    ? getDockSourceRect(sourceEl)
    : getConsoleSourceRect(sourceEl);
  const toRect = direction === 'enter'
    ? getConsoleTargetRect(dockExpanded, targetEl)
    : getDockTargetRect(targetEl);
  if (!fromRect || !toRect) return null;

  const durationMs = direction === 'enter'
    ? motionConfig.enterMs
    : motionConfig.exitMs;

  return {
    phase: direction === 'enter' ? 'entering' : 'exiting',
    direction,
    fromRect,
    toRect,
    durationMs,
    startedAt: new Date().toISOString(),
  };
}

/**
 * 从过渡状态创建 FLIP 幽灵卡片状态。
 * 返回 null 表示矩形无效，不应显示幽灵卡片。
 */
export function createFlipGhostState(
  transition: DockFocusTransitionState,
): DockFlipGhostState | null {
  const from = normalizeFlipRect(transition.fromRect);
  const to = normalizeFlipRect(transition.toRect);
  if (!from || !to) return null;

  return {
    from,
    to,
    direction: transition.direction === 'exit' ? 'exit' : 'enter',
  };
}

// ===== 矩形计算 =====

/** 停泊坞卡片的源矩形（进入专注的起点 / 退出专注的终点） */
export function getDockSourceRect(el?: HTMLElement | null): DockFlipRect | null {
  const explicitMain = el ?? document.querySelector<HTMLElement>(
    '[data-testid="dock-v3-item"].main-card',
  );
  const target = explicitMain ?? document.querySelector<HTMLElement>('[data-testid="dock-v3-item"]');
  if (target) {
    return toFlipRect(target.getBoundingClientRect());
  }
  // 回退：停泊坞不可见时使用屏幕底部居中的虚拟矩形
  const width = PARKING_CONFIG.FLIP_FALLBACK_WIDTH;
  const height = PARKING_CONFIG.FLIP_FALLBACK_HEIGHT;
  return {
    left: Math.max(0, Math.round((window.innerWidth - width) / 2)),
    top: Math.max(0, Math.round(window.innerHeight - height - PARKING_CONFIG.FLIP_FALLBACK_BOTTOM_OFFSET)),
    width,
    height,
  };
}

/** 停泊坞卡片的目标矩形（退出专注的终点） */
export function getDockTargetRect(el?: HTMLElement | null): DockFlipRect | null {
  return getDockSourceRect(el);
}

/** 主控台卡片的源矩形（退出专注的起点） */
export function getConsoleSourceRect(el?: HTMLElement | null): DockFlipRect | null {
  const card = el ?? document.querySelector<HTMLElement>('[data-testid="dock-v3-console-card"]');
  if (card) {
    return toFlipRect(card.getBoundingClientRect());
  }
  return getConsoleTargetRect(false);
}

/** 主控台卡片的目标矩形（进入专注的终点） */
export function getConsoleTargetRect(dockExpanded: boolean, el?: HTMLElement | null): DockFlipRect | null {
  const card = el ?? document.querySelector<HTMLElement>('[data-testid="dock-v3-console-card"]');
  if (card) {
    return toFlipRect(card.getBoundingClientRect());
  }
  // 回退：根据舞台偏移计算预期位置
  const cardWidth = PARKING_CONFIG.CONSOLE_CARD_WIDTH;
  const cardHeight = PARKING_CONFIG.CONSOLE_CARD_HEIGHT;
  const stageOffsetY = dockExpanded ? -80 : Math.round(window.innerHeight / 2 - 240);
  return {
    left: Math.round((window.innerWidth - cardWidth) / 2),
    top: Math.round((window.innerHeight - cardHeight) / 2 + stageOffsetY),
    width: cardWidth,
    height: cardHeight,
  };
}

/** DOMRect → DockFlipRect（取整避免亚像素偏移） */
export function toFlipRect(rect: DOMRect): DockFlipRect {
  return {
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * 校验并规范化 FLIP 矩形。
 * 返回 null 表示矩形数据无效（NaN / 非正尺寸）。
 */
export function normalizeFlipRect(
  rect: DockFlipRect | null | undefined,
): Required<DockFlipRect> | null {
  if (!rect) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}
