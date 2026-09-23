$ErrorActionPreference = 'Continue'
$now = (Get-Date).ToUniversalTime().ToString('o')

Write-Host "===== 1. TIME CHECK =====" -ForegroundColor Cyan
Write-Host ("  Local time : " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ("  UTC time   : " + (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ("  Timezone   : " + (Get-TimeZone).Id)

Write-Host ""
Write-Host "===== 2. SESSION OVERVIEW =====" -ForegroundColor Cyan
$q1 = "SELECT u.username, COUNT(*) AS total, SUM(CASE WHEN s.revoked_at IS NULL AND s.expires_at > '$now' AND s.absolute_expires_at > '$now' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN s.revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked, MAX(s.last_seen_at) AS last_seen FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id GROUP BY u.username ORDER BY last_seen DESC"
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/talent-data/auth.db',{readOnly:true});const rows=d.prepare(process.argv[1]).all();for(const r of rows){console.log('  '+String(r.username).padEnd(10)+' total '+String(r.total).padStart(3)+' | active '+String(r.active).padStart(3)+' | revoked '+String(r.revoked).padStart(3)+' | last '+String(r.last_seen||'-').slice(0,19));}d.close();" $q1

Write-Host ""
Write-Host "===== 3. RECENT 12 SESSIONS =====" -ForegroundColor Cyan
$q2 = "SELECT u.username, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at, s.client_ip FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id ORDER BY s.last_seen_at DESC LIMIT 12"
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/talent-data/auth.db',{readOnly:true});const rows=d.prepare(process.argv[1]).all();const s=t=>t?String(t).slice(5,16).replace('T',' '):'-';for(const r of rows){console.log('  '+String(r.username).padEnd(8)+' created '+s(r.created_at)+' | last '+s(r.last_seen_at)+' | expires '+s(r.expires_at)+' | revoked '+s(r.revoked_at)+' | ip '+(r.client_ip||'-'));}d.close();" $q2

Write-Host ""
Write-Host "===== 4. ACCOUNTS =====" -ForegroundColor Cyan
$q3 = "SELECT username, last_login_at, is_active FROM auth_users ORDER BY last_login_at DESC"
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/talent-data/auth.db',{readOnly:true});const rows=d.prepare(process.argv[1]).all();for(const r of rows){console.log('  '+String(r.username).padEnd(10)+' last login '+String(r.last_login_at||'-').slice(0,19)+' | active '+r.is_active);}d.close();" $q3

Write-Host ""
Write-Host "===== 5. SUMMARY =====" -ForegroundColor Cyan
node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('C:/talent-data/auth.db',{readOnly:true});const n=d.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?').get(new Date().toISOString(),new Date().toISOString());console.log('  Active sessions: '+n.c);d.close();"
Write-Host "  If 'active' matches your online user count, server-side sessions are fine -> the drop is browser-side (cookie not sent)."
Write-Host "  If 'revoked' keeps growing, the server is actively invalidating sessions."
