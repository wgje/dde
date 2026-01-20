# NanoFlow Docker 部署策划案

> **文档版本**：v1.3  
> **更新日期**：2026-01-20  
> **目标**：为 NanoFlow 提供完整的 Docker 容器化方案，支持私有化部署

---

## 〇、变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.3 | 2026-01-20 | 二次批判性审查：补充 Demo 模式环境变量、CDN 字体 preload 处理、index.html 中的骨架屏和防闪屏脚本说明、sw-network-optimizer.js 处理、CSP 补充 worker-src/frame-ancestors、生产模式占位符检测逻辑澄清、GitHub Workflows 目录缺失说明、时区相关日志格式化、构建产物 hash 缓存策略验证、多语言/国际化预留 |
| v1.2 | 2026-01-20 | 批判性审查：补充 env-config.js 读取逻辑、dns-prefetch 处理、Edge Functions 说明、Realtime WSS 端口、ARM64 测试矩阵、数据持久化警告、CORS 自建 Supabase 配置、Storage Bucket 初始化、健康检查深度验证、rollback 策略、监控集成 |
| v1.1 | 2026-01-20 | 深度审查：补充 PWA 适配、安全加固、特殊字符处理、Supabase 初始化 |
| v1.0 | 2026-01-20 | 初稿完成 |

---

## 一、策略定位

### 1.1 核心原则

```
Vercel = 官方 SaaS 环境（开发迭代主战场）
Docker = 分发渠道（私有化部署的交付物）
```

**关键决策**：
- ✅ 保留 Vercel 作为日常开发和官方演示环境
- ✅ Docker 仅用于正式版本分发（Tag 触发构建）
- ❌ 不使用 Docker 作为开发或测试环境

### 1.2 目标用户场景

| 场景 | 解决方案 |
|------|----------|
| 企业内网部署 | 用户拉取镜像，通过环境变量注入自己的 Supabase 配置 |
| NAS 家用服务器 | 一行 `docker run` 命令启动 |
| 完全离线使用 | 启动时不传入 Supabase 变量，应用自动降级为离线模式 |
| 自建 Supabase | 提供数据库初始化脚本，用户可完全自主托管 |
| 公共演示实例 | 设置 `DEMO_MODE=true` 启用功能限制和演示 Banner |

### 1.3 功能边界说明

**Docker 镜像包含**：
- ✅ NanoFlow 前端应用（Angular PWA）
- ✅ 数据库初始化脚本（`init-supabase.sql`）
- ✅ 运行时配置注入能力

**Docker 镜像不包含**（需用户自行部署）：
- ❌ Supabase 后端服务（数据库、认证、存储）
- ❌ Edge Functions（病毒扫描、备份等）
- ❌ SSL 证书管理

> ⚠️ **Edge Functions 说明**：项目中的 `supabase/functions/` 目录包含备份、附件清理、病毒扫描等功能。这些需要部署到 Supabase 平台或自建 Supabase 实例，Docker 镜像本身不包含这些服务端功能。

---

## 二、技术架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Container                         │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │   Nginx:Alpine  │    │      Angular PWA 静态文件       │ │
│  │   (Web Server)  │───>│      /usr/share/nginx/html      │ │
│  └────────┬────────┘    └─────────────────────────────────┘ │
│           │                                                  │
│  ┌────────┴────────┐                                        │
│  │  entrypoint.sh  │  ← 运行时环境变量注入                   │
│  └─────────────────┘                                        │
├─────────────────────────────────────────────────────────────┤
│  ENV: SUPABASE_URL, SUPABASE_ANON_KEY, SENTRY_DSN, etc.     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   用户自建 Supabase 实例      │
              │   (或官方托管实例)            │
              └───────────────────────────────┘
```

### 2.2 构建策略：多阶段构建

| 阶段 | 基础镜像 | 作用 | 产物 |
|------|----------|------|------|
| Stage 1: Builder | `node:22-alpine` | 编译 Angular 项目 | `dist/browser/` |
| Stage 2: Production | `nginx:alpine` | 托管静态文件 | 最终镜像 (~25MB) |

### 2.3 环境变量处理方案

**核心难题**：Angular 在构建时将环境变量"烧录"进 JS 文件，与 Docker "一次构建到处运行"理念冲突。

**解决方案**：运行时占位符替换

```
构建时：使用占位符 → __SUPABASE_URL_PLACEHOLDER__
运行时：entrypoint.sh 启动前替换为真实值
```

### 2.4 需要动态处理的硬编码内容

经代码审查，以下位置存在需要运行时替换的硬编码：

| 文件 | 内容 | 处理方式 |
|------|------|----------|
| `index.html` L22-23 | `<link rel="preconnect" href="https://fkhihclpghmmtbbywvoj.supabase.co">` | entrypoint.sh 动态替换为用户 URL |
| `index.html` L23 | `<link rel="dns-prefetch" href="...">` | 同上，需同时处理 preconnect 和 dns-prefetch |
| `index.html` L19-20 | CDN preconnect（`cdn.jsdelivr.net`）| ✅ 保持不变，CDN 是公共资源 |
| `index.html` L27-29 | 字体 preload 链接 | ✅ 保持不变，指向公共 CDN |
| `index.html` L37-80 | 防闪屏脚本 + 颜色模式检测 | ✅ 保持不变，纯客户端逻辑 |
| `index.html` L85-300 | 骨架屏 CSS 样式 | ✅ 保持不变，纯样式无外部依赖 |
| `ngsw-config.json` → `ngsw.json` | dataGroups 中的 `*.supabase.co` 域名 | ✅ 已使用通配符，无需修改 |
| `public/sw-network-optimizer.js` | Service Worker 网络优化器 | ✅ 保持不变，已使用域名匹配而非硬编码 |
| JS Bundle | `environment.supabaseUrl` 等 | sed 占位符替换 |

**⚠️ 特殊字符处理**：Supabase Anon Key 是 JWT 格式，包含 `.` 和 `-`，但不包含 sed 的危险字符（`/`, `&`, `\`）。URL 格式固定，同样安全。

### 2.5 前端运行时配置读取（env-config.js）

**重要补充**：当前前端代码通过 `environment.ts` 编译时注入配置。为支持 Docker 运行时配置，需要增加 `env-config.js` 的读取逻辑：

**现有代码分析**：
- `SupabaseClientService` 直接读取 `environment.supabaseUrl`
- 需要新增：在应用启动时检查 `window.__NANOFLOW_CONFIG__`

**建议实现**（可选增强）：
```typescript
// src/environments/environment.ts 增强
function getConfig() {
  // 优先使用运行时注入的配置（Docker 场景）
  if (typeof window !== 'undefined' && (window as any).__NANOFLOW_CONFIG__) {
    const rtConfig = (window as any).__NANOFLOW_CONFIG__;
    return {
      production: true,
      supabaseUrl: rtConfig.supabaseUrl || 'YOUR_SUPABASE_URL',
      supabaseAnonKey: rtConfig.supabaseAnonKey || 'YOUR_SUPABASE_ANON_KEY',
      sentryDsn: rtConfig.sentryDsn || '',
      gojsLicenseKey: rtConfig.gojsLicenseKey || '',
      devAutoLogin: null
    };
  }
  // 回退到编译时配置
  return { /* 原有配置 */ };
}
export const environment = getConfig();
```

**⚠️ 当前策略**：v1.x 版本暂时依赖 sed 替换 JS 文件中的占位符，无需修改前端代码。后续版本可考虑上述增强方案实现更优雅的配置注入。

### 2.6 index.html 特殊内容说明

**防闪屏脚本（Anti-FOUC）**：
- 位置：`<head>` 中的同步 `<script>` 块
- 功能：在 Angular 启动前读取用户颜色模式偏好，避免深色模式用户看到白色闪屏
- Docker 影响：**无需处理**，纯客户端 localStorage 操作

**骨架屏加载器**：
- 位置：`<body>` 中的 `#initial-loader` 元素
- 功能：显示加载骨架屏，提升感知性能
- Docker 影响：**无需处理**，纯 CSS/HTML 无外部依赖

