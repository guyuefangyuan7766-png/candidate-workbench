$ErrorActionPreference = 'Continue'
$path = 'C:\talent-data\auth-allowlist.txt'

Write-Host "===== 1. FILE INFO =====" -ForegroundColor Cyan
$f = Get-Item -LiteralPath $path
Write-Host ("  Size     : " + $f.Length + " bytes")
Write-Host ("  Modified : " + $f.LastWriteTime)

Write-Host ""
Write-Host "===== 2. ENCODING CHECK (first bytes) =====" -ForegroundColor Cyan
$bytes = [System.IO.File]::ReadAllBytes($path)
Write-Host ("  Head: " + (($bytes[0..([Math]::Min(11, $bytes.Length-1))] | ForEach-Object { $_.ToString('X2') }) -join ' '))
if ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { Write-Host "  -> UTF-8 BOM" }
elseif ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { Write-Host "  -> UTF-16 LE BOM  <<<< Node reads this as garbage" -ForegroundColor Red }
elseif ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) { Write-Host "  -> UTF-16 BE BOM  <<<< Node reads this as garbage" -ForegroundColor Red }
else { Write-Host "  -> No BOM" }

Write-Host ""
Write-Host "===== 3. CONTENT (decoded as UTF8) =====" -ForegroundColor Cyan
Get-Content -LiteralPath $path -Encoding UTF8 | ForEach-Object { Write-Host ("  [" + $_ + "]") }

Write-Host ""
Write-Host "===== 4. WAIT FOR RELOAD AND RE-CHECK =====" -ForegroundColor Cyan
Write-Host "  Waiting 35s for the service to re-read the file..."
Start-Sleep -Seconds 35
$stat = Invoke-RestMethod http://127.0.0.1:4173/api/auth/status
Write-Host ("  enforced    : " + $stat.allowlist.enforced)
Write-Host ("  size        : " + $stat.allowlist.size)
Write-Host ("  last_error  : " + $(if ($stat.allowlist.last_error) { $stat.allowlist.last_error } else { "(none)" }))

Write-Host ""
Write-Host "===== 5. VERDICT =====" -ForegroundColor Cyan
if ($stat.allowlist.size -eq 0) {
  Write-Host "  size = 0 -> all logins denied; any logged-in user is removed and revoked on next request." -ForegroundColor Red
} elseif ($stat.allowlist.size -lt 8) {
  Write-Host ("  size = " + $stat.allowlist.size + " (expected 8) -> missing accounts get revoked.") -ForegroundColor Yellow
} else {
  Write-Host "  allowlist OK (8 entries)."
}

Write-Host ""
Write-Host "===== 6. SESSIONS CREATED RECENTLY =====" -ForegroundColor Cyan
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/talent-data/auth.db',{readOnly:true});const rows=d.prepare('SELECT u.username, s.created_at, s.last_seen_at, s.revoked_at, s.client_ip FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 15').all();const t=v=>v?String(v).slice(11,19):'-';for(const r of rows){console.log('  '+String(r.username).padEnd(8)+' created '+t(r.created_at)+' | last '+t(r.last_seen_at)+' | revoked '+t(r.revoked_at)+' | ip '+(r.client_ip||'-'));}d.close();"
