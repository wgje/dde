#!/usr/bin/env node
/**
 * scripts/compare-modulepreload.cjs (§16.25 deterministic guard 工具)
 *
 * 对比两个 index.html 的 modulepreload Link 列表，按字典序排序。
 * 用于 build-deterministic guard 与 artifact 比对场景。
 *
 * 用法：
 *   node scripts/compare-modulepreload.cjs path/to/a/index.html path/to/b/index.html
 *
 * 退出码：差异返回 1。
 */

const fs = require('node:fs');

function extract(html) {
  return [...html.matchAll(/<link[^>]+rel=["']?modulepreload["']?[^>]*href=["']?([^"'\s>]+)["']?/g)]
    .map((m) => m[1])
    .sort();
}

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('Usage: node scripts/compare-modulepreload.cjs <a/index.html> <b/index.html>');
  process.exit(2);
}

const ha = fs.readFileSync(a, 'utf-8');
const hb = fs.readFileSync(b, 'utf-8');
const la = extract(ha);
const lb = extract(hb);

if (JSON.stringify(la) === JSON.stringify(lb)) {
  console.log(`✓ modulepreload identical (${la.length} entries)`);
  process.exit(0);
}

console.error('✗ modulepreload differs');
console.error('  A: ' + JSON.stringify(la));
console.error('  B: ' + JSON.stringify(lb));
process.exit(1);