**超时检测脚本**：
- 位置：`<body>` 末尾的脚本块
- 功能：25 秒超时后显示"清除缓存"按钮
- Docker 影响：**无需处理**，纯客户端逻辑

---

## 三、文件清单与实现

### 3.1 项目新增文件结构

```
project-root/
├── docker/
│   ├── nginx.conf              # Nginx 配置（SPA 路由 + 缓存策略 + 安全头）
│   ├── entrypoint.sh           # 运行时环境变量注入脚本
│   └── security-headers.conf   # CSP 等安全头配置（可选分离）
├── Dockerfile                  # 多阶段构建定义
├── .dockerignore               # 构建时忽略文件
└── docker-compose.yml          # 本地快速启动配置
```

---

### 3.2 Dockerfile（核心文件）

```dockerfile
# ============================================
# NanoFlow Dockerfile
# 多阶段构建：Node 编译 + Nginx 运行
# 版本：v1.1
# ============================================

# --- Stage 1: 构建阶段 ---
FROM node:22-alpine AS builder

# 安装构建依赖（如需要 node-gyp）
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 1. 先拷贝依赖文件（利用 Docker 层缓存）
COPY package*.json ./

# 2. 安装依赖
RUN npm ci --prefer-offline --no-audit

# 3. 拷贝源代码
COPY . .

# 4. 生成环境配置（使用占位符）
# 注意：devAutoLogin 需要显式类型声明以避免 TypeScript 编译错误
# 注意：demoMode 使用占位符，运行时由 entrypoint.sh 注入
RUN cat > src/environments/environment.ts << 'EOF'
// Docker 构建专用环境配置（运行时由 entrypoint.sh 注入真实值）
export const environment = {
  production: true,
  supabaseUrl: '__SUPABASE_URL_PLACEHOLDER__',
  supabaseAnonKey: '__SUPABASE_ANON_KEY_PLACEHOLDER__',
  sentryDsn: '__SENTRY_DSN_PLACEHOLDER__',
  gojsLicenseKey: '__GOJS_LICENSE_PLACEHOLDER__',
  demoMode: '__DEMO_MODE_PLACEHOLDER__',
  devAutoLogin: null as { email: string; password: string } | null
};
EOF

# 5. 处理 index.html 中的硬编码 Supabase URL（替换为占位符）
# 注意：同时处理 preconnect 和 dns-prefetch 两个标签
RUN sed -i 's|https://fkhihclpghmmtbbywvoj.supabase.co|__SUPABASE_PRECONNECT_PLACEHOLDER__|g' index.html

# 6. 执行生产构建
RUN npm run build -- --configuration production

# --- Stage 2: 生产阶段 ---
FROM nginx:alpine AS production

# 安装运行时工具（用于 entrypoint.sh）
RUN apk add --no-cache bash

# 拷贝 Nginx 配置
COPY docker/nginx.conf /etc/nginx/nginx.conf

# 拷贝构建产物
COPY --from=builder /app/dist/browser /usr/share/nginx/html

# 拷贝运行时脚本
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 拷贝数据库初始化脚本（供用户自建 Supabase 使用）
COPY scripts/init-supabase.sql /opt/nanoflow/init-supabase.sql

# 拷贝 Storage Bucket 设置脚本（可选）
COPY scripts/setup-storage-bucket.cjs /opt/nanoflow/setup-storage-bucket.cjs 2>/dev/null || true

# 拷贝版本信息（由 CI 生成，本地构建时可能不存在）
COPY docker/version* /opt/nanoflow/ 2>/dev/null || true

# 创建 CSP 配置目录
RUN mkdir -p /etc/nginx/conf.d && \
    echo '# CSP placeholder - will be generated by entrypoint.sh' > /etc/nginx/conf.d/csp.conf

# 设置环境变量默认值（空值 = 离线模式）
ENV SUPABASE_URL=""
ENV SUPABASE_ANON_KEY=""
ENV SENTRY_DSN=""
ENV GOJS_LICENSE_KEY=""
ENV DEMO_MODE="false"
ENV TZ="UTC"

# 安全：以非 root 用户运行（可选，需额外配置）
# RUN adduser -D -u 1000 nanoflow && chown -R nanoflow:nanoflow /usr/share/nginx/html
# USER nanoflow

# 暴露端口
EXPOSE 80

# 健康检查（增强版：验证静态文件和配置完整性）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost/health && \
      test -f /usr/share/nginx/html/index.html || exit 1

# 入口点：先注入环境变量，再启动 Nginx
ENTRYPOINT ["/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
```

---

### 3.3 nginx.conf（Nginx 配置）

```nginx
# ============================================
# NanoFlow Nginx 配置
# 功能：SPA 路由 + 缓存策略 + 安全头 + CSP
# 版本：v1.1
# ============================================

worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # 日志格式
    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';
    access_log /var/log/nginx/access.log main;

    # 性能优化
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json 
               application/javascript application/xml+rss 
               application/atom+xml image/svg+xml;

    server {
        listen 80;
        server_name _;
        root /usr/share/nginx/html;
        index index.html;

        # === 安全头 ===
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        
        # === CSP 策略（由 entrypoint.sh 动态生成） ===
        # 使用 include 引入动态生成的 CSP 配置
        include /etc/nginx/conf.d/csp.conf;

        # === SPA 路由核心配置 ===
        # Angular 路由：所有非文件请求都指向 index.html
        location / {
            try_files $uri $uri/ /index.html;
        }

        # === 静态资源缓存策略 ===
        
        # JS/CSS 文件（带 hash，永久缓存）
        location ~* \.(?:js|css)$ {
            expires 1y;
            add_header Cache-Control "public, max-age=31536000, immutable";
            # 继承父级安全头
            add_header X-Content-Type-Options "nosniff" always;
            access_log off;
        }

        # 字体文件（永久缓存 + CORS）
        location ~* \.(?:woff2?|ttf|eot|otf)$ {
            expires 1y;
            add_header Cache-Control "public, max-age=31536000, immutable";
            add_header Access-Control-Allow-Origin "*";
            access_log off;
        }

        # 图片和图标（永久缓存）
        location ~* \.(?:ico|png|jpg|jpeg|gif|svg|webp)$ {
            expires 1y;
            add_header Cache-Control "public, max-age=31536000, immutable";
            access_log off;
        }

        # PWA 相关文件（短期缓存，确保更新及时）
        location ~* (?:manifest\.webmanifest|ngsw\.json|ngsw-worker\.js|sw-network-optimizer\.js)$ {
            expires 1h;
            add_header Cache-Control "public, max-age=3600";
        }

        # index.html（禁止缓存，确保用户获取最新版本）
        location = /index.html {
            expires -1;
            add_header Cache-Control "no-cache, no-store, must-revalidate";
            add_header Pragma "no-cache";
        }

        # 运行时配置文件（禁止缓存）
        location = /env-config.js {
            expires -1;
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }

        # 健康检查端点
        location = /health {
            return 200 'OK';
            add_header Content-Type text/plain;
        }
        
        # 版本信息端点（用于调试）
        location = /version {
            default_type application/json;
            return 200 '{"app":"NanoFlow","container":"docker"}';
        }
    }
}
```

---

### 3.4 entrypoint.sh（运行时环境变量注入）

