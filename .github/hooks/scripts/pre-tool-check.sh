#!/bin/bash
# NanoFlow Pre-Tool Check Hook
# 映射自 everything-claude-code 的 PreToolUse 验证

# 获取工具名和参数
TOOL_NAME="${TOOL_NAME:-}"
TOOL_ARGS="${TOOL_ARGS:-}"

# 危险命令模式检测
DANGEROUS_PATTERNS=(
    "rm -rf /"
    "rm -rf /*"
    "rm -rf ~"
    ":(){:|:&};:"
    "dd if=/dev/zero"
    "mkfs."
    "> /dev/sda"
    "chmod -R 777 /"
)

# 敏感文件模式
SENSITIVE_FILES=(
    ".env"
    ".env.local"
    ".env.production"
    "secrets"
    "credentials"
    "private.key"
    "*.pem"
)

# 检查是否包含危险命令
check_dangerous_command() {
    local args="$1"
    for pattern in "${DANGEROUS_PATTERNS[@]}"; do
        if [[ "$args" == *"$pattern"* ]]; then
            echo '{"permissionDecision": "deny", "permissionDecisionReason": "Dangerous command pattern detected: '"$pattern"'"}'
            exit 0
        fi
    done
}

# 检查是否访问敏感文件
check_sensitive_file() {
    local args="$1"
    for pattern in "${SENSITIVE_FILES[@]}"; do
        if [[ "$args" == *"$pattern"* ]]; then
            # 仅警告，不阻止
            echo "⚠️ Warning: Accessing sensitive file pattern: $pattern" >&2
        fi
    done
}

# 主逻辑
case "$TOOL_NAME" in
    "runInTerminal"|"execute"|"shell"|"Bash")
        check_dangerous_command "$TOOL_ARGS"
        ;;
    "editFiles"|"edit"|"Edit"|"Write")
        check_sensitive_file "$TOOL_ARGS"
        ;;
esac

# 默认允许
echo '{"permissionDecision": "allow"}'
