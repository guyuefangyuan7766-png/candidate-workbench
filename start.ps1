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
    "AGENT_BASE_URL",
    "AGENT_API_KEY",
    "AGENT_MODEL",
    "ATTACHMENT_TEXT_SCHEMA_MODE",
    "ATTACHMENT_TEXT_TIMEOUT_MS",
    "ATTACHMENT_TEXT_MAX_RESPONSE_BYTES",
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
    "ATTACHMENT_VISUAL_MAX_RESPONSE_BYTES"
)
foreach ($name in $agentVariableNames) {
    $processValue = [Environment]::GetEnvironmentVariable($name, "Process")
    if ([string]::IsNullOrWhiteSpace($processValue)) {
        $userValue = [Environment]::GetEnvironmentVariable($name, "User")
        if (-not [string]::IsNullOrWhiteSpace($userValue)) {
            [Environment]::SetEnvironmentVariable($name, $userValue, "Process")
        }
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

& npm start
if ($LASTEXITCODE -ne 0) { throw "Application startup failed." }
