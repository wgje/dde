#!/bin/bash
# Vercel Ignored Build Step
# 只在代码/构建相关文件变更时触发构建，节省 Hobby 免费额度
#
# 退出码约定（Vercel 规范）：
#   exit 0 → 跳过构建（无关键变更）
#   exit 1 → 执行构建（有代码变更或首次部署）

echo "🔍 Vercel Ignore Step: checking if build is necessary..."

# 首次部署或无历史 SHA 时始终构建
PREV_SHA="${VERCEL_GIT_PREVIOUS_SHA}"
if [ -z "$PREV_SHA" ]; then
  echo "⏩ No previous deployment SHA, proceeding with build"
  exit 1
fi

# 确保 PREV_SHA 是可达的（浅克隆可能丢失）
if ! git cat-file -e "$PREV_SHA" 2>/dev/null; then
  echo "⏩ Previous SHA $PREV_SHA not reachable (shallow clone), proceeding with build"
  exit 1
fi

# 只有以下路径的变更才需要触发构建
WATCHED_PATHS=(
  "src/"
  "main.ts"
  "index.html"
  "angular.json"
  "package.json"
  "package-lock.json"
  "vercel.json"
  "ngsw-config.json"
  "postcss.config.cjs"
  "tailwind.config.js"
  "tsconfig.json"
  "public/"
)

if git diff --quiet "$PREV_SHA" HEAD -- "${WATCHED_PATHS[@]}"; then
  echo "⏭️ No changes in watched paths, skipping build"
  echo "   Changed files (non-code):"
  git diff --name-only "$PREV_SHA" HEAD | head -20
  exit 0
else
  echo "🔨 Changes detected in code paths, proceeding with build"
  echo "   Changed watched files:"
  git diff --name-only "$PREV_SHA" HEAD -- "${WATCHED_PATHS[@]}" | head -20
  exit 1
fi
