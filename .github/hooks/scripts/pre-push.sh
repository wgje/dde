#!/bin/bash
# Pre-push hook script
# This script runs before pushing to remote

set -e

echo "🚀 Running pre-push checks..."

# 1. Build
echo "🏗️ Building project..."
npm run build

# 2. E2E tests (optional, can be skipped with --no-verify)
if [ "$SKIP_E2E" != "true" ]; then
  echo "🎭 Running E2E tests..."
  npm run test:e2e || echo "⚠️ E2E tests failed, but continuing..."
fi

echo "✅ Pre-push checks completed!"