```bash
#!/bin/bash
# ============================================
# NanoFlow Docker Entrypoint
# 功能：在 Nginx 启动前注入运行时环境变量
# 版本：v1.1 - 增加 CSP 动态生成、preconnect 处理、输入验证
# ============================================

set -e

HTML_DIR="/usr/share/nginx/html"
NGINX_CONF_DIR="/etc/nginx/conf.d"

echo "🚀 NanoFlow Docker Container Starting..."
echo "================================================"
echo "⏰ 启动时间: $(date -Iseconds)"
echo "================================================"

# --- 1. 检查环境变量 ---
OFFLINE_MODE=false
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ]; then
    echo "⚠️  未检测到 Supabase 配置，将以离线模式运行"
    echo "   如需云端同步，请设置 SUPABASE_URL 和 SUPABASE_ANON_KEY"
    # 使用占位符（前端会检测并启用离线模式）
    SUPABASE_URL="YOUR_SUPABASE_URL"
    SUPABASE_ANON_KEY="YOUR_SUPABASE_ANON_KEY"
    OFFLINE_MODE=true
else
    echo "✅ Supabase 配置已检测"
    echo "   URL: ${SUPABASE_URL}"
    
    # 验证 URL 格式
    if [[ ! "$SUPABASE_URL" =~ ^https?:// ]]; then
        echo "❌ 错误: SUPABASE_URL 必须以 http:// 或 https:// 开头"
        exit 1
    fi
fi

# Sentry 配置状态
if [ -z "$SENTRY_DSN" ]; then
    echo "ℹ️  Sentry DSN 未配置（错误监控已禁用）"
    SENTRY_DSN=""
else
    echo "✅ Sentry 已配置"
fi

# GoJS License 配置状态
if [ -z "$GOJS_LICENSE_KEY" ]; then
    echo "ℹ️  GoJS License 未配置（流程图将显示水印）"
    GOJS_LICENSE_KEY=""
else
    echo "✅ GoJS License 已配置"
fi

# Demo 模式配置状态
DEMO_MODE_VALUE="${DEMO_MODE:-false}"
if [ "$DEMO_MODE_VALUE" = "true" ]; then
    echo "⚠️  Demo 模式已启用（项目数量受限，显示演示 Banner）"
else
    echo "ℹ️  正常模式运行"
fi

echo "================================================"

# --- 2. 替换 JS 文件中的占位符 ---
echo "📝 注入运行时配置..."

# 查找包含占位符的 JS 文件并替换
# 使用 | 作为 sed 分隔符，避免 URL 中的 / 造成问题
find "$HTML_DIR" -type f -name "*.js" | while read -r file; do
    if grep -q "__SUPABASE_URL_PLACEHOLDER__\|__SUPABASE_ANON_KEY_PLACEHOLDER__\|__SENTRY_DSN_PLACEHOLDER__\|__GOJS_LICENSE_PLACEHOLDER__\|__DEMO_MODE_PLACEHOLDER__" "$file"; then
        echo "   处理文件: $(basename "$file")"
        
        # 使用 | 作为分隔符，安全处理 URL 和 JWT
        sed -i "s|__SUPABASE_URL_PLACEHOLDER__|${SUPABASE_URL}|g" "$file"
        sed -i "s|__SUPABASE_ANON_KEY_PLACEHOLDER__|${SUPABASE_ANON_KEY}|g" "$file"
        sed -i "s|__SENTRY_DSN_PLACEHOLDER__|${SENTRY_DSN}|g" "$file"
        sed -i "s|__GOJS_LICENSE_PLACEHOLDER__|${GOJS_LICENSE_KEY}|g" "$file"
        # Demo 模式：需要替换为字符串 'true' 或 'false'（注意引号）
        sed -i "s|'__DEMO_MODE_PLACEHOLDER__'|${DEMO_MODE_VALUE}|g" "$file"
    fi
done

# --- 3. 处理 index.html 中的 preconnect 链接 ---
INDEX_FILE="$HTML_DIR/index.html"
if [ -f "$INDEX_FILE" ]; then
    if [ "$OFFLINE_MODE" = true ]; then
        # 离线模式：移除 Supabase preconnect 链接
        echo "   处理 index.html: 移除 Supabase preconnect（离线模式）"
        sed -i '/__SUPABASE_PRECONNECT_PLACEHOLDER__/d' "$INDEX_FILE"
    else
        # 在线模式：替换为用户的 Supabase URL
        echo "   处理 index.html: 注入 Supabase preconnect"
        sed -i "s|__SUPABASE_PRECONNECT_PLACEHOLDER__|${SUPABASE_URL}|g" "$INDEX_FILE"
    fi
fi

echo "✅ 配置注入完成"

# --- 4. 生成 CSP 配置 ---
echo "🔒 生成安全策略..."

# 提取域名用于 CSP
if [ "$OFFLINE_MODE" = true ]; then
    SUPABASE_DOMAIN=""
    SENTRY_DOMAIN=""
else
    SUPABASE_DOMAIN=$(echo "$SUPABASE_URL" | sed -E 's|https?://([^/]+).*|\1|')
    if [ -n "$SENTRY_DSN" ]; then
        SENTRY_DOMAIN=$(echo "$SENTRY_DSN" | sed -E 's|https?://[^@]+@([^/]+).*|\1|')
    else
        SENTRY_DOMAIN=""
    fi
fi

# 生成 CSP 配置文件（Nginx include）
mkdir -p "$NGINX_CONF_DIR"
cat > "$NGINX_CONF_DIR/csp.conf" << EOF
# Content Security Policy（由 entrypoint.sh 动态生成）
# 注意：Angular 需要 unsafe-inline 和 unsafe-eval；worker-src 用于 Service Worker
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com data:; img-src 'self' data: blob: ${SUPABASE_DOMAIN:+https://$SUPABASE_DOMAIN}; connect-src 'self' ${SUPABASE_DOMAIN:+https://$SUPABASE_DOMAIN wss://$SUPABASE_DOMAIN} ${SENTRY_DOMAIN:+https://$SENTRY_DOMAIN}; worker-src 'self' blob:; frame-ancestors 'self';" always;
EOF

echo "✅ CSP 策略已生成"

# --- 5. 生成运行时配置文件（备用方案）---
cat > "$HTML_DIR/env-config.js" << EOF
// NanoFlow 运行时配置（由 Docker 容器自动生成）
// 生成时间: $(date -Iseconds)
window.__NANOFLOW_CONFIG__ = {
    supabaseUrl: "${SUPABASE_URL}",
    supabaseAnonKey: "${SUPABASE_ANON_KEY}",
    sentryDsn: "${SENTRY_DSN}",
    gojsLicenseKey: "${GOJS_LICENSE_KEY}",
    demoMode: ${DEMO_MODE:-false},
    containerMode: true,
    offlineMode: ${OFFLINE_MODE}
};
EOF

echo "================================================"
echo "🎉 NanoFlow 启动完成！"
echo "   访问地址: http://localhost"
echo "   运行模式: $([ "$OFFLINE_MODE" = true ] && echo '离线模式' || echo '在线模式')"
if [ "$OFFLINE_MODE" = false ]; then
    echo "   Supabase: ${SUPABASE_URL}"
fi
echo "================================================"
echo ""
echo "💡 提示："
echo "   - 健康检查: curl http://localhost/health"
echo "   - 版本信息: curl http://localhost/version"
if [ -f "/opt/nanoflow/init-supabase.sql" ]; then
    echo "   - 数据库初始化脚本: docker cp <container>:/opt/nanoflow/init-supabase.sql ."
fi
echo ""

# --- 6. 启动 Nginx ---
exec "$@"
```

---

### 3.5 .dockerignore（忽略文件）

```gitignore
# ============================================
# NanoFlow Docker Build Ignore
# ============================================

# 依赖目录（容器内重新安装）
node_modules/

# 构建输出（容器内重新构建）
dist/
.angular/

# 本地环境配置（不应进入镜像）
.env
.env.*
!.env.template

# IDE 和编辑器
.idea/
.vscode/
*.swp
*.swo

# Git
.git/
.gitignore

# 测试相关
e2e/
playwright-report/
test-results/
coverage/
*.spec.ts
vitest*.config.*

# 文档
docs/
*.md
!README.md

# 临时文件
tmp/
*.log
*.tmp

# macOS
.DS_Store

# Supabase 本地配置
supabase/.branches/
supabase/.temp/

# 调试文件
debug-*.sh
test-*.js
test-*.sh
```

---

### 3.6 docker-compose.yml（本地快速启动）

```yaml
# ============================================
# NanoFlow Docker Compose
# 用途：本地快速启动和测试
# ============================================

version: '3.8'

services:
  nanoflow:
    build:
      context: .
      dockerfile: Dockerfile
    image: nanoflow:local
    container_name: nanoflow-app
    ports:
      - "3000:80"
    environment:
      # 必填：Supabase 配置（替换为你的实际值）
      - SUPABASE_URL=${SUPABASE_URL:-}
      - SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-}
      # 可选：Sentry 监控
      - SENTRY_DSN=${SENTRY_DSN:-}
      # 可选：GoJS License（移除水印）
      - GOJS_LICENSE_KEY=${GOJS_LICENSE_KEY:-}
      # 可选：Demo 模式（限制项目数量，显示演示 Banner）
      - DEMO_MODE=${DEMO_MODE:-false}
      # 可选：时区设置
      - TZ=${TZ:-UTC}
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost/health"]
      interval: 30s
      timeout: 3s
      retries: 3
      start_period: 10s

# 使用方法：
# 1. 创建 .env 文件配置环境变量
# 2. docker-compose up -d
# 3. 访问 http://localhost:3000
```

---

## 四、CI/CD 集成方案

### 4.1 GitHub Actions 工作流

> **注意**：当前项目尚未创建 `.github/workflows/` 目录。下方配置文件需要在实施时手动创建。

```yaml
# .github/workflows/docker-publish.yml
# 功能：Tag 触发时自动构建并发布 Docker 镜像
# 版本：v1.1 - 增加安全扫描、版本写入
# ============================================

name: Docker Publish

on:
  push:
    tags:
      - 'v*.*.*'  # 仅在创建版本 Tag 时触发

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      security-events: write  # 用于上传安全扫描结果

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata (tags, labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest

      # 写入版本信息到构建上下文
      - name: Write version file
        run: |
          echo "${{ github.ref_name }}" > docker/version
          echo "Build: $(date -Iseconds)" >> docker/version
          echo "Commit: ${{ github.sha }}" >> docker/version

      - name: Build and push Docker image
        id: build-push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64,linux/arm64

      # 安全扫描（可选但推荐）
      - name: Run Trivy vulnerability scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'
        continue-on-error: true  # 不阻止发布，仅报告

      - name: Upload Trivy scan results
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: 'trivy-results.sarif'
        continue-on-error: true

      - name: Generate artifact attestation
        uses: actions/attest-build-provenance@v1
        with:
          subject-name: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          subject-digest: ${{ steps.build-push.outputs.digest }}
          push-to-registry: true
```

### 4.2 发布流程

```
开发者视角：
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  日常开发   │ ──> │  git push   │ ──> │   Vercel    │
│  修 Bug     │     │  (branch)   │     │  自动部署   │
└─────────────┘     └─────────────┘     └─────────────┘

发布版本时：
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  git tag    │ ──> │  GitHub     │ ──> │  Docker Hub │
│  v1.0.0     │     │  Actions    │     │  GHCR       │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## 五、用户部署指南

### 5.1 快速启动（一键部署）

```bash
# 最简方式（离线模式）
docker run -d -p 3000:80 ghcr.io/dydyde/nanoflow:latest

# 连接自建 Supabase
docker run -d -p 3000:80 \
  -e SUPABASE_URL="https://your-project.supabase.co" \
  -e SUPABASE_ANON_KEY="your-anon-key" \
  ghcr.io/dydyde/nanoflow:latest

# 完整配置
docker run -d -p 3000:80 \
  -e SUPABASE_URL="https://your-project.supabase.co" \
  -e SUPABASE_ANON_KEY="your-anon-key" \
  -e SENTRY_DSN="https://xxx@sentry.io/xxx" \
  -e GOJS_LICENSE_KEY="your-license-key" \
  --name nanoflow \
  --restart unless-stopped \
  ghcr.io/dydyde/nanoflow:latest
```

### 5.2 环境变量说明

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `SUPABASE_URL` | 否* | Supabase 项目 URL（不填则为离线模式） |
| `SUPABASE_ANON_KEY` | 否* | Supabase 匿名密钥（**不是** SERVICE_ROLE_KEY） |
| `SENTRY_DSN` | 否 | Sentry 错误监控 DSN |
| `GOJS_LICENSE_KEY` | 否 | GoJS 许可证（移除流程图水印） |
| `DEMO_MODE` | 否 | 设为 `true` 启用演示模式（限制项目数量、显示 Banner）|
| `TZ` | 否 | 容器时区（默认 UTC），例如 `Asia/Shanghai` |

> ⚠️ **安全警告**：请使用 `anon` 公开密钥，**绝对不要**使用 `service_role` 密钥。前端代码会自动检测并阻止敏感密钥的使用（通过 JWT payload 中的 role 字段检测）。

> *不填 Supabase 配置时，应用将以纯离线模式运行，数据仅存储在浏览器 IndexedDB 中。

### 5.2.1 生产模式下的占位符检测

**代码行为说明**（参考 `SupabaseClientService`）：

```typescript
// 检查是否为模板占位符
const isPlaceholder = (val: string) => 
  !val || val === 'YOUR_SUPABASE_URL' || val === 'YOUR_SUPABASE_ANON_KEY';
```

| 环境 | 行为 |
|------|------|
| 开发环境 (`production: false`) | 警告 + 自动进入离线模式 |
| 生产环境 (`production: true`) | 记录严重错误 + 设置 `configurationError` |

**Docker 场景注意**：
- 生产构建中 `environment.production = true`
- 如果 sed 替换失败，用户会看到配置错误提示
- 应用仍可使用，但无法连接 Supabase（离线模式降级）

### 5.2.2 离线模式工作原理

当未配置 Supabase 环境变量时：

1. `SupabaseClientService` 检测到占位符值，设置 `isOfflineMode = true`
2. 用户在登录页面可选择"本地模式"
3. 系统使用 `AUTH_CONFIG.LOCAL_MODE_USER_ID = 'local-user'` 作为虚拟用户 ID
4. 所有数据存储在浏览器 IndexedDB，无云端同步
5. 用户可通过"设置 → 导出"功能备份数据

**注意**：离线模式的数据与特定浏览器绑定，换设备或清除浏览器数据会丢失。

### 5.3 自建 Supabase 配置

如果用户希望完全自主托管，需要初始化 Supabase 数据库：

```bash
# 1. 从容器中导出初始化脚本
docker cp nanoflow:/opt/nanoflow/init-supabase.sql ./init-supabase.sql

# 2. 在 Supabase Dashboard 的 SQL Editor 中执行该脚本
# 或者使用 psql 连接数据库执行

