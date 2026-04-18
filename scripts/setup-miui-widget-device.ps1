param(
  [string]$DeviceSerial,
  [string]$HostPackage = 'app.nanoflow.twa',
  [string]$BrowserPackage = 'com.android.chrome',
  [switch]$StatusOnly,
  [switch]$OpenSettings
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$requiredMiuiOps = @(
  10004,
  10008,
  10017,
  10020,
  10021,
  10022,
  10045,
  10049,
  10053
)

function Resolve-DeviceSerial {
  param([string]$PreferredSerial)

  if ($PreferredSerial) {
    return $PreferredSerial
  }

  $deviceLines = & adb devices 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "adb devices failed: $($deviceLines -join [Environment]::NewLine)"
  }

  $onlineDevices = @(
    $deviceLines |
      Where-Object { $_ -match '^\S+\s+device$' } |
      ForEach-Object { ($_ -split '\s+')[0] }
  )

  if ($onlineDevices.Count -eq 0) {
    throw 'No online Android device found. Connect a device or pass -DeviceSerial.'
  }

  if ($onlineDevices.Count -gt 1) {
    throw "Multiple online devices found: $($onlineDevices -join ', '). Pass -DeviceSerial explicitly."
  }

  return $onlineDevices[0]
}

function Invoke-Adb {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$IgnoreExitCode
  )

  $allArguments = @('-s', $script:ResolvedSerial) + $Arguments
  $output = & adb @allArguments 2>&1
  if ($LASTEXITCODE -ne 0 -and -not $IgnoreExitCode) {
    throw "adb $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
  }

  return @($output)
}

function Get-MiuiOpStatusLine {
  param(
    [string[]]$AppOpsOutput,
    [int]$OpId
  )

  $pattern = "^MIUIOP\($OpId\):"
  return $AppOpsOutput | Where-Object { $_ -match $pattern } | Select-Object -First 1
}

function Set-MiuiOpsAllow {
  param(
    [string]$PackageName,
    [int[]]$OpIds
  )

  foreach ($opId in $OpIds) {
    Write-Host "[miui-init] set $PackageName MIUIOP($opId) => allow"
    Invoke-Adb -Arguments @('shell', 'cmd', 'appops', 'set', $PackageName, [string]$opId, 'allow') | Out-Null
  }
}

function Show-MiuiStatusTable {
  param(
    [string[]]$PackageNames,
    [int[]]$OpIds
  )

  $rows = foreach ($packageName in $PackageNames) {
    $appOpsOutput = Invoke-Adb -Arguments @('shell', 'cmd', 'appops', 'get', $packageName)
    foreach ($opId in $OpIds) {
      $line = Get-MiuiOpStatusLine -AppOpsOutput $appOpsOutput -OpId $opId
      $mode = if ($line -match '^MIUIOP\(\d+\):\s*([^;\s]+)') { $Matches[1] } else { 'missing' }
      [PSCustomObject]@{
        Package = $packageName
        OpId = $opId
        Mode = $mode
        Raw = $line
      }
    }
  }

  $rows | Format-Table -AutoSize
}

function Open-MiuiPermissionScreens {
  param(
    [string[]]$PackageNames
  )

  Write-Host '[miui-init] opening MIUI Auto Start management screen'
  Invoke-Adb -Arguments @('shell', 'am', 'start', '-a', 'miui.intent.action.OP_AUTO_START') -IgnoreExitCode | Out-Null

  foreach ($packageName in $PackageNames) {
    Write-Host "[miui-init] opening MIUI background management for $packageName"
    Invoke-Adb -Arguments @('shell', 'am', 'start', '-a', 'miui.intent.action.MANAGER_BACKGROUND', '-d', "package:$packageName") -IgnoreExitCode | Out-Null
  }
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  throw 'adb is not available in PATH.'
}

$script:ResolvedSerial = Resolve-DeviceSerial -PreferredSerial $DeviceSerial
$packageNames = @($BrowserPackage, $HostPackage) | Select-Object -Unique

Write-Host "[miui-init] device: $script:ResolvedSerial"
Write-Host "[miui-init] packages: $($packageNames -join ', ')"

if (-not $StatusOnly) {
  foreach ($packageName in $packageNames) {
    Set-MiuiOpsAllow -PackageName $packageName -OpIds $requiredMiuiOps
  }
}

Show-MiuiStatusTable -PackageNames $packageNames -OpIds $requiredMiuiOps

if ($OpenSettings) {
  Open-MiuiPermissionScreens -PackageNames $packageNames
}
