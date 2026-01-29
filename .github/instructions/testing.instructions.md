---
applyTo: "**/*.spec.ts,**/*.test.ts,e2e/**"
---
# Testing Standards

## Test Organization

### 文件结构
```
src/
├── services/
│   ├── task.service.ts
│   └── task.service.spec.ts    # 同目录
e2e/
├── critical-paths.spec.ts
└── sync-integrity.spec.ts
```

### 命名约定
- 单元测试: `*.spec.ts`
- E2E 测试: `e2e/*.spec.ts`
- 纯函数测试: `*.test.ts`

## Vitest (Unit Tests)

### 配置分层
- `vitest.config.mts` - 主配置
- `vitest.pure.config.mts` - 纯函数测试
- `vitest.services.config.mts` - 服务测试
- `vitest.components.config.mts` - 组件测试

### 测试结构
```typescript
describe('ServiceName', () => {
  // Arrange
  beforeEach(() => {
    // 设置
  });

  it('should do something when condition', () => {
    // Arrange
    const input = ...;
    
    // Act
    const result = service.method(input);
    
    // Assert
    expect(result).toBe(expected);
  });
});
```

### Mock 策略
```typescript
// 使用 vi.mock 模拟依赖
vi.mock('@services/supabase', () => ({
  supabase: mockSupabase
}));
```

## Playwright (E2E Tests)

### 结构
```typescript
test.describe('Feature', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('user can complete action', async ({ page }) => {
    await page.click('[data-testid="button"]');
    await expect(page.locator('[data-testid="result"]'))
      .toBeVisible();
  });
});
```

### 选择器优先级
1. `data-testid` (推荐)
2. 语义化角色 `role`
3. 文本内容
4. CSS 选择器 (最后手段)

### 等待策略
```typescript
// ✅ 推荐
await page.waitForSelector('[data-testid="loaded"]');
await expect(element).toBeVisible({ timeout: 10000 });

// ❌ 避免
await page.waitForTimeout(3000);
```

## 测试原则

### 覆盖策略
- 关键路径 100% 覆盖
- 边界条件测试
- 错误路径测试

### 隔离
- 每个测试独立
- 不依赖执行顺序
- 清理副作用

### 稳定性
- 避免 flaky tests
- 使用确定性数据
- 适当的超时设置
