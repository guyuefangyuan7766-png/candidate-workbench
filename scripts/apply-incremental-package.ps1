# Apply an incremental data package on the server (service must be stopped).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\apply-incremental-package.ps1 -Package "\\tsclient\D\...\incremental-<stamp>.zip"
#   ... -DryRun           print the plan only
#   ... -SkipParse        skip the model-based resume parsing step
#   ... -SkipVector       skip the vector index refresh
#
# Steps: stop app -> expand package into <DataRoot>\incremental -> import -> (parse) -> persist text
#        -> refresh f16 vector index -> converge business index -> print how to start again.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$CodeRoot = 'C:\apps\talent-workbench',
  [string]$DataRoot = 'C:\talent-data',
  [switch]$SkipParse,
  [switch]$SkipVector,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Write-Step([string]$text) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) }

function Invoke-Node([string[]]$arguments) {
  Write-Host ("    > node {0}" -f ($arguments -join ' '))
  if ($DryRun) { return }
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw ("node {0} exited with {1}" -f ($arguments -join ' '), $LASTEXITCODE) }
}

if (-not (Test-Path -LiteralPath $Package)) { throw "package not found: $Package" }
if (-not (Test-Path -LiteralPath (Join-Path $CodeRoot 'package.json'))) { throw "code root looks wrong: $CodeRoot" }
$database = Join-Path $DataRoot 'recruitment.db'
$vectorDir = Join-Path $DataRoot 'search-vectors'
if (-not (Test-Path -LiteralPath $database)) { throw "database not found: $database" }

Write-Step "package: $Package"
Write-Step "code: $CodeRoot   data: $DataRoot"

# Optional but recommended: <code>\data must resolve to the real data directory (junction),
# otherwise the maintenance scripts would read/write <code>\data instead of <DataRoot>.
$codeData = Join-Path $CodeRoot 'data'
if (-not (Test-Path -LiteralPath $codeData)) {
  Write-Step ("creating junction {0} -> {1}" -f $codeData, $DataRoot)
  if (-not $DryRun) { cmd /c mklink /J "$codeData" "$DataRoot" | Out-Null }
}

# 1. stop service + scheduled task
Write-Step 'stopping service'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*server/index.mjs*' -or $_.CommandLine -like '*server\index.mjs*' }
foreach ($p in $procs) {
  Write-Host ("    stop pid {0}" -f $p.ProcessId)
  if (-not $DryRun) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
}
$task = Get-ScheduledTask -TaskName 'TalentWorkbench' -ErrorAction SilentlyContinue
if ($task) {
  Write-Host '    stop scheduled task TalentWorkbench'
  if (-not $DryRun) { Stop-ScheduledTask -TaskName 'TalentWorkbench' -ErrorAction SilentlyContinue }
}

# 2. expand package into <DataRoot>\incremental (merge, never purge)
$staging = Join-Path $env:TEMP ("incremental-pkg-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Step ("expanding package to {0}" -f $staging)
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  $tar = Start-Process -FilePath 'tar' -ArgumentList @('-xf', $Package, '-C', $staging) -Wait -PassThru -WindowStyle Hidden
  if ($tar.ExitCode -ne 0) { throw "tar exited with $($tar.ExitCode)" }
}
$incoming = Join-Path $staging 'incremental'
Write-Host ("    > robocopy `"{0}`" `"{1}`" /E /R:2 /W:2 /NP /NFL /NDL" -f $incoming, (Join-Path $DataRoot 'incremental'))
if (-not $DryRun) {
  robocopy $incoming (Join-Path $DataRoot 'incremental') /E /R:2 /W:2 /NP /NFL /NDL | Out-Null
}

# 3. pipeline
Push-Location $CodeRoot
try {
  Write-Step 'import incremental (candidates + sections + attachments)'
  Invoke-Node @('scripts/import-incremental.mjs', '--apply')

  if (-not $SkipParse) {
    Write-Step 'parse new origin resumes (model gateway; processes only unparsed candidates)'
    Invoke-Node @('scripts/parse-origin-resume-sections.mjs', '--apply', '--limit', '20000', '--batch-size', '10', '--concurrency', '5', '--report', 'data/phase3-incremental-report.json')
  } else { Write-Step 'SkipParse set' }

  Write-Step 'persist attachment text'
  Invoke-Node @('scripts/persist-attachment-text.mjs', '--apply')

  if (-not $SkipVector) {
    Write-Step 'refresh f16 vector index'
    Invoke-Node @('scripts/search-vector-maintenance.mjs', '--formal', '--database', $database, '--directory', $vectorDir, '--dimensions', '1024', '--concurrency', '4')
  } else { Write-Step 'SkipVector set' }

  Write-Step 'converge business search index'
  Invoke-Node @('scripts/converge-business-search.mjs', '--apply')
} finally {
  Pop-Location
}

if (-not $DryRun) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }

Write-Step 'done. Start the service again:'
Write-Host '    Start-ScheduledTask -TaskName TalentWorkbench'
Write-Host '    (then verify: http://127.0.0.1:4173/api/health and one real search)'
