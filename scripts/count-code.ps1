$ErrorActionPreference = 'Stop'

if (-not (Get-Command scc -ErrorAction SilentlyContinue)) {
    throw 'scc was not found. Install it first: winget install --id benboyter.scc --source winget'
}

function Invoke-CodeCount {
    param(
        [string]$Title,
        [object[]]$Files
    )

    $existingFiles = @(
        $Files |
        Where-Object { $_ -and (Test-Path $_) } |
        Sort-Object -Unique
    )

    Write-Host ''
    Write-Host '============================================================'
    Write-Host $Title
    Write-Host '============================================================'

    if ($existingFiles.Count -eq 0) {
        Write-Host 'No matching files were found.'
        return
    }

    & scc `
        --no-min-gen `
        --no-duplicates `
        -x 'json,md,yml,yaml,toml,xml,properties,lock' `
        $existingFiles
}

# A. Core application code
# Excludes tests, fixed config files and generated type files.
$coreFiles = @(
    'main.ts'
) + @(
    Get-ChildItem -Path @(
        'src',
        'supabase/functions',
        'android/app/src/main/java'
    ) -Recurse -File |
    Where-Object {
        $_.Name -notlike '*.spec.ts' -and
        $_.FullName -notmatch '[\\/]src[\\/]config[\\/]' -and
        $_.FullName -notmatch '[\\/]src[\\/]models[\\/]supabase-types\.ts$' -and
        $_.FullName -notmatch '[\\/]supabase[\\/]functions[\\/]_shared[\\/]deno\.d\.ts$'
    } |
    Select-Object -ExpandProperty FullName
)

# B. Database business SQL
# Excludes archived migration files to avoid double counting.
$databaseFiles = @(
    'scripts/init-supabase.sql'
) + @(
    Get-ChildItem -Path 'supabase/migrations' -Recurse -File -Filter '*.sql' |
    Where-Object {
        $_.FullName -notmatch '[\\/]archive[\\/]'
    } |
    Select-Object -ExpandProperty FullName
)

# C. Unit tests and E2E tests
$testFiles = @(
    Get-ChildItem -Path @('src', 'e2e') -Recurse -File |
    Where-Object {
        $_.Name -like '*.spec.ts' -or
        $_.FullName -match '[\\/]e2e[\\/]'
    } |
    Select-Object -ExpandProperty FullName
)

# D. Engineering scripts
$engineeringScriptFiles = @(
    Get-ChildItem -Path 'scripts' -Recurse -File |
    Where-Object {
        $_.Extension -notin @('.md', '.sql')
    } |
    Select-Object -ExpandProperty FullName
)

# E. Handwritten runtime supplement
$runtimeSupplementFiles = @(
    'public/sw-composed.js'
)

Invoke-CodeCount 'A. Core application code' $coreFiles
Invoke-CodeCount 'B. Database business SQL' $databaseFiles
Invoke-CodeCount 'C. Test code' $testFiles
Invoke-CodeCount 'D. Engineering scripts' $engineeringScriptFiles
Invoke-CodeCount 'E. Handwritten runtime supplement' $runtimeSupplementFiles