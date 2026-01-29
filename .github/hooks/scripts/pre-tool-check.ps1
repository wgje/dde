# NanoFlow Pre-Tool Check Hook (PowerShell)
# 映射自 everything-claude-code 的 PreToolUse 验证

param()

$ToolName = $env:TOOL_NAME
$ToolArgs = $env:TOOL_ARGS

# 危险命令模式
$DangerousPatterns = @(
    "Remove-Item -Recurse -Force C:\",
    "Remove-Item -Recurse -Force /",
    "Format-",
    "Clear-Disk"
)

# 敏感文件模式
$SensitiveFiles = @(
    ".env",
    ".env.local",
    ".env.production",
    "secrets",
    "credentials",
    "private.key"
)

function Test-DangerousCommand {
    param([string]$Args)
    foreach ($pattern in $DangerousPatterns) {
        if ($Args -like "*$pattern*") {
            return @{
                permissionDecision = "deny"
                permissionDecisionReason = "Dangerous command pattern detected: $pattern"
            }
        }
    }
    return $null
}

function Test-SensitiveFile {
    param([string]$Args)
    foreach ($pattern in $SensitiveFiles) {
        if ($Args -like "*$pattern*") {
            Write-Warning "Accessing sensitive file pattern: $pattern"
        }
    }
}

# 主逻辑
switch -Regex ($ToolName) {
    "runInTerminal|execute|shell|powershell" {
        $result = Test-DangerousCommand -Args $ToolArgs
        if ($result) {
            $result | ConvertTo-Json -Compress
            exit 0
        }
    }
    "editFiles|edit|Edit|Write" {
        Test-SensitiveFile -Args $ToolArgs
    }
}

# 默认允许
@{ permissionDecision = "allow" } | ConvertTo-Json -Compress
