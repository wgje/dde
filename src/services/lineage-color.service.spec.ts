/**
 * LineageColorService 单元测试
 * 
 * 测试覆盖：
 * - 始祖节点追溯
 * - 家族颜色生成
 * - 图表数据预处理
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LineageColorService } from './lineage-color.service';
import { Task } from '../models';

describe('LineageColorService', () => {
  let service: LineageColorService;
  
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [LineageColorService],
    });
    service = TestBed.inject(LineageColorService);
  });
  
  function createTask(id: string, parentId: string | null = null): Task {
    const now = new Date().toISOString();
    return {
      id,
      title: `Task ${id}`,
      content: '',
      stage: 1,
      parentId,
      order: 0,
      rank: 10000,
      status: 'active',
      x: 100,
      y: 100,
      createdDate: now,
      updatedAt: now,
      displayId: '1',
      deletedAt: null,
    };
  }
  
  describe('generateFamilyColor', () => {
    it('应返回预定义调色板中的颜色', () => {
      const color0 = service.generateFamilyColor(0, 5);
      const color1 = service.generateFamilyColor(1, 5);
      
      expect(color0).toBe('#e63946'); // 第一个预定义颜色
      expect(color1).toBe('#2a9d8f'); // 第二个预定义颜色
    });
    
    it('不同索引应返回不同颜色', () => {
      const colors = new Set<string>();
      for (let i = 0; i < 10; i++) {
        colors.add(service.generateFamilyColor(i, 10));
      }
      expect(colors.size).toBe(10);
    });
    
    it('超出调色板范围时应使用 HSL 生成', () => {
      const color = service.generateFamilyColor(20, 25);
      expect(color).toMatch(/^hsl\(/);
    });
  });
  
  describe('preprocessDiagramData', () => {
    it('单个根节点应正确处理', () => {
      const tasks = [createTask('root')];
      const nodeData = [{ key: 'root', text: 'Root' }];
      const linkData: any[] = [];
      
      const result = service.preprocessDiagramData(nodeData as any, linkData, tasks);
      
      expect(result.nodeDataArray).toHaveLength(1);
      expect(result.nodeDataArray[0].rootAncestorIndex).toBe(0);
      expect(result.nodeDataArray[0].familyColor).toBeDefined();
    });
    
    it('子任务应继承父任务的家族颜色', () => {
      const tasks = [
        createTask('root1', null),
        createTask('child1', 'root1'),
        createTask('grandchild1', 'child1'),
      ];
      const nodeData = [
        { key: 'root1', text: 'Root 1' },
        { key: 'child1', text: 'Child 1' },
        { key: 'grandchild1', text: 'Grandchild 1' },
      ];
      const linkData: any[] = [];
      
      const result = service.preprocessDiagramData(nodeData as any, linkData, tasks);
      
      // 所有节点应该有相同的家族颜色
      const colors = result.nodeDataArray.map(n => n.familyColor);
      expect(new Set(colors).size).toBe(1);
      
      // 所有节点应该有相同的始祖索引
      const indices = result.nodeDataArray.map(n => n.rootAncestorIndex);
      expect(new Set(indices).size).toBe(1);
    });
    
    it('不同家族应有不同颜色', () => {
      const tasks = [
        createTask('root1', null),
        createTask('root2', null),
        createTask('child1', 'root1'),
        createTask('child2', 'root2'),
      ];
      const nodeData = [
        { key: 'root1', text: 'Root 1' },
        { key: 'root2', text: 'Root 2' },
        { key: 'child1', text: 'Child 1' },
        { key: 'child2', text: 'Child 2' },
      ];
      const linkData: any[] = [];
      
      const result = service.preprocessDiagramData(nodeData as any, linkData, tasks);
      
      const root1Color = result.nodeDataArray.find(n => n.key === 'root1')?.familyColor;
      const root2Color = result.nodeDataArray.find(n => n.key === 'root2')?.familyColor;
      const child1Color = result.nodeDataArray.find(n => n.key === 'child1')?.familyColor;
      const child2Color = result.nodeDataArray.find(n => n.key === 'child2')?.familyColor;
      
      // 不同家族颜色不同
      expect(root1Color).not.toBe(root2Color);
      // 同一家族颜色相同
      expect(root1Color).toBe(child1Color);
      expect(root2Color).toBe(child2Color);
    });
    
    it('连线应继承源节点的家族颜色', () => {
      const tasks = [
        createTask('root1', null),
        createTask('root2', null),
      ];
      const nodeData = [
        { key: 'root1', text: 'Root 1' },
        { key: 'root2', text: 'Root 2' },
      ];
      const linkData = [
        { key: 'link1', from: 'root1', to: 'root2' },
      ];
      
      const result = service.preprocessDiagramData(nodeData as any, linkData as any, tasks);
      
      const root1Color = result.nodeDataArray.find(n => n.key === 'root1')?.familyColor;
      const linkColor = result.linkDataArray[0].familyColor;
      
      expect(linkColor).toBe(root1Color);
    });
    
    it('空数据应正常处理', () => {
      const result = service.preprocessDiagramData([], [], []);
      
      expect(result.nodeDataArray).toHaveLength(0);
      expect(result.linkDataArray).toHaveLength(0);
    });
  });
});
