#!/bin/bash
# TDD Helper Script
# Usage: ./tdd.sh [watch|run|coverage]

set -e

case "$1" in
  watch)
    echo "🔄 Starting test watch mode..."
    npm run test
    ;;
  run)
    echo "🧪 Running tests once..."
    npm run test:run
    ;;
  coverage)
    echo "📊 Running tests with coverage..."
    npx vitest run --coverage
    ;;
  *)
    echo "Usage: ./tdd.sh [watch|run|coverage]"
    echo ""
    echo "Commands:"
    echo "  watch     - Run tests in watch mode"
    echo "  run       - Run tests once"
    echo "  coverage  - Run tests with coverage report"
    exit 1
    ;;
esac
