$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$blockingMaintenanceSentinel = Get-ChildItem -LiteralPath $PSScriptRoot -Filter ".candidate-workbench-maintenance-*.lock" -File -Force | Where-Object {
    try {
        $sentinel = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json
        if ($sentinel.kind -ne "candidate-workbench-maintenance-v1" -or $sentinel.owner -ne "runtime") { return $true }
        return $null -ne (Get-Process -Id ([int]$sentinel.pid) -ErrorAction SilentlyContinue)
    } catch {
        return $true
    }
} | Select-Object -First 1
if ($null -ne $blockingMaintenanceSentinel) {
    throw "Database maintenance is active. The launcher will not install, build, or start the application."
}

$agentVariableNames = @(
    "NODE_USE_SYSTEM_CA",
    "AGENT_BASE_URL",
    "AGENT_API_KEY",
    "AGENT_MODEL",
    "SEARCH_REMOTE_ENABLED",
    "SEARCH_QUERY_MODEL",
    "SEARCH_QUERY_REASONING_EFFORT",
    "SEARCH_QUERY_TIMEOUT_MS",
    "SEARCH_EMBEDDING_MODEL",
    "SEARCH_EMBEDDING_DIMENSIONS",
    "SEARCH_RERANK_MODEL",
    "SEARCH_VECTOR_DIRECTORY",
    "SEARCH_VECTOR_MAINTENANCE_ENABLED",
    "SEARCH_VECTOR_MAINTENANCE_CONCURRENCY",
    "SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS",
    "SEARCH_MODEL_ALLOWED_HOSTS",
    "SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS",
    "ATTACHMENT_TEXT_SCHEMA_MODE",
    "ATTACHMENT_TEXT_TIMEOUT_MS",
    "ATTACHMENT_TEXT_MAX_RESPONSE_BYTES",
    "ATTACHMENT_TEXT_TRUSTED_PRIVATE_HOSTS",
    "ATTACHMENT_VISUAL_CAPABILITY",
    "ATTACHMENT_VISUAL_SCHEMA_MODE",
    "ATTACHMENT_VISUAL_BASE_URL",
    "ATTACHMENT_VISUAL_ALLOWED_HOSTS",
    "ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS",
    "ATTACHMENT_VISUAL_API_KEY",
    "ATTACHMENT_VISUAL_MODEL",
    "ATTACHMENT_VISUAL_TIMEOUT_MS",
    "ATTACHMENT_VISUAL_MAX_PAGES",
    "ATTACHMENT_VISUAL_MAX_PAGE_PIXELS",
    "ATTACHMENT_VISUAL_MAX_PAGE_BYTES",
    "ATTACHMENT_VISUAL_MAX_TOTAL_IMAGE_BYTES",
    "ATTACHMENT_VISUAL_MAX_TEXT_CHARACTERS",
    "ATTACHMENT_VISUAL_MAX_RECORDS",
    "ATTACHMENT_VISUAL_MAX_RESPONSE_BYTES",
    # Authentication and LDAP (2026-09-21). Any variable missing from this list
    # is explicitly cleared from the process environment by the else-branch
    # below, which would make the service start without its auth configuration.
    "AUTH_ENABLED",
    "AUTH_ALLOW_NON_LOOPBACK",
    "AUTH_BIND_HOSTS",
    "AUTH_COOKIE_SECURE",
    "AUTH_COOKIE_NAME",
    "AUTH_TRUST_PROXY",
    "AUTH_SESSION_TTL_MS",
    "AUTH_SESSION_ABSOLUTE_TTL_MS",
    "AUTH_SESSION_REVOKE_ALL",
    "AUTH_DB_PATH",
    "AUTH_ALLOWLIST_FILE",
    "AUTH_ALLOWED_USERS",
    "AUTH_ALLOWLIST_RELOAD_MS",
    "AUTH_LOGIN_RATE_LIMIT",
    "AUTH_LOGIN_RATE_WINDOW_MS",
    "AUTH_LOGIN_IP_RATE_LIMIT",
    "AUTH_LOGIN_IP_RATE_WINDOW_MS",
    "LDAP_URL",
    "LDAP_USER_DN_TEMPLATE",
    "LDAP_UID_ATTRIBUTE",
    "LDAP_NAME_ATTRIBUTE",
    "LDAP_EMAIL_ATTRIBUTE",
    "LDAP_ATTRIBUTE_LOOKUP",
    "LDAP_ALLOW_PLAINTEXT",
    "LDAP_STARTTLS",
    "LDAP_TIMEOUT_MS",
    "LDAP_BIND_DN",
    "LDAP_BIND_PASSWORD",
    "LDAP_USER_SEARCH_BASE",
    "LDAP_USER_FILTER",
    # Listening port. The deployment guide lists PORT as configurable, so it
    # must travel the same sync path; otherwise a process-level override is
    # cleared below and the service always falls back to 4173.
    "PORT"
)
foreach ($name in $agentVariableNames) {
    $processValue = [Environment]::GetEnvironmentVariable($name, "Process")
    $userValue = [Environment]::GetEnvironmentVariable($name, "User")
    # Machine scope is the contract when the service runs as a scheduled task
    # under SYSTEM, which cannot see another account's User-scoped variables.
    # User scope still wins when set, so per-user overrides keep working.
    $machineValue = [Environment]::GetEnvironmentVariable($name, "Machine")
    $resolved = $null
    if (-not [string]::IsNullOrWhiteSpace($userValue)) { $resolved = $userValue }
    elseif (-not [string]::IsNullOrWhiteSpace($machineValue)) { $resolved = $machineValue }
    [Environment]::SetEnvironmentVariable($name, $resolved, "Process")
}

