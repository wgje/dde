#!/bin/bash
# Pre-push hook script
# This script runs before pushing to remote

set -e

echo "🚀 Running pre-push checks..."

# 1. Lint
echo "🔍 Running lint..."
npm run lint

# 2. Fast test gate
echo "🧪 Running fast test gate..."
npm run test:run:fast

# 3. Build
echo "🏗️ Building project..."
npm run build

echo "✅ Pre-push checks completed!"
