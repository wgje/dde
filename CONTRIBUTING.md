# 贡献指南

感谢你愿意帮助改进 NanoFlow。仓库公开可见，但项目定位仍是个人、多设备工作流；请先通过 Issue 讨论范围，再提交尽量聚焦、易审阅的 Pull Request。

## 从哪里开始

1. 先读 [README](README.md) 了解产品边界，再读[仓库地图](docs/handbook/05-develop-maintain/02-repository-map.md)找到功能入口、状态/服务所有权和验证范围。
2. Bug、功能建议或文档问题请使用仓库的 Issue 模板。模板帮助分类，不代表该方向已承诺排期。
3. 避免同时提交无关重构、生成物、个人日志或本机配置；若问题涉及多个领域，先在 Issue 说明范围和依赖。

## 本地准备

- 使用仓库当前 Node/npm 版本与锁文件。首次安装使用 `npm ci`。
- 从 `.env.template` 准备本机环境；不要提交 `.env*`、服务端密钥、签名材料、真实用户数据或未脱敏日志。
- 当前仓库根目录未发现 `LICENSE`，且 `package.json` 未声明 `license`。请在复用或贡献代码前向维护者确认许可边界；不要仅凭仓库公开可见推断开放源码许可。

## 改动与验证

- 从最新 `main` 建独立分支；不要直接推送到 `main`，通过 PR 请求审阅。
- 优先复用现有服务、Store、配置和测试模式；保持改动范围与 Issue 目标一致。
- Angular 页面遵循 standalone、OnPush 与严格类型；不要用 `any` 隐藏边界问题。
- 离线、同步、认证、存储、备份恢复、Supabase migration/Edge、Android 或数据写入路径属于高风险区域。先沿仓库地图确认完整调用链；不要把 UI 更新当成远端已保存，也不要绕过已有数据保护边界。
- 修改数据路径时，评估客户端生成 ID、owner 隔离、可导出、可恢复、可重放和可解释性；无法证明不回退时，先在 Issue 标注风险和缺失验证。
- 文档只描述已实现且验证的行为；目标方案或未验证能力必须明确标注，不得写成已交付承诺。

按改动选择能直接证明行为的最小验证；常用入口：

```bash
npm run docs:validate
npm run typecheck
npm run lint
npm run test:run -- <focused-spec-path>
```

不适用的命令可以不运行，但请在 PR 中说明原因；涉及同步、迁移、Android、恢复或部署时，增加与风险匹配的场景验证。运行前确认脚本名与当前 `package.json` 保持一致。

## Pull Request

PR 描述请写明：问题与预期、范围、变更路径、验证命令和结果、未运行项及原因、剩余风险/回滚方式。若没有关联 Issue，也请解释背景。不要把其它 worktree 或工作区中的未审阅改动带入 PR。

PR 模板提供检查提醒，不替代维护者审阅、CI、数据安全门禁或发布授权。

## 安全漏洞报告

截至 2026-11-14，仓库已启用 GitHub 私密漏洞报告。请在仓库 **Security（安全）** 页的 **Advisories（公告）** 区域选择 **Report a vulnerability（报告漏洞）**，通过 GitHub 私下提交漏洞报告；提交前请阅读 [安全政策](SECURITY.md)。请勿把漏洞细节、PoC、密钥或个人数据发到公开 Issue、Pull Request 或讨论区。该渠道不构成响应时限或漏洞赏金承诺。