# Workspace-specific search activation survives a normal launcher restart.
# This ignored local file only accepts search switches/model names, never credentials.
$searchRuntimePath = Join-Path $PSScriptRoot 'data/search-runtime.json'
if (Test-Path -LiteralPath $searchRuntimePath) {
    $searchRuntimeNames = @('SEARCH_REMOTE_ENABLED', 'SEARCH_QUERY_MODEL', 'SEARCH_QUERY_REASONING_EFFORT', 'SEARCH_QUERY_TIMEOUT_MS', 'SEARCH_EMBEDDING_MODEL', 'SEARCH_EMBEDDING_DIMENSIONS', 'SEARCH_RERANK_MODEL', 'SEARCH_VECTOR_DIRECTORY', 'SEARCH_VECTOR_MAINTENANCE_ENABLED', 'SEARCH_VECTOR_MAINTENANCE_CONCURRENCY', 'SEARCH_VECTOR_MAINTENANCE_INTERVAL_MS')
    $searchRuntime = Get-Content -Raw -LiteralPath $searchRuntimePath | ConvertFrom-Json
    foreach ($setting in $searchRuntime.PSObject.Properties) {
        if ($setting.Name -notin $searchRuntimeNames -or $setting.Value -isnot [string] -or $setting.Value.Length -gt 1024) {
            throw 'Invalid local search runtime setting.'
        }
        [Environment]::SetEnvironmentVariable($setting.Name, $setting.Value, 'Process')
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js/npm was not found. Install Node.js 24 or newer first."
}

$nodeMajorText = & node -p "process.versions.node.split('.')[0]"
if ($LASTEXITCODE -ne 0) { throw "Unable to read the Node.js version." }
$nodeMajor = [int]$nodeMajorText
if ($nodeMajor -lt 24) {
    throw "Node.js 24 or newer is required."
}

$lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath "package-lock.json").Hash
$lockStampPath = "node_modules\.candidate-workbench-lock.sha256"
$requiredDependencies = @(
    "node_modules\express\package.json",
    "node_modules\exceljs\package.json",
    "node_modules\xls-reader\package.json",
    "node_modules\react\package.json",
    "node_modules\vite\package.json"
)
$dependenciesReady = ($requiredDependencies | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0
$installedHash = if (Test-Path -LiteralPath $lockStampPath) { (Get-Content -Raw -LiteralPath $lockStampPath).Trim() } else { "" }

if (-not $dependenciesReady -or $installedHash -ne $lockHash) {
    Write-Host "Synchronizing project dependencies..."
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
    Set-Content -NoNewline -LiteralPath $lockStampPath -Value $lockHash
}

& npm run build
if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }

# Optional log file for the service process. Redirection is done by
# Start-Process at the OS level: PowerShell 5.1 turns a native command's stderr
# into a NativeCommandError, and with $ErrorActionPreference = 'Stop' that would
# abort this script before the service ever starts.
$logPath = [Environment]::GetEnvironmentVariable('TALENT_LOG_FILE', 'Process')
if (-not [string]::IsNullOrWhiteSpace($logPath)) {
    Write-Host ("Logging service output to: " + $logPath)
    $service = Start-Process -FilePath 'node' -ArgumentList 'server/index.mjs' `
        -WorkingDirectory $PSScriptRoot -NoNewWindow -PassThru `
        -RedirectStandardOutput $logPath -RedirectStandardError ($logPath + '.err')
    $service.WaitForExit()
    if ($service.ExitCode -ne 0) { throw ("Application startup failed with exit code " + $service.ExitCode + ". See " + $logPath) }
} else {
    & node server/index.mjs
    if ($LASTEXITCODE -ne 0) { throw "Application startup failed." }
}
