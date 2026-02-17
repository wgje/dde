#!/bin/bash
# Pre-commit hook script
# This script runs before each commit

set -e

echo "🔍 Running pre-commit checks..."

# 1. Lint
echo "📋 Running ESLint..."
npm run lint

# 2. Type check
echo "📝 Running TypeScript check..."
npx tsc --noEmit

# 3. Fast unit tests
echo "🧪 Running fast unit tests..."
npm run test:run

echo "✅ All pre-commit checks passed!"
