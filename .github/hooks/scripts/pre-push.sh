#!/bin/bash
# Pre-push hook script
# This script runs before pushing to remote

set -e

echo "🚀 Running pre-push checks..."

# 1. Lint
echo "🔍 Running lint..."
npm run lint

# 2. Full unit test gate
echo "🧪 Running full unit test gate..."
npm run test:run:verify

# 3. Build
echo "🏗️ Building project..."
npm run build

echo "✅ Pre-push checks completed!"
