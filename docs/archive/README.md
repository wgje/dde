# docs/archive

本目录用于保存历史取证文件、已完成的审计报告、旧版脚本及恢复前快照，不作为当前实现文档的输入源。

## 目录结构

- `copilot-tracking/` — 历史 Copilot Agent 工作记录（研究、计划、变更日志）
- `legacy-sql/` — 旧版数据库初始化/迁移脚本（已被 `supabase/migrations/` 取代）
- `*-2026-*.md` — 已完成的审计和实施计划报告
- `plan_save.md` — 早期架构策划草案

## 编码相关约束

- `focus-console-design.corrupted-20260228-154326.before-recover-20260228-161303.md` 与 `focus-console-design.corrupted-20260228-154326.md` 均为乱码取证样本。
- 这两份文件保留用于追溯，不参与正常文档维护，也不纳入 BOM 清理。
- 编码门禁脚本 `scripts/contracts/check-encoding-corruption.cjs` 已显式排除此类 `.corrupted*` 样本。
