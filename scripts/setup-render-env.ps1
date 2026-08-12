# Sets liquibot-back env vars on Render and triggers a clear-cache deploy.
# Requires RENDER_API_KEY (Account Settings -> API Keys).
# DATABASE_URL must be the Render Postgres Internal URL (not localhost).
#
# Example:
#   $env:RENDER_API_KEY = 'rnd_...'
#   .\scripts\setup-render-env.ps1 -DatabaseUrl 'postgresql://USER:PASS@dpg-XXXX.render.com/liquibot'
#
# Create Postgres then wire env:
#   .\scripts\setup-render-env.ps1 -CreateDatabase -DatabaseName liquibot-db

param(
  [string]$ApiKey = $env:RENDER_API_KEY,
  [string]$ServiceName = 'liquibot-back',
  [string]$DatabaseUrl = $env:RENDER_DATABASE_URL,
  [string]$EaApiKey = '',
  [string]$JwtSecret = '',
  [string]$DatabaseName = 'liquibot-db',
  [switch]$CreateDatabase,
  [switch]$ClearCache
)

$ErrorActionPreference = 'Stop'
$headers = @{
  Authorization  = "Bearer $ApiKey"
  Accept         = 'application/json'
  'Content-Type' = 'application/json'
}

if (-not $ApiKey) {
  Write-Host ''
  Write-Host 'Missing RENDER_API_KEY.'
  Write-Host ''
  Write-Host '1. Open https://dashboard.render.com/u/settings#api-keys'
  Write-Host '2. Create an API key'
  Write-Host '3. In PowerShell:'
  Write-Host "     `$env:RENDER_API_KEY = 'rnd_...'"
  Write-Host "     .\scripts\setup-render-env.ps1 -DatabaseUrl '<Internal Database URL>'"
  Write-Host ''
  Write-Host 'Or set env vars manually in the Dashboard (see backend/RENDER-FIX.txt).'
  Write-Host ''
  exit 1
}

if ($ApiKey -eq 'rnd_...' -or $ApiKey -match '^\s*rnd_\.+\s*$') {
  Write-Error 'RENDER_API_KEY is still the placeholder rnd_... Paste your real API key from the Render dashboard.'
}

function Invoke-Render {
  param([string]$Method, [string]$Path, $Body = $null)
  $uri = "https://api.render.com/v1$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
  }
  $json = if ($Body -is [string]) { $Body } else { ($Body | ConvertTo-Json -Depth 10 -Compress) }
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -Body $json
}

