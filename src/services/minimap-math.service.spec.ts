/**
 * MinimapMathService 单元测试
 * 
 * 测试覆盖：
 * - 缩放比例计算
 * - 坐标变换（世界 <-> 小地图）
 * - 视口指示器计算
 * - 边界合并
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MinimapMathService, WorldBounds } from './minimap-math.service';

describe('MinimapMathService', () => {
  let service: MinimapMathService;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [MinimapMathService],
    });
    service = TestBed.inject(MinimapMathService);
  });
  
  describe('calculateScaleRatio', () => {
    it('横向内容应使用宽度计算比例', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 100 };
      const ratio = service.calculateScaleRatio(contentBounds, 200, 200, 0);
      
      // 1000 宽度适配 200 宽度，比例 = 0.2
      expect(ratio).toBe(0.2);
    });
    
    it('纵向内容应使用高度计算比例', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 100, height: 1000 };
      const ratio = service.calculateScaleRatio(contentBounds, 200, 200, 0);
      
      // 1000 高度适配 200 高度，比例 = 0.2
      expect(ratio).toBe(0.2);
    });
    
    it('应考虑边距', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const ratio = service.calculateScaleRatio(contentBounds, 200, 200, 0.1);
      
      // 有效宽度 = 200 * 0.8 = 160, 比例 = 0.16
      expect(ratio).toBe(0.16);
    });
    
    it('零宽高应返回安全值', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 0, height: 0 };
      const ratio = service.calculateScaleRatio(contentBounds, 200, 200, 0);
      
      expect(ratio).toBeGreaterThan(0);
      expect(isFinite(ratio)).toBe(true);
    });
  });
  
  describe('worldToMinimap', () => {
    it('原点应映射到小地图中心附近', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const scaleRatio = 0.1;
      const minimapWidth = 200;
      const minimapHeight = 200;
      
      const result = service.worldToMinimap(
        { x: 0, y: 0 },
        contentBounds,
        scaleRatio,
        minimapWidth,
        minimapHeight
      );
      
      // 内容在小地图中的尺寸: 1000 * 0.1 = 100
      // 偏移量: (200 - 100) / 2 = 50
      expect(result.x).toBe(50);
      expect(result.y).toBe(50);
    });
    
    it('内容右下角应映射正确', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const scaleRatio = 0.1;
      const minimapWidth = 200;
      const minimapHeight = 200;
      
      const result = service.worldToMinimap(
        { x: 1000, y: 1000 },
        contentBounds,
        scaleRatio,
        minimapWidth,
        minimapHeight
      );
      
      // (1000 - 0) * 0.1 + 50 = 150
      expect(result.x).toBe(150);
      expect(result.y).toBe(150);
    });
  });
  
  describe('minimapToWorld', () => {
    it('应是 worldToMinimap 的逆变换', () => {
      const contentBounds: WorldBounds = { x: 100, y: 200, width: 800, height: 600 };
      const scaleRatio = 0.2;
      const minimapWidth = 300;
      const minimapHeight = 200;
      
      const worldPoint = { x: 500, y: 400 };
      
      // 正变换
      const minimapPoint = service.worldToMinimap(
        worldPoint,
        contentBounds,
        scaleRatio,
        minimapWidth,
        minimapHeight
      );
      
      // 逆变换
      const backToWorld = service.minimapToWorld(
        minimapPoint,
        contentBounds,
        scaleRatio,
        minimapWidth,
        minimapHeight
      );
      
      expect(backToWorld.x).toBeCloseTo(worldPoint.x, 5);
      expect(backToWorld.y).toBeCloseTo(worldPoint.y, 5);
    });
  });
  
  describe('calculateMinimapState', () => {
    it('应返回完整的小地图状态', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 800 };
      const viewportBounds: WorldBounds = { x: 100, y: 100, width: 400, height: 300 };
      
      const state = service.calculateMinimapState(
        contentBounds,
        viewportBounds,
        200,
        150,
        0.1
      );
      
      expect(state.scaleRatio).toBeGreaterThan(0);
      expect(state.indicator).toBeDefined();
      expect(state.indicator.width).toBeGreaterThan(0);
      expect(state.indicator.height).toBeGreaterThan(0);
      expect(state.contentBounds).toBeDefined();
    });
    
    it('视口指示器尺寸应与视口/内容比例成正比', () => {
      const contentBounds: WorldBounds = { x: 0, y: 0, width: 1000, height: 1000 };
      const smallViewport: WorldBounds = { x: 0, y: 0, width: 200, height: 200 };
      const largeViewport: WorldBounds = { x: 0, y: 0, width: 500, height: 500 };
      
      const smallState = service.calculateMinimapState(
        contentBounds,
        smallViewport,
        200,
        200,
        0
      );
      
      const largeState = service.calculateMinimapState(
        contentBounds,
        largeViewport,
        200,
        200,
        0
      );
      
      // 大视口的指示器应该更大
      expect(largeState.indicator.width).toBeGreaterThan(smallState.indicator.width);
    });
  });
  
  describe('unionBounds', () => {
    it('应合并两个边界框', () => {
      const bounds1: WorldBounds = { x: 0, y: 0, width: 100, height: 100 };
      const bounds2: WorldBounds = { x: 50, y: 50, width: 100, height: 100 };
      
      const result = service.unionBounds(bounds1, bounds2);
      
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.width).toBe(150); // 0 到 150
      expect(result.height).toBe(150);
    });
    
    it('不相交的边界框应正确合并', () => {
      const bounds1: WorldBounds = { x: 0, y: 0, width: 50, height: 50 };
      const bounds2: WorldBounds = { x: 100, y: 100, width: 50, height: 50 };
      
      const result = service.unionBounds(bounds1, bounds2);
      
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
      expect(result.width).toBe(150); // 0 到 150
      expect(result.height).toBe(150);
    });
  });
  
  describe('clampIndicatorPosition', () => {
    it('应限制指示器在边界内', () => {
      const position = { x: -10, y: -10 };
      const indicatorWidth = 50;
      const indicatorHeight = 50;
      
      const result = service.clampIndicatorPosition(
        position,
        indicatorWidth,
        indicatorHeight,
        200,  // minimapWidth
        150   // minimapHeight
      );
      
      // 应该被限制到半宽/半高（中心点边界）
      expect(result.x).toBe(25);  // halfWidth
      expect(result.y).toBe(25);  // halfHeight
    });
    
    it('边界内的位置应保持不变', () => {
      const position = { x: 100, y: 75 };  // 中心位置
      const indicatorWidth = 40;
      const indicatorHeight = 30;
      
      const result = service.clampIndicatorPosition(
        position,
        indicatorWidth,
        indicatorHeight,
        200,  // minimapWidth
        150   // minimapHeight
      );
      
      expect(result.x).toBe(100);
      expect(result.y).toBe(75);
    });
  });
});
