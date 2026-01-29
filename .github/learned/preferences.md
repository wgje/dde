# Project Preferences

> 用户偏好和项目约定
> 来源：[everything-claude-code Continuous Learning](https://github.com/affaan-m/everything-claude-code)

## 代码风格偏好

### 注释语言
- **业务逻辑注释**: 中文
- **代码标识符**: 英文
- **文档**: 中文（除 API 文档外）

### 导入顺序
1. Angular 核心模块
2. 第三方库
3. 项目服务（@/services）
4. 项目组件（@/components）
5. 工具函数（@/utils）
6. 类型定义（@/models）

### 文件组织
- 服务文件：不超过 400 行（理想 200-300 行）
- 组件文件：不超过 300 行
- 函数长度：不超过 50 行
- 嵌套深度：不超过 4 层

---

## 命名约定

### 服务命名
```
功能 + Service
例：TaskOperationService, SyncCoordinatorService
```

### 组件命名
```
功能 + Component
例：FlowViewComponent, TextTaskCardComponent
```

### 信号命名
```
名词（复数表示集合）
例：tasks, currentProject, isLoading
```

### 常量命名
```
SCREAMING_SNAKE_CASE
例：SYNC_CONFIG, MAX_RETRY_COUNT
```

---

## 测试偏好

### 测试文件位置
- 单元测试：与源文件同目录，`*.spec.ts`
- 集成测试：`src/tests/integration/`
- E2E 测试：`e2e/`

### Mock 偏好
- Supabase：始终 mock
- IndexedDB：使用 fake-indexeddb
- 网络请求：使用 vi.mock

### 测试命名
```typescript
describe('ServiceName', () => {
  describe('methodName', () => {
    it('should 做什么 when 条件', () => {});
  });
});
```

---

## 工具偏好

### 优先使用的工具
| 任务 | 工具 |
|------|------|
| 搜索代码 | grep_search |
| 理解上下文 | semantic_search |
| 修改代码 | replace_string_in_file |
| 运行命令 | run_in_terminal |
| 查看结构 | list_dir |

### 避免的操作
- ❌ 在终端中编辑文件（用 replace_string_in_file）
- ❌ 猜测文件路径（先用 list_dir 确认）
- ❌ 大段代码块输出（直接编辑文件）

---

## Git 偏好

### 提交消息格式
```
<type>(<scope>): <subject>

类型: feat, fix, docs, style, refactor, test, chore
范围: flow, text, sync, auth, focus 等
```

### 分支命名
```
feature/功能名
fix/问题描述
refactor/重构范围
```

---

## 如何添加新偏好

```markdown
### 偏好名称
描述或表格

示例（可选）
```