# Load EA_API_KEY from backend/.env if not passed
if (-not $EaApiKey) {
  $envFile = Join-Path $PSScriptRoot '..\backend\.env'
  if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
      if ($_ -match '^\s*EA_API_KEY\s*=\s*(.+)\s*$') {
        $script:EaApiKey = $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
}
if (-not $EaApiKey) {
  Write-Error 'EA_API_KEY not found. Pass -EaApiKey or set it in backend/.env'
}
if (-not $JwtSecret) {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $JwtSecret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

Write-Host ("JWT_SECRET generated ({0} hex chars)" -f $JwtSecret.Length)
$eaPrefix = $EaApiKey.Substring(0, [Math]::Min(8, $EaApiKey.Length))
Write-Host ("EA_API_KEY loaded (prefix {0}...)" -f $eaPrefix)

# Optional: create Postgres
if ($CreateDatabase) {
  Write-Host ("Creating Postgres '{0}'..." -f $DatabaseName)
  $ownerId = (Invoke-Render GET '/owners')[0].owner.id
  $pgBody = @{
    name         = $DatabaseName
    ownerId      = $ownerId
    databaseName = 'liquibot'
    databaseUser = 'liquibot'
    plan         = 'basic_256mb'
    region       = 'oregon'
    version      = '16'
  }
  $created = Invoke-Render POST '/postgres' $pgBody
  $pgId = $created.postgres.id
  Write-Host ("Created postgres id={0} - waiting for connection info..." -f $pgId)
  Start-Sleep -Seconds 8
  $pg = Invoke-Render GET "/postgres/$pgId"
  $DatabaseUrl = $pg.postgres.connectionInfo.internalConnectionString
  if (-not $DatabaseUrl) {
    Write-Error 'Postgres created but Internal URL not ready yet. Re-run with -DatabaseUrl once Connect shows it.'
  }
  Write-Host 'Got Internal Database URL from new Postgres.'
}

if (-not $DatabaseUrl) {
  Write-Host ''
  Write-Host 'DATABASE_URL is required (Render Internal URL, not localhost).'
  Write-Host ''
  Write-Host 'Dashboard: PostgreSQL -> your DB -> Connect -> Internal Database URL'
  Write-Host 'Then:'
  Write-Host "  .\scripts\setup-render-env.ps1 -DatabaseUrl 'postgresql://...'"
  Write-Host ''
  Write-Host 'Or create one:'
  Write-Host '  .\scripts\setup-render-env.ps1 -CreateDatabase'
  Write-Host ''
  exit 1
}

if ($DatabaseUrl -match '\.\.\.|dpg-\.\.\.|PLACEHOLDER') {
  Write-Error 'DATABASE_URL still looks like a placeholder. Paste the real Internal Database URL from Render Postgres -> Connect.'
}

if ($DatabaseUrl -match 'localhost|127\.0\.0\.1') {
  Write-Error 'DATABASE_URL points at localhost. Render needs the Internal Database URL from Render Postgres.'
}

# Find web service
Write-Host ("Looking up service '{0}'..." -f $ServiceName)
$services = Invoke-Render GET '/services?limit=50'
$svc = $services | Where-Object { $_.service.name -eq $ServiceName } | Select-Object -First 1
if (-not $svc) {
  Write-Host 'Services found:'
  $services | ForEach-Object { Write-Host ("  - {0} ({1})" -f $_.service.name, $_.service.id) }
  Write-Error ("Service '{0}' not found." -f $ServiceName)
}
$serviceId = $svc.service.id
Write-Host ("Found {0} ({1})" -f $ServiceName, $serviceId)

# Merge env vars (PUT replaces the full set - fetch existing first)
$existing = Invoke-Render GET "/services/$serviceId/env-vars"
$envMap = @{}
foreach ($e in $existing) {
  if ($e.envVar.key) {
    $envMap[$e.envVar.key] = $e.envVar.value
  }
}

$envMap['DATABASE_URL'] = $DatabaseUrl
$envMap['JWT_SECRET'] = $JwtSecret
$envMap['EA_API_KEY'] = $EaApiKey
$envMap['NODE_ENV'] = 'production'
if (-not $envMap.ContainsKey('NODE_VERSION')) {
  $envMap['NODE_VERSION'] = '20'
}

$payload = @()
foreach ($k in $envMap.Keys) {
  $payload += @{ key = $k; value = $envMap[$k] }
}

Write-Host ("Updating {0} env vars (DATABASE_URL, JWT_SECRET, EA_API_KEY, NODE_ENV + existing)..." -f $payload.Count)
Invoke-Render PUT "/services/$serviceId/env-vars" $payload | Out-Null
Write-Host 'Env vars updated.'

$clear = if ($PSBoundParameters.ContainsKey('ClearCache')) { [bool]$ClearCache } else { $true }
$deployBody = @{ clearCache = if ($clear) { 'clear' } else { 'do_not_clear' } }
Write-Host ("Triggering deploy (clearCache={0})..." -f $deployBody.clearCache)
$deploy = Invoke-Render POST "/services/$serviceId/deploys" $deployBody
$deployId = $deploy.id
Write-Host ("Deploy started: {0}" -f $deployId)
Write-Host ("Dashboard: https://dashboard.render.com/web/{0}" -f $serviceId)
Write-Host ''
Write-Host 'When logs show: LiquiBot backend v4.0 LIVE on port ...'
Write-Host 'Check: https://liquibot-back.onrender.com/test'
Write-Host 'Expect JWT validate (not sk_live_): POST /api/ea/validate'
Write-Host ''
Write-Host 'Saved JWT_SECRET for your notes (also set on Render):'
Write-Host $JwtSecret
