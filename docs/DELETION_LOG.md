# Code Deletion Log

## 2026-03-28 Refactor Session

### Unused Files Deleted
- .tmp/vitest-noiso-bench.mts - 未被任何脚本或配置引用的临时 Vitest 配置
- .tmp/vitest-noiso-restore-only.mts - 未被任何脚本或配置引用的临时 Vitest 配置
- .tmp/vitest-noiso-restore.mts - 未被任何脚本或配置引用的临时 Vitest 配置
- .tmp/vitest.services.lane.mts - 未被任何脚本或配置引用的临时 Vitest 配置
- src/app/features/flow/components/index.ts - 未被引用的 flow 组件 barrel
- src/app/features/flow/index.ts - 未被引用的 flow 特性 barrel
- src/app/features/flow/services/index.ts - 未被引用的 flow 服务 barrel
- src/app/features/flow/services/minimap-math.service.ts - 旧 minimap 数学服务，仅被同批死代码引用
- src/app/features/flow/services/minimap-math.types.ts - 旧 minimap 类型文件，仅被同批死代码引用
- src/app/features/flow/services/reactive-minimap.service.ts - 旧响应式 minimap 服务，仅被同批死代码引用
- src/app/features/flow/types/gojs-data.types.ts - 未被使用的旧 GoJS 数据类型定义
- src/app/features/flow/types/gojs-runtime.ts - 未被使用的旧 GoJS 运行时转换函数
- src/models/gojs-boundary.ts - 未被任何源码引用的旧 GoJS 边界类型文件
- src/app/features/focus/components/black-box/sedimentary-strata-panel.component.ts - 空文件且无引用
- src/app/features/focus/components/strata/strata-item.component.ts - 无引用的 standalone 组件
- src/app/features/parking/index.ts - 未被引用的 parking barrel
- src/app/features/text/index.ts - 未被引用的 text barrel

### Unused Code Removed
- src/app/features/flow/components/flow-view.component.ts - 删除未使用的 ParkingService import
- src/app/features/parking/components/dock-radar-zone.component.ts - 删除未使用的 ComboSector import
- src/utils/startup-trace.ts - 删除未使用的 StartupTracePusher 类型别名

### Cleanup Adjustments
- src/services/dock-cloud-sync.service.ts - 将不会被重新赋值的 remoteRaw 改为 const
- scripts/run-perf-audit-batch.cjs - 删除失效的 eslint-disable 注释
- eslint.config.js - 忽略 .angular、.tmp、tmp、playwright-report、test-results 等生成目录，降低全量扫描误报
- src/models/index.ts - 同步 GoJS 边界注释，避免指向已删除文件
- src/types/gojs-extended.d.ts - 清理对已删除旧 GoJS 边界文件的陈旧注释

### Impact
- Files deleted: 17
- New log files: 1
- Scope: dead files, stale barrels, temporary configs, minor lint cleanup

### Testing
- npm run lint: passed
- npm run build:dev: passed
- npx knip --reporter compact: rerun completed，剩余结果以公共类型导出、脚本入口和部署入口误报为主，未继续自动删除

## 2026-03-29 Deep Cleanup Session

### Unused Files Deleted
- e2e/critical-paths.spec.ts - 已被按关键路径目录拆分后的旧聚合 E2E 文件
- e2e/data-protection.spec.ts - 与现有数据保护/隔离路径重叠的旧 E2E 文件
- e2e/stingy-hoarder-protocol.spec.ts - 无引用且已被现有 focus / parking 路径覆盖的旧 E2E 文件
- src/app/core/state/persistence/types.ts - 仅剩重复类型 re-export 的旧 persistence 类型文件
- src/app/shared/modals/base-modal.component.ts - 已失效的模态框继承基类
- src/config/performance.config.ts - 无消费者的旧性能配置汇总文件

### Unused Exports And Types Removed
- src/config/*, src/models/*, src/services/*, src/utils/*, src/types/* - 收缩零消费者的值导出、类型导出和重复类型别名
- supabase/functions/_shared/backup-utils.ts - 收缩未消费的共享备份工具导出，仅保留实际使用接口
- src/app/features/flow/services/* 与 src/app/features/flow/services/flow-template.types.ts - 清理零引用的事件常量、类型和旧 GoJS / minimap 辅助定义

### Test And Contract Cleanup
- e2e/focus-mode.spec.ts - 重写为与当前 UI 契约一致的 smoke 套件
- e2e/shared/auth-helpers.ts 与相关 critical-path E2E - 对齐当前本地模式/项目进入路径
- src/services/speech-to-text.service.spec.ts、src/services/startup-tier-orchestrator.service.spec.ts、src/utils/startup-trace.spec.ts、src/app/features/flow/components/flow-connection-editor.component.spec.ts、src/app/features/parking/components/parking-dock.component.spec.ts - 修复清理过程中暴露出的测试隔离与过时期望

### Safety Fixes
- src/workspace-shell.component.ts - 调整 Focus 覆盖层挂载门槛，使本地模式和纯离线模式在会话检查完成后也能进入 Spotlight / Focus 路径，而不再错误依赖云端 userId

### Impact
- Current diff deleted files: 23
- Current diff removed lines: 7000+
- Dead-code scan status: npx knip 通过，且无剩余死代码项

### Testing
- npm run lint: passed
- npm run build:dev: passed
- npm run test:run: passed
- npx playwright test e2e/focus-mode.spec.ts --reporter=line: 6 passed