---
title: 开发环境
status: canonical
audience: contributor, maintainer
last_verified: 2026-07-15
category: develop-maintain
source_paths:
  - README.md
  - package.json
  - .env.template
  - scripts/set-env.cjs
  - scripts/validate-env.cjs
  - scripts/run-ng.cjs
  - scripts/dev-server-port.cjs
  - vitest.config.mts
---

# 开发环境

本页说明怎样准备一个可以安全修改 NanoFlow 的本地环境。目标不是只让开发服务器启动，而是明确当前处于本地离线模式还是云端联调模式，并在改动前用合适的环境检查证明配置没有把问题伪装成应用故障。

## 本文内容

- [环境要求](#环境要求)
- [安装并启动](#安装并启动)
- [环境文件与密钥边界](#环境文件与密钥边界)
- [选择本地离线或云端开发](#选择本地离线或云端开发)
- [首次启动后的验证](#首次启动后的验证)
- [常用命令](#常用命令)
- [什么时候需要本地 Supabase](#什么时候需要本地-supabase)
- [常见准备问题](#常见准备问题)
- [下一步](#下一步)

## 环境要求

- Node.js `>= 22.14.0`；
- 与已提交 lockfile 兼容的 npm；
- 能用于 Angular PWA 测试的浏览器；
- 当改动后端时，可通过仓库包装器调用 Supabase CLI 的环境。

始终从仓库根目录运行命令。npm 脚本会相对根目录生成环境文件、传递 Angular CLI 参数并准备测试环境；在子目录里拼凑命令很容易得到误导性的路径或配置错误。

## 安装并启动

```bash
npm install
npm start
```

`start` 会先准备环境，再通过 `scripts/run-ng.cjs` 启动 Angular。以终端实际打印的 URL 为准，不要假定端口固定。运行器优先使用默认开发端口，端口不可用时会选择可用端口；需要明确端口时使用可移植的覆盖方式：

```bash
npm start -- --port 3000
```

不要把浏览器里旧标签页当作新服务器已经启动的证据。确认终端已完成启动、地址属于刚刚运行的进程，再开始排查页面行为。

## 环境文件与密钥边界

以 `.env.template` 为本地设置参考，真实凭据不要进入已跟踪文件。

浏览器可公开的前端值可以包括：

- Supabase URL；
- Supabase anon key；
- 明确用于浏览器的开发标志。

Secret 应留在 Supabase Secrets、托管平台或本机未跟踪环境文件中。推荐顺序如下：

1. 阅读 `.env.template`，不要把真实凭据直接写进去。
2. 将本地覆盖写入脚本约定的未跟踪环境文件。
3. 运行 `npm run config`，或让 `npm start` / `npm run build` 自动执行环境生成。
4. 排查云端失败前运行 `npm run validate-env`。
5. 生产构建或部署前运行 `npm run validate-env:prod`，把失败视为阻塞条件。

开发和生产的验证意图不同：开发环境在缺少或不一致的云端值时可以继续本地/离线工作；生产验证会拒绝必需云配置缺失，并检测 URL 与旧 anon key 来自不同 Supabase 项目的情况。因此，开发时的一个警告并不说明部署是安全的。

绝不要把 service role、第三方 API key、FCM 私钥或部署令牌写进 `NG_APP_*` 浏览器配置、生成环境文件、源码、示例或测试夹具。准确边界见 [安全与隐私](../03-data-sync-safety/04-security-and-privacy.md)。

## 选择本地离线或云端开发

创建测试数据前先做选择：

| 你在改什么 | 安全起点 | 原因 |
| --- | --- | --- |
| 文本/Flow UI、本地持久化，以及多数孤立服务或组件 | 本地离线开发 | 可以验证离线优先 UI，不会影响真实云端项目 |
| 登录、RLS、迁移、Storage、Edge Function、跨设备同步或真实附件上传 | 云端联调，优先使用可丢弃或本地 Supabase 项目 | 这些路径依赖真实认证、数据行、策略、bucket 或函数 Secret |
| 生产配置审查 | 不暴露秘密的生产环境校验 | 能在构建/部署前发现必需配置和项目配对错误 |

本地离线模式是有效的开发路径，不是失败的云端配置。它不能证明登录、RLS、上传、Edge Function 或另一台设备能看到改动。测试数据在明确切换到云端联调前应保持小且可丢弃。

## 首次启动后的验证

依赖安装完成后，按下面顺序证明环境可用：

1. 运行 `npm start`，打开终端打印的精确本地 URL。
2. 只创建测试项目和测试任务，修改标题并刷新，确认本地持久化。
3. 运行 `npm run validate-env`，阅读警告而不是忽略它们；云端联调时先修正 URL/anon-key 项目不匹配再测试同步。
4. 为计划的改动选最窄验证。无代码的环境冒烟可从 `npm run docs:validate` 和 [测试与质量](03-testing-and-quality.md) 列出的聚焦测试开始。
5. 使用真实数据或共享云端项目之前，确认当前账号、项目别名和部署目标。不要把生产 Supabase 项目当作迁移或破坏性恢复测试的沙箱。

若固定端口、生成环境文件或云端值有变化，重启相关开发进程。已打开的浏览器标签和正在运行的服务器不会追溯加载磁盘上的每一处配置。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动本地开发服务器 |
| `npm run build` | 正常部署使用的生产构建路径 |
| `npm run build:strict` | 带生产环境校验的严格构建 |
| `npm run validate-env` | 本地配置检查；允许离线开发的场景会给出警告 |
| `npm run validate-env:prod` | 生产配置检查；必需云端错误会阻塞 |
| `npm run test:prepare-env` | 直接运行 Vitest 前生成或保留测试环境文件 |
| `npm run test:run` | 本地默认测试矩阵 |
| `npm run lint` | 对 `src` 运行 ESLint |
| `npm run docs:human:validate` | 校验真人手册 |
| `npm run docs:context7:validate` | 校验机器可读文档 |

## 什么时候需要本地 Supabase

修改下列内容时使用本地 Supabase：

- migration；
- RLS；
- Edge Function；
- 生成数据库类型；
- 依赖真实云端数据行的同步行为。

纯 UI、本地持久化和许多服务测试不要求运行本地 Supabase。使用仓库包装器而不是任意全局 CLI，这样命令和版本会与项目脚本保持一致：

```bash
npm run supabase:status
npm run supabase:start
npm run supabase:stop
```

不要针对未知项目执行数据库 reset、迁移 push、函数 deploy 或 Secret 设置。先确认 linked project 和当前凭据，再做备份或改用可丢弃环境。高风险步骤见 [Supabase 运维](../04-deploy-operate/02-supabase-operations.md) 与 [Edge Functions](../04-deploy-operate/03-edge-functions.md)。

## 常见准备问题

| 现象 | 先检查 | 安全的下一步 |
| --- | --- | --- |
| `npm install` 失败 | Node.js 大版本、当前目录、registry 访问 | 修复环境；不要只为绕过安装而重写 lockfile |
| `npm start` 使用了不同端口 | 终端输出和现有开发服务器 | 使用打印的 URL 或传递 `-- --port`；只停止自己拥有的进程 |
| 应用能打开但云同步一直停在本地 | `npm run validate-env`、账号状态、URL/anon-key 项目配对 | 在配置修好前按本地/离线处理；不要制造重复云端数据 |
| 生产验证失败 | `validate-env:prod` 的精确缺失/无效变量 | 在正确的服务端或浏览器边界修正配置，再运行验证 |
| 测试尚未进入应用逻辑就失败 | 测试环境准备和具体测试分组命令 | 运行 `npm run test:prepare-env` 后重跑聚焦命令；不要盲改生成文件 |
| 修改配置后浏览器仍显示旧行为 | 服务器和页面是否都已重启 | 重启目标开发进程，并重新加载正确 URL 后再改源码 |

## 下一步

- 用 [仓库地图](02-repository-map.md) 找到代码所有权。
- 用 [测试与质量](03-testing-and-quality.md) 选择验证命令。
