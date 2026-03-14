# NanoFlow Pre-Tool Check Hook (PowerShell)
# Output MUST be a single JSON line on stdout.
# [Console]::WriteLine() bypasses PS5.1 pipeline encoding (CP936 on Chinese Windows).

param()

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ToolName = $env:TOOL_NAME
$ToolArgs = $env:TOOL_ARGS

$LogDir = Join-Path $PSScriptRoot '..\logs'
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$DangerousPatterns = @(
    'Remove-Item -Recurse -Force C:\',
    'Remove-Item -Recurse -Force /',
    'Format-',
    'Clear-Disk'
)

$SensitiveFiles = @(
    '.env', '.env.local', '.env.production',
    'secrets', 'credentials', 'private.key'
)

function Write-Deny {
    param([string]$Reason)
    $safe = $Reason.Replace('\', '\\').Replace('"', '\"')
    $json = '{"permissionDecision":"deny","permissionDecisionReason":"' + $safe + '"}'
    [Console]::WriteLine($json)
    exit 0
}

function Write-AuditWarn {
    param([string]$Msg)
    $ts = [datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss')
    $line = $ts + ' [WARN] ' + $Msg
    $line | Add-Content -LiteralPath (Join-Path $LogDir 'sensitive-access.log') -Encoding UTF8 -ErrorAction SilentlyContinue
}

foreach ($pattern in $DangerousPatterns) {
    if ($ToolName -match 'runInTerminal|execute|shell|powershell' -and $ToolArgs -like "*$pattern*") {
        Write-Deny ('Dangerous command pattern detected: ' + $pattern)
    }
}

if ($ToolName -match 'editFiles|edit|Edit|Write') {
    foreach ($pattern in $SensitiveFiles) {
        if ($ToolArgs -like "*$pattern*") {
            Write-AuditWarn ('Sensitive file access: ' + $pattern + ' | Tool=' + $ToolName)
        }
    }
}

[Console]::WriteLine('{"permissionDecision":"allow"}')