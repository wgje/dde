param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ignoredDirs = @(
  '.angular',
  '.cache',
  '.git',
  '.tmp',
  '.worktrees',
  'build',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp'
)

function Test-IgnoredPath {
  param(
    [string]$FullPath
  )

  foreach ($segment in $ignoredDirs) {
    if ($FullPath -match ("[\\/]" + [regex]::Escape($segment) + "([\\/]|$)")) {
      return $true
    }
  }

  return $false
}

$xmlFiles = Get-ChildItem -Path $Root -Recurse -File -Filter *.xml |
  Where-Object { -not (Test-IgnoredPath $_.FullName) } |
  Sort-Object FullName

$issues = New-Object System.Collections.Generic.List[string]

foreach ($file in $xmlFiles) {
  try {
    $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    [xml]$content | Out-Null
  }
  catch [System.Xml.XmlException] {
    $exception = $_.Exception
    $line = if ($exception.LineNumber -gt 0) { $exception.LineNumber } else { 1 }
    $column = if ($exception.LinePosition -gt 0) { $exception.LinePosition } else { 1 }
    $issues.Add("$($file.FullName):${line}:${column}: error: $($exception.Message)")
  }
  catch {
    $issues.Add("$($file.FullName):1:1: error: $($_.Exception.Message)")
  }
}

if ($issues.Count -gt 0) {
  $issues | ForEach-Object { Write-Output $_ }
  exit 1
}

Write-Output "[validate-xml-wellformed] checked $($xmlFiles.Count) files"
