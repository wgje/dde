---
name: security-review
description: 安全审查技能，包含 OWASP Top 10 检查清单和常见漏洞模式
triggers:
  - "@security-reviewer"
  - "/security"
---

# Security Review Skill

## 概述

此技能用于执行全面的安全审查，涵盖：
- OWASP Top 10 漏洞检测
- 密钥和凭据扫描
- 依赖漏洞检查
- RLS 策略审查
- 输入验证检查

## 使用方法

### 全面安全审查
```
/security "审查整个项目"
```

### 针对性审查
```
/security "审查认证模块"
@security-reviewer 检查 supabase/functions 的安全性
```

## OWASP Top 10 检查清单

### A01 - Broken Access Control
- [ ] 所有端点都有权限检查
- [ ] RLS 策略正确配置
- [ ] 资源所有权验证
- [ ] CORS 配置正确

### A02 - Cryptographic Failures
- [ ] 敏感数据加密存储
- [ ] 使用 HTTPS
- [ ] 密码使用 bcrypt/argon2 哈希
- [ ] JWT 正确签名和验证

### A03 - Injection
- [ ] SQL 使用参数化查询
- [ ] 输入验证和清理
- [ ] 命令注入防护
- [ ] XSS 防护（输出转义）

### A04 - Insecure Design
- [ ] 业务逻辑验证
- [ ] 速率限制
- [ ] 安全默认值
- [ ] 威胁建模

### A05 - Security Misconfiguration
- [ ] 安全头配置（CSP, HSTS 等）
- [ ] 错误消息不泄露信息
- [ ] 调试模式禁用
- [ ] 默认凭据已更改

### A06 - Vulnerable Components
- [ ] 依赖版本更新
- [ ] 无已知漏洞（npm audit）
- [ ] 许可证合规

### A07 - Authentication Failures
- [ ] 强密码策略
- [ ] MFA 支持
- [ ] Session 管理正确
- [ ] 登录失败限制

### A08 - Software Integrity
- [ ] 完整性验证
- [ ] CI/CD 安全
- [ ] 依赖锁定

### A09 - Logging Failures
- [ ] 安全事件日志
- [ ] 日志不含敏感数据
- [ ] 监控告警配置

### A10 - SSRF
- [ ] URL 验证
- [ ] 白名单机制
- [ ] 内网访问限制

## 常用检测命令

### 依赖漏洞
```bash
npm audit
npm audit --audit-level=high
```

### 密钥扫描
```bash
grep -rn "password\|secret\|api_key\|token" --include="*.ts" --include="*.js" .
```

### 敏感文件
```bash
find . -name "*.env*" -o -name "*.pem" -o -name "*.key"
```

## NanoFlow 项目特定检查

### Supabase RLS
```sql
-- 检查所有表是否启用 RLS
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public';
```

### Edge Function 安全
- [ ] 验证请求来源（Bearer token）
- [ ] API Key 通过 secrets 管理
- [ ] CORS headers 正确设置
- [ ] 输入验证

### 客户端安全
- [ ] 无硬编码密钥
- [ ] 敏感数据不存储在 localStorage
- [ ] XSS 防护（Angular 自动转义）
- [ ] CSRF 防护

## 输出格式

```markdown
# Security Review Report

**日期**: YYYY-MM-DD
**范围**: [审查范围]
**状态**: 🔴 CRITICAL / 🟡 WARNINGS / 🟢 PASSED

## 发现

### 🔴 CRITICAL
1. [漏洞描述]
   - 文件: path/to/file.ts:XX
   - 类型: [OWASP 分类]
   - 修复: [具体修复建议]

### 🟡 WARNINGS
...

### 🟢 PASSED
...

## 建议
1. [建议1]
2. [建议2]
```
