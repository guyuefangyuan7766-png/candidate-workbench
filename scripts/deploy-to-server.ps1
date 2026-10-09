# Deploy talent-asset-workbench onto the Windows server.
#
# Run this ON THE SERVER, inside an RDP session that maps the workstation drive
# (mstsc /v:192.168.8.12 /drive:D,  ->  D: appears as \\tsclient\D).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-to-server.ps1 -SourceRoot "\\tsclient\D\talent-asset-workbench"
#
# What it does (in order):
#   1. stops the running app (node server/index.mjs) and the TalentWorkbench task
#   2. renames existing code/data aside (timestamped backups, never deletes)
#   3. copies source code (excluding node_modules/.git/data/logs/temp files)
#   4. copies the data set: recruitment.db (+ -wal/-shm), search-vectors, private, search-runtime.json
#   5. npm ci + npm run build
#   6. prints the checks you still must do (env vars, task scheduler, self-test)
#
# Safety: -DryRun prints the plan without touching anything. Nothing is deleted;
# old directories are renamed to *.bak-<timestamp>.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [string]$CodeTarget = 'C:\apps\talent-workbench',
  [string]$DataTarget = 'C:\talent-data',
  [switch]$SkipData,
  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Step([string]$text) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) }

function Invoke-External([string]$file, [string[]]$arguments, [string]$workdir = $null) {
  Write-Host ("    > {0} {1}" -f $file, ($arguments -join ' '))
  if ($DryRun) { return 0 }
  $saved = Get-Location
  try {
    if ($workdir) { Set-Location -LiteralPath $workdir }
    & $file @arguments
    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { throw "$file exited with $LASTEXITCODE" }
    return 0
  } finally { Set-Location $saved }
}

function Stop-App {
  Write-Step 'stopping running app'
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
}

function Backup-Directory([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $backup = "$path.bak-$stamp"
  Write-Step ("renaming {0} -> {1}" -f $path, $backup)
  if (-not $DryRun) { Rename-Item -LiteralPath $path -NewName (Split-Path $backup -Leaf) }
  return $backup
}

Write-Step "source: $SourceRoot"
if (-not (Test-Path -LiteralPath $SourceRoot)) { throw "SourceRoot not found: $SourceRoot (is the RDP drive mapped?)" }
$sourceCode = Join-Path $SourceRoot '.'
if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'package.json'))) { throw "package.json missing under $SourceRoot" }

Stop-App

# 1. code
Backup-Directory $CodeTarget | Out-Null
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $CodeTarget | Out-Null }
Write-Step 'copying source code (robocopy, excluding node_modules/data/.git/logs/temp)'
Invoke-External 'robocopy' @(
  $sourceCode, $CodeTarget, '/MIR', '/R:2', '/W:2', '/NP', '/NFL', '/NDL',
  '/XD', 'node_modules', '.git', 'data', 'tmp', 'outputs', 'exports', 'backups',
  '/XF', '*.log', '.env', '*.db', '*.db-wal', '*.db-shm', '.tmp-*'
) | Out-Null

# 2. data
if (-not $SkipData) {
  $sourceData = Join-Path $SourceRoot 'data'
  if (-not (Test-Path -LiteralPath $sourceData)) { throw "data directory missing under $SourceRoot" }
  $backupData = Backup-Directory $DataTarget
  if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $DataTarget | Out-Null }

  Write-Step 'copying database files (db + wal + shm in one pass)'
  # Use robocopy /J for large files (unbuffered IO; much faster than Copy-Item over RDP).
  Invoke-External 'robocopy' @(
    $sourceData, $DataTarget,
    'recruitment.db', 'recruitment.db-wal', 'recruitment.db-shm', 'search-runtime.json',
    '/J', '/R:2', '/W:2', '/NP', '/NFL', '/NDL'
  ) | Out-Null
  foreach ($dir in @('search-vectors', 'private')) {
    $from = Join-Path $sourceData $dir
    if (-not (Test-Path -LiteralPath $from)) { Write-Host ("    skip missing {0}" -f $dir); continue }
    Write-Step ("copying {0} (robocopy /MIR)" -f $dir)
    Invoke-External 'robocopy' @($from, (Join-Path $DataTarget $dir), '/MIR', '/R:2', '/W:2', '/NP', '/NFL', '/NDL') | Out-Null
  }

  # Auth state is NOT part of the source tree: auth-allowlist.txt and auth.db live in the
  # server data directory. Carry them over from the backup, or nobody can log in while
  # AUTH_ENABLED=true.
  if ($backupData) {
    foreach ($name in @('auth-allowlist.txt', 'auth.db', 'auth.db-wal', 'auth.db-shm')) {
      $from = Join-Path $backupData $name
      if (Test-Path -LiteralPath $from) {
        Write-Step ("carrying over auth file {0}" -f $name)
        if (-not $DryRun) { Copy-Item -LiteralPath $from -Destination (Join-Path $DataTarget $name) -Force }
      }
    }
  }
} else {
  Write-Step 'SkipData set: leaving existing data directory untouched'
}

# 3. dependencies + build
if (-not $SkipInstall) { Write-Step 'npm ci'; Invoke-External 'npm' @('ci') -workdir $CodeTarget | Out-Null }
if (-not $SkipBuild) { Write-Step 'npm run build'; Invoke-External 'npm' @('run', 'build') -workdir $CodeTarget | Out-Null }

# 4. summary
Write-Step 'done. Manual follow-ups:'
Write-Host @'
  1. Environment variables (system + user scope), e.g.:
       HOST=127.0.0.1  PORT=4173
       DB_PATH=C:\talent-data\recruitment.db
       SEARCH_VECTOR_DIRECTORY=C:\talent-data\search-vectors
       SEARCH_REMOTE_ENABLED=true  SEARCH_VECTOR_MAINTENANCE_ENABLED=true
       AGENT_BASE_URL / AGENT_API_KEY   (AI assistant + hybrid search)
       NODE_USE_SYSTEM_CA=1
       AUTH_ENABLED / LDAP_* (see docs/SERVER_UPLOAD_CHECKLIST.md)
  2. Task Scheduler "TalentWorkbench" -> powershell -NoProfile -ExecutionPolicy Bypass -File "C:\apps\talent-workbench\start.ps1"
  3. Start the service, then verify:
       Invoke-RestMethod http://127.0.0.1:4173/api/health
       Invoke-RestMethod http://127.0.0.1:4173/api/resume-search/status
       node scripts/self-test-api.mjs
  4. File integrity:  node scripts/deployment-manifest.mjs --out C:\talent-data\deploy\server-manifest.json
     compare with the workstation copy of data\deploy\local-manifest.json.
'@
