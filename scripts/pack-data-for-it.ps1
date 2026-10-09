# Package the project data into store-only (no compression) zip archives for IT.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pack-data-for-it.ps1
#   ... -Only 01,02        package just the listed archives
#   ... -Force             overwrite existing archives
#
# Design notes:
#   * store mode (zip:compression-level=0): no CPU-heavy compression, straight copy inside the zip
#   * one archive at a time, started at Idle priority so normal desktop use is not disturbed
#   * output goes to <project>\transfer\ which is inside the SMB share for IT
[CmdletBinding()]
param(
  [string]$Source = 'D:\talent-asset-workbench\data',
  [string]$OutDir = 'D:\talent-asset-workbench\transfer',
  [string[]]$Only = @(),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$logPath = Join-Path $OutDir 'pack.log'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Write-Log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Write-Host $line
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

# name = output file, items = entries under $Source, note = what it is
$archives = @(
  [pscustomobject]@{ name = '01-database.zip';    items = @('recruitment.db', 'recruitment.db-wal', 'recruitment.db-shm', 'search-runtime.json', 'deploy'); note = 'main database + runtime config + manifests (~17.5 GB)' },
  [pscustomobject]@{ name = '02-vectors.zip';     items = @('search-vectors');                  note = 'f16 vector index (~27.7 GB)' },
  [pscustomobject]@{ name = '03-attachments.zip'; items = @('private');                          note = 'attachments (~49.8 GB)' },
  [pscustomobject]@{ name = '04-archive.zip';     items = @('asset-export', 'incremental');      note = 'source snapshot + incremental cache (~65.5 GB)' },
  [pscustomobject]@{ name = '05-reports.zip';     items = @('phase3-full-report.json', 'avatar-audit', 'parse-retry-list.jsonl', 'self-test-report.json', 'business-eval-review.html'); note = 'reports (~0.2 GB)' }
)

Write-Log ("packing from {0} into {1} (store mode, idle priority)" -f $Source, $OutDir)
foreach ($archive in $archives) {
  if ($Only.Count -gt 0 -and ($Only -notcontains $archive.name.Split('-')[0])) { continue }
  $target = Join-Path $OutDir $archive.name
  $present = @($archive.items | Where-Object { Test-Path -LiteralPath (Join-Path $Source $_) })
  if ($present.Count -eq 0) { Write-Log ("skip {0}: no source items" -f $archive.name); continue }
  if ((Test-Path -LiteralPath $target) -and -not $Force) { Write-Log ("skip {0}: already exists (use -Force to rebuild)" -f $archive.name); continue }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }

  Write-Log ("start {0} <- {1}  ({2})" -f $archive.name, ($present -join ', '), $archive.note)
  $started = Get-Date
  $arguments = @('-a', '-cf', $target, '--options', 'zip:compression-level=0', '-C', $Source) + $present
  $process = Start-Process -FilePath 'tar' -ArgumentList $arguments -PassThru -WindowStyle Hidden
  try { $process.PriorityClass = 'Idle' } catch {}
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) { Write-Log ("FAILED {0}: tar exit {1}" -f $archive.name, $process.ExitCode); throw ("tar failed for {0}" -f $archive.name) }
  $size = (Get-Item -LiteralPath $target).Length
  $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Write-Log ("done {0}: {1} GB in {2}s" -f $archive.name, [math]::Round($size / 1GB, 2), $seconds)
}

# README for IT
$readme = @(
  'Talent asset workbench - data packages (store-only zip, no compression)',
  '',
  'Contents (extract each zip directly into C:\talent-data):',
  '  01-database.zip     recruitment.db + -wal/-shm + search-runtime.json + deploy/ (manifests)',
  '  02-vectors.zip      search-vectors/  (f16 usearch index, do NOT rebuild as f32)',
  '  03-attachments.zip  private/         (attachments)',
  '  04-archive.zip      asset-export/ + incremental/   (optional archive data)',
  '  05-reports.zip      reports (optional)',
  '',
  'Recommended order on the server (service stopped):',
  '  1) Stop-ScheduledTask -TaskName TalentWorkbench ; stop node server/index.mjs',
  '  2) Rename-Item C:\talent-data C:\talent-data.bak-<stamp>      # keeps auth-allowlist.txt / auth.db',
  '  3) New-Item -ItemType Directory C:\talent-data',
  '  4) tar -xf 01-database.zip -C C:\talent-data',
  '     tar -xf 02-vectors.zip  -C C:\talent-data',
  '     tar -xf 03-attachments.zip -C C:\talent-data',
  '     tar -xf 04-archive.zip  -C C:\talent-data      # optional',
  '     tar -xf 05-reports.zip  -C C:\talent-data      # optional',
  '  5) Copy-Item C:\talent-data.bak-<stamp>\auth-allowlist.txt,C:\talent-data.bak-<stamp>\auth.db* C:\talent-data\ -Force',
  '  6) Deploy the code + build + junction (one command from the share):',
  '       powershell -NoProfile -ExecutionPolicy Bypass -File "\\<share>\talent-workbench\scripts\deploy-to-server.ps1" `',
  '         -SourceRoot "\\<share>\talent-workbench" -SkipData',
  '     (-SkipData: data is already extracted by hand; the script still copies code, creates the',
  '      C:\apps\talent-workbench\data -> C:\talent-data junction, and runs npm ci + npm run build)',
  '  7) Start-ScheduledTask -TaskName TalentWorkbench',
  '  8) Verify: node scripts/data-inventory.mjs --verify C:\talent-data\deploy\data-manifest.json',
  '',
  'Verification uses data/deploy/data-manifest.json (file counts, byte sizes, recruitment.db SHA256).'
) -join "`r`n"
Set-Content -LiteralPath (Join-Path $OutDir 'README.txt') -Value $readme -Encoding UTF8
Write-Log 'all archives done; README.txt written'
