#!/usr/bin/env bash
# Cloudflare Pages header smoke (§14.2 / §16.15)
# Usage: bash scripts/smoke/cloudflare-header-smoke.sh https://nanoflow.pages.dev
#
# 验收点：
# - freshness 路径 no-store + 无 CF-Cache-Status: HIT/Age>0
# - hashed bundles immutable
# - 不含 Link: ... rel=modulepreload（首版关闭 Early Hints）
# - manifest.webmanifest / version.json / ngsw.json 可读
# - 缺失静态资源不被错误 _redirects 包装成 200 HTML；
#   Cloudflare Pages 默认 SPA fallback 若返回 HTML 200，则必须有 chunk 自愈合同兜底

set -euo pipefail

ORIGIN="${1:-${SMOKE_ORIGIN:-}}"
if [[ -z "$ORIGIN" ]]; then
  echo "ERR: ORIGIN required as first arg or SMOKE_ORIGIN env" >&2
  exit 2
fi

ORIGIN="${ORIGIN%/}"

PASS=0
FAIL=0
fail() { echo "✗ $*"; FAIL=$((FAIL+1)); }
pass() { echo "✓ $*"; PASS=$((PASS+1)); }

fetch_headers() {
  local path="$1"
  curl -sS -L -I --max-time 15 "$ORIGIN$path"
}

assert_header_match() {
  local path="$1" pattern="$2" desc="$3"
  local headers
  headers="$(fetch_headers "$path" || true)"
  if echo "$headers" | grep -qiE "$pattern"; then
    pass "$path $desc"
  else
    fail "$path $desc — pattern not found: $pattern"
    echo "    --- headers ---"
    echo "$headers" | sed 's/^/    /'
  fi
}

assert_header_absent() {
  local path="$1" pattern="$2" desc="$3"
  local headers
  headers="$(fetch_headers "$path" || true)"
  if echo "$headers" | grep -qiE "$pattern"; then
    fail "$path $desc — unexpected match: $pattern"
    echo "    --- headers ---"
    echo "$headers" | sed 's/^/    /'
  else
    pass "$path $desc"
  fi
}

assert_status() {
  local path="$1" expected="$2"
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$ORIGIN$path" || echo '000')"
  if [[ "$code" == "$expected" ]]; then
    pass "$path → HTTP $code"
  else
    fail "$path expected $expected got $code"
  fi
}

assert_freshness() {
  local path="$1"
  assert_header_match "$path" "Cache-Control: *.*no-store" "is no-store"
  local headers age cf
  headers="$(fetch_headers "$path" || true)"
  cf="$(echo "$headers" | { grep -i '^cf-cache-status:' || true; } | tr -d '\r' | awk -F': *' '{print $2}' | tr 'A-Z' 'a-z' | head -n1)"
  age="$(echo "$headers" | { grep -i '^age:' || true; } | tr -d '\r' | awk -F': *' '{print $2}' | head -n1)"
  if [[ "$cf" == "hit" && -n "$age" && "$age" =~ ^[0-9]+$ && "$age" -gt 0 ]]; then
    fail "$path freshness violated — CF-Cache-Status=$cf, Age=$age"
  else
    pass "$path freshness OK (cf=${cf:-none}, age=${age:-0})"
  fi
}

echo "==== Cloudflare header smoke against $ORIGIN ===="

assert_status "/" "200"
assert_freshness "/"
assert_header_absent "/" "^Link: .*rel=[\"']?modulepreload" "no Link rel=modulepreload (Early Hints disabled)"

assert_status "/ngsw.json" "200"
assert_freshness "/ngsw.json"
assert_status "/version.json" "200"
assert_freshness "/version.json"
assert_status "/ngsw-worker.js" "200"
assert_freshness "/ngsw-worker.js"
assert_status "/sw-composed.js" "200"
assert_freshness "/sw-composed.js"

assert_status "/manifest.webmanifest" "200"
assert_header_absent "/manifest.webmanifest" "Cache-Control: *.*immutable" "manifest is not immutable"

assert_header_match "/" "X-Content-Type-Options: *nosniff" "has X-Content-Type-Options"
assert_header_match "/" "X-Frame-Options: *SAMEORIGIN" "has X-Frame-Options"
assert_header_match "/" "Referrer-Policy: *strict-origin-when-cross-origin" "has Referrer-Policy"

# 负向：缺失静态资源不应被自定义 _redirects 包装成 HTML 200。
# Cloudflare Pages 没有顶层 404.html 时会按官方默认 SPA rendering 把未命中路径交给根入口；
# 首版不引入 Pages Functions，因此这一路径必须由 GlobalErrorHandler 的 chunk 自愈合同兜底。
neg_chunk_path="/chunk-deadbeefcafe1234.js"
neg_status="$(curl -sS -o /tmp/cf-neg-body --max-time 15 -w '%{http_code} %{content_type}' "$ORIGIN$neg_chunk_path" || echo '000 unknown')"
neg_code="$(echo "$neg_status" | awk '{print $1}')"
neg_ctype="$(echo "$neg_status" | awk '{print $2}')"
if [[ "$neg_code" == "200" && "$neg_ctype" == text/html* ]]; then
  if grep -Eq 'ChunkLoadError|Failed to fetch dynamically imported module|Loading chunk.*failed' src/services/global-error-handler.service.ts \
    && grep -q 'handleChunkLoadError' src/services/global-error-handler.service.ts \
    && grep -q 'Failed to fetch dynamically imported module' src/services/global-error-handler.service.spec.ts; then
    pass "missing chunk negative test: $neg_chunk_path → 200 HTML via Pages SPA fallback; GlobalErrorHandler chunk self-heal contract present"
  else
    fail "missing chunk negative test: $neg_chunk_path returned 200 + HTML and chunk self-heal contract was not found"
  fi
elif [[ "$neg_code" == "404" ]]; then
  pass "missing chunk negative test: $neg_chunk_path → 404 (correct)"
else
  pass "missing chunk negative test: $neg_chunk_path → $neg_code $neg_ctype (acceptable, not HTML 200)"
fi

# 主入口 chunk immutable 验证
main_chunk="$(curl -sS --max-time 15 "$ORIGIN/" | grep -oE 'main-[A-Z0-9]+\.js' | head -n1 || true)"
if [[ -n "$main_chunk" ]]; then
  assert_header_match "/$main_chunk" "Cache-Control: *.*immutable" "$main_chunk has immutable"
else
  echo "  (skip immutable assertion: 未在 / 解析到 main-*.js)"
fi

echo ""
echo "==== Result: PASS=$PASS FAIL=$FAIL ===="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