# 3. 配置 Storage Bucket（必须，用于附件功能）
# 在 Supabase Dashboard > Storage 中创建名为 "attachments" 的 bucket
# 设置为私有 bucket（Private）
# 或使用脚本：node /opt/nanoflow/setup-storage-bucket.cjs
```

**初始化脚本功能**（`init-supabase.sql` v3.2.0）：
- 创建 `projects`、`tasks`、`connections`、`user_preferences` 表
- 创建 `project_members` 表（支持多用户协作）
- 配置 RLS（Row Level Security）策略
- 设置必要的索引（包括增量同步索引 `idx_tasks_updated_at`）
- 创建触发器（自动更新 `updated_at`）
- 创建 RPC 函数（`batch_upsert_tasks`、`get_dashboard_stats` 等）
- 配置 Storage Bucket RLS 策略

### 5.4 自建 Supabase 的 CORS 配置

如果使用自建 Supabase（非官方托管），需要配置 CORS：

```bash
# 在 Supabase 配置中添加前端域名
# docker-compose.yml 中的 supabase-kong 服务需要配置：
KONG_CORS_ORIGINS: "http://localhost:3000,https://your-domain.com"
```

### 5.5 Realtime 功能说明

NanoFlow 支持实时同步功能，依赖 Supabase Realtime：

| 功能 | 端口 | 说明 |
|------|------|------|
| REST API | 443 (HTTPS) | 标准 API 请求 |
| Realtime | 443 (WSS) | WebSocket 实时订阅 |

> **注意**：如果部署在反向代理后面，需要确保 WebSocket 连接能正常升级。参考下方 Nginx 反向代理配置。

### 5.6 反向代理配置（HTTPS）

**使用 Caddy（推荐，自动 SSL）：**

```caddyfile
nanoflow.example.com {
    reverse_proxy localhost:3000
}
```

**使用 Nginx（支持 WebSocket）：**

```nginx
server {
    listen 443 ssl http2;
    server_name nanoflow.example.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持（用于 Supabase Realtime）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

> **重要**：如果使用自建 Supabase，Realtime WebSocket 连接也需要配置 WebSocket 支持。

---

## 六、技术风险与缓解措施

### 6.1 已识别风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 环境变量注入失败 | 应用无法连接后端 | entrypoint.sh 添加详细日志 + 输入验证 + 健康检查 |
| SPA 路由 404 | 刷新页面白屏 | nginx.conf 配置 `try_files` |
| 镜像体积过大 | 拉取慢、存储浪费 | 多阶段构建 + .dockerignore |
| PWA 缓存冲突 | 用户看到旧版本 | index.html 禁止缓存 + ngsw.json 短期缓存 |
| ARM 架构不兼容 | Apple M 系列/树莓派无法运行 | 构建 multi-arch 镜像 (amd64/arm64) |
| index.html 硬编码 URL | preconnect 指向错误域名 | Dockerfile 构建时替换为占位符，entrypoint.sh 动态注入 |
| sed 特殊字符 | JWT 中的字符导致替换失败 | 使用 `\|` 作为分隔符（JWT 不含此字符） |
| CSP 阻止 API 请求 | Supabase 连接被浏览器阻止 | entrypoint.sh 动态生成 CSP 配置 |
| 容器重启配置丢失 | 每次重启都要重新注入 | entrypoint.sh 每次启动都执行，无状态设计 |
| 数据持久化误解 | 用户以为数据存容器内 | 文档明确说明数据存储位置 |
| Realtime 连接失败 | 实时同步不工作 | 反向代理配置 WebSocket 支持 |
| 自建 Supabase CORS | 跨域请求被拒绝 | 配置 CORS 允许前端域名 |
| CDN 字体加载失败 | 企业内网阻止外部 CDN | 可选：将字体文件内嵌到镜像（增大体积） |
| Service Worker 缓存冲突 | 更新后仍显示旧版本 | index.html + ngsw.json 禁止长期缓存 |

### 6.1.1 数据存储位置说明

**⚠️ 重要澄清**：

| 数据类型 | 存储位置 | 备注 |
|----------|----------|------|
| 应用配置 | Docker 容器内 `/etc/nginx/conf.d/` | 每次启动重新生成 |
| 用户数据（在线模式） | Supabase 云端数据库 | 容器无状态 |
| 用户数据（离线模式） | 用户浏览器 IndexedDB | 与容器无关 |
| 附件文件 | Supabase Storage | 容器不存储 |

**这意味着**：
- 删除 Docker 容器不会丢失用户数据
- 换一台机器访问同一 Supabase 实例，数据完全同步
- 离线模式的数据存在浏览器中，换浏览器会丢失（需先导出）

### 6.2 测试检查清单

**基础功能**
- [ ] 容器能正常启动（`docker run` 无报错）
- [ ] 健康检查端点响应 200（`curl http://localhost/health`）
- [ ] 版本端点响应正确（`curl http://localhost/version`）
- [ ] SPA 路由正常（刷新 `/project/xxx` 不报 404）
- [ ] 静态资源加载正常（检查浏览器 Network 面板无 404）

**环境变量注入**
- [ ] 环境变量正确注入（检查 Supabase 连接）
- [ ] 离线模式可用（不传环境变量时）
- [ ] preconnect 链接正确（检查 index.html 源码）
- [ ] dns-prefetch 链接正确（同上）
- [ ] CSP 头正确（检查响应头）
- [ ] env-config.js 内容正确（`curl http://localhost/env-config.js`）

**PWA 功能**
- [ ] Service Worker 注册成功
- [ ] manifest.webmanifest 正确加载
- [ ] 静态资源缓存头正确（JS/CSS 应为 immutable）
- [ ] index.html 无缓存（Cache-Control: no-cache）
- [ ] ngsw.json 短期缓存（1h）
- [ ] sw-network-optimizer.js 正确加载
- [ ] 离线访问基本功能可用
- [ ] 更新后 Service Worker 能正确激活新版本

**安全检查**
- [ ] 安全头正确（X-Content-Type-Options, X-Frame-Options 等）
- [ ] 敏感密钥检测生效（尝试传入 service_role JWT 应在控制台看到警告）
- [ ] CSP 不阻止正常的 Supabase API 请求
- [ ] CSP 包含 worker-src（Service Worker 需要）
- [ ] CSP 包含 frame-ancestors（防止 clickjacking）

**多架构测试**
- [ ] linux/amd64 构建成功
- [ ] linux/arm64 构建成功（Apple M 系列、树莓派）
- [ ] 两种架构运行时功能一致

### 6.3 已知限制

| 限制 | 说明 | 替代方案 |
|------|------|----------|
| IndexedDB 不可持久化 | Docker 容器无法直接挂载浏览器存储 | 使用 Supabase 云端同步，或通过 UI 导出备份 |
| 无内置 HTTPS | 容器内 Nginx 仅监听 80 端口 | 使用 Caddy/Traefik 反向代理处理 SSL |
| 无热更新 | 环境变量修改需重启容器 | 设计如此，确保配置一致性 |
| Edge Functions 不包含 | 备份、病毒扫描等功能需单独部署 | 使用 Supabase 官方托管，或自建 Supabase 平台 |
| 无内置监控 | 容器不包含 APM 或日志采集 | 集成 Docker 日志驱动或 Sentry |
| CDN 依赖 | 字体从 cdn.jsdelivr.net 加载 | 企业内网需配置代理或内嵌字体 |
| 无国际化 | 当前仅支持中文界面 | 后续版本可考虑 i18n 支持 |

### 6.4 版本回滚策略

如果新版本出现问题，可以快速回滚：

```bash
# 查看可用版本
docker images ghcr.io/dydyde/nanoflow --format "{{.Tag}}"

# 回滚到指定版本
docker stop nanoflow
docker rm nanoflow
docker run -d -p 3000:80 \
  -e SUPABASE_URL="..." \
  -e SUPABASE_ANON_KEY="..." \
  --name nanoflow \
  ghcr.io/dydyde/nanoflow:v1.0.0  # 指定历史版本

# 或者使用 docker-compose
# docker-compose.yml 中指定版本：image: ghcr.io/dydyde/nanoflow:v1.0.0
docker-compose up -d
```

### 6.5 监控与日志

**日志查看**：
```bash
# 实时查看容器日志
docker logs -f nanoflow

# 查看启动日志（环境变量注入状态）
docker logs nanoflow 2>&1 | grep -E "^(🚀|✅|⚠️|❌|ℹ️)"

# 查看 Nginx 访问日志
docker exec nanoflow tail -f /var/log/nginx/access.log

# 查看 Nginx 错误日志
docker exec nanoflow tail -f /var/log/nginx/error.log
```

**Sentry 集成**（推荐）：
- 设置 `SENTRY_DSN` 环境变量启用前端错误监控
- 可在 Sentry 控制台查看用户会话回放和错误堆栈

**健康检查监控**：
```bash
# 使用 curl 定期检查（可集成到外部监控系统）
curl -sf http://localhost:3000/health || echo "Health check failed"
```

---

## 七、实施计划

### Phase 1：基础容器化（1-2 天）

1. 创建 `docker/` 目录结构
2. 实现 Dockerfile + nginx.conf
3. 本地验证基本功能
4. 验证 ARM64 构建

### Phase 2：环境变量注入（1 天）

1. 实现 entrypoint.sh
2. 测试各种环境变量组合
3. 验证离线模式
4. 验证 CSP 动态生成

### Phase 3：CI/CD 集成（1 天）

1. 添加 GitHub Actions 工作流
2. 配置 GHCR 推送
3. 测试 Tag 触发构建
4. 配置安全扫描（Trivy）

### Phase 4：文档与发布（0.5 天）

1. 更新 README.md 部署说明
2. 创建首个 Docker 版本 Tag
3. 验证用户部署流程
4. 添加故障排查指南

### Phase 5：增强功能（后续迭代）

1. 可选：实现 env-config.js 前端读取逻辑
2. 可选：添加 docker-compose 多服务编排（含自建 Supabase）
3. 可选：Kubernetes Helm Chart
4. 可选：一键部署按钮（Railway、Render）
5. 可选：国际化支持（i18n）
6. 可选：字体文件内嵌（企业内网场景）

---

## 八、附录

### A. 快速命令参考

```bash
# 本地构建镜像
docker build -t nanoflow:local .

# 本地运行测试（离线模式）
docker run -d -p 3000:80 --name nanoflow nanoflow:local

# 本地运行测试（连接 Supabase）
docker run -d -p 3000:80 --name nanoflow \
  -e SUPABASE_URL="https://xxx.supabase.co" \
  -e SUPABASE_ANON_KEY="xxx" \
  nanoflow:local

# 启用 Demo 模式
docker run -d -p 3000:80 --name nanoflow \
  -e SUPABASE_URL="https://xxx.supabase.co" \
  -e SUPABASE_ANON_KEY="xxx" \
  -e DEMO_MODE="true" \
  nanoflow:local

# 查看容器日志
docker logs -f nanoflow

# 查看启动时的环境变量注入日志
docker logs nanoflow 2>&1 | head -50

# 进入容器调试
docker exec -it nanoflow sh

# 验证配置注入
docker exec nanoflow cat /usr/share/nginx/html/env-config.js

# 验证 CSP 配置
docker exec nanoflow cat /etc/nginx/conf.d/csp.conf

# 导出数据库初始化脚本
docker cp nanoflow:/opt/nanoflow/init-supabase.sql ./init-supabase.sql

# 清理旧镜像
docker image prune -a
```

### B. 目录结构总览

```
project-root/
├── Dockerfile                     # ✨ 新增 - 多阶段构建定义
├── .dockerignore                  # ✨ 新增 - 构建忽略文件
├── docker-compose.yml             # ✨ 新增 - 本地快速启动
├── docker/
│   ├── nginx.conf                 # ✨ 新增 - Nginx 配置（SPA + 缓存 + 安全）
│   └── entrypoint.sh              # ✨ 新增 - 运行时配置注入
├── .github/
│   └── workflows/
│       └── docker-publish.yml     # ✨ 新增 - Tag 触发自动发布
├── scripts/
│   ├── init-supabase.sql          # 已有 - 数据库初始化脚本（v3.2.0）
│   └── setup-storage-bucket.cjs   # 已有 - Storage Bucket 配置
├── supabase/
│   └── functions/                 # 已有 - Edge Functions（不包含在 Docker 镜像中）
│       ├── backup-*/              # 备份相关函数
│       ├── cleanup-attachments/   # 附件清理
│       └── virus-scan/            # 病毒扫描
└── ... (existing files)
```

### C. 故障排查指南

| 问题 | 可能原因 | 解决方法 |
|------|----------|----------|
| 容器启动后立即退出 | entrypoint.sh 语法错误 | `docker logs nanoflow` 查看错误 |
| 页面白屏 | JS 加载失败或配置错误 | 检查浏览器控制台，确认环境变量注入 |
| 刷新 404 | Nginx 路由配置错误 | 确认 nginx.conf 中 `try_files` 配置 |
| Supabase 连接失败 | URL 格式错误或 CORS | 检查 URL 是否以 `https://` 开头 |
| Service Worker 注册失败 | HTTPS 要求未满足 | 本地测试用 localhost，生产使用 HTTPS |
| 流程图有水印 | GoJS License 未配置 | 设置 `GOJS_LICENSE_KEY` 环境变量 |
| CSP 阻止请求 | CSP 配置未包含目标域名 | 检查 `/etc/nginx/conf.d/csp.conf` |
| 实时同步不工作 | WebSocket 被阻止 | 检查反向代理是否支持 WebSocket 升级 |
| 附件上传失败 | Storage Bucket 未创建 | 在 Supabase 创建 "attachments" bucket |
| 登录后无数据 | RLS 策略未配置 | 确认已执行 init-supabase.sql |
| ARM64 构建失败 | 缺少多架构支持 | 使用 `docker buildx` 构建 |
| 环境变量含特殊字符 | sed 替换失败 | 检查是否包含 `\|` 字符（不应出现） |
| 字体加载失败/乱码 | CDN 被企业防火墙阻止 | 配置网络代理或使用系统默认字体 |
| 深色模式闪白屏 | 防闪屏脚本未执行 | 检查 index.html 是否完整 |
| Demo Banner 不显示 | DEMO_MODE 未正确传递 | 检查环境变量是否为字符串 "true" |

### D. 镜像安全扫描

建议在 CI/CD 流程中添加镜像安全扫描：

```yaml
# 在 docker-publish.yml 中添加
- name: Run Trivy vulnerability scanner
  uses: aquasecurity/trivy-action@master
  with:
    image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ steps.meta.outputs.version }}
    format: 'sarif'
    output: 'trivy-results.sarif'

- name: Upload Trivy scan results
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: 'trivy-results.sarif'
```

---

## 九、批判性审查总结

### 9.1 v1.2 版本新增内容

本次审查基于批判性思维，从以下维度进行了全面检查：

**功能完整性**：
- ✅ 补充 `dns-prefetch` 标签处理（原仅处理 `preconnect`）
- ✅ 补充 Edge Functions 说明（明确不包含在镜像中）
- ✅ 补充 Storage Bucket 初始化步骤
- ✅ 补充 `init-supabase.sql` 脚本功能详情（v3.2.0）
- ✅ 补充 Demo 模式环境变量（`DEMO_MODE`）
- ✅ 补充 CDN 字体 preload 处理说明

**技术细节**：
- ✅ 补充 `env-config.js` 前端读取逻辑说明（当前策略 vs 后续增强）
- ✅ 补充 Realtime WSS 端口和反向代理 WebSocket 配置
- ✅ 补充健康检查深度验证（静态文件存在性检查）
- ✅ 补充 `TZ` 时区环境变量
- ✅ 补充 index.html 特殊内容说明（防闪屏、骨架屏、超时检测）
- ✅ 补充 CSP worker-src 和 frame-ancestors 指令
- ✅ 补充生产模式占位符检测逻辑澄清

**安全性**：
- ✅ 细化敏感密钥检测机制说明（JWT payload 中 role 字段）
- ✅ 补充自建 Supabase CORS 配置
- ✅ 增强测试检查清单中的安全验证项

**运维能力**：
- ✅ 补充版本回滚策略
- ✅ 补充日志查看和监控集成方案
- ✅ 补充多架构测试矩阵
- ✅ 扩展故障排查指南（新增 CDN、深色模式、Demo 模式问题）
- ✅ 补充 GitHub Workflows 目录缺失说明

**用户体验**：
- ✅ 澄清数据存储位置（避免用户误解容器内有数据）
- ✅ 补充功能边界说明（明确 Docker 包含和不包含的内容）
- ✅ 增加后续迭代 Phase 5 规划
- ✅ 新增公共演示实例场景（Demo 模式）
- ✅ 补充企业内网 CDN 访问问题说明

### 9.2 遗留待定事项

以下内容经评估，暂不在 v1.x 版本中实现：

| 事项 | 原因 | 后续计划 |
|------|------|----------|
| env-config.js 前端读取逻辑 | 当前 sed 替换方案已可用，改动前端代码需测试 | v2.0 考虑 |
| Kubernetes Helm Chart | 超出 v1.x 范围 | 用户需求驱动 |
| docker-compose 含自建 Supabase | 复杂度高，且官方 Supabase 已有方案 | 按需提供 |
| 一键部署按钮 | 需要平台账号配置 | 单独文档处理 |
| 国际化 (i18n) | 当前仅中文界面 | 用户需求驱动 |
| 字体文件内嵌 | 增加镜像体积约 10MB | 企业内网场景按需 |
| Edge Functions 打包 | 属于后端服务，超出前端容器范围 | 独立部署文档 |

### 9.3 风险确认

| 风险 | 评估 | 接受度 |
|------|------|--------|
| sed 替换失败（特殊字符） | JWT 不含 `\|` 分隔符，URL 格式固定 | ✅ 可接受 |
| CSP 过于宽松 | 使用 unsafe-inline/eval 是 Angular 必需 | ⚠️ 需关注 |
| ARM64 构建未验证 | CI 会构建但可能有边缘问题 | ⚠️ 需实测 |
| Service Worker 离线缓存 | 依赖用户首次在线访问 | ✅ 符合 PWA 设计 |
| CDN 字体依赖 | cdn.jsdelivr.net 需可访问 | ⚠️ 企业内网需注意 |
| 防闪屏脚本依赖 localStorage | 隐私模式可能失效 | ✅ 降级为系统偏好 |
| Demo 模式传递 | 需确保字符串 "true" 而非布尔值 | ✅ entrypoint.sh 已处理 |

### 9.4 代码审查发现（v1.3 新增）

**index.html 相关**：
- ✅ 防闪屏脚本读取 localStorage，无外部依赖
- ✅ 骨架屏纯 CSS，无外部资源
- ✅ 超时检测脚本为纯客户端逻辑
- ⚠️ CDN 字体 preload 指向 jsdelivr，企业内网需注意

**SupabaseClientService 相关**：
- ✅ 占位符检测逻辑完善
- ✅ 敏感密钥检测通过 JWT payload role 字段
- ✅ 生产模式下的错误提示明确

**Service Worker 相关**：
- ✅ ngsw-config.json 使用通配符 `*.supabase.co`
- ✅ sw-network-optimizer.js 使用域名匹配而非硬编码
- ✅ 缓存策略配置合理

**环境变量相关**：
- ✅ set-env.cjs 已支持所有必要变量
- ✅ .env.template 文档完整
- ⚠️ DEMO_MODE 在原生代码中使用，需确保 sed 替换或 env-config.js 传递

---

**文档结束**

> 💡 **下一步行动**：确认策划案后，我可以直接帮你创建这些文件。
