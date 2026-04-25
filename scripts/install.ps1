# claudecode-remote — Windows one-click install
# Run from project root or scripts/ directory:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
[CmdletBinding()]
param([int]$Port = 9224)

$ErrorActionPreference = "Stop"
$ScriptDir  = Split-Path $MyInvocation.MyCommand.Path -Parent
$ProjectRoot = if ($ScriptDir -match "scripts$") { Split-Path $ScriptDir -Parent } else { $ScriptDir }

function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   ✓ $msg"  -ForegroundColor Green }
function Warn($msg) { Write-Host "   ⚠ $msg"  -ForegroundColor Yellow }
function Fail($msg) { Write-Host "   ✗ $msg"  -ForegroundColor Red; exit 1 }

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   ClaudeCode Remote — Windows Setup  ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host "   Project: $ProjectRoot"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
Step "Checking prerequisites"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js not found — install from https://nodejs.org" }
$nodeVer = node --version
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Fail "Git not found" }
Ok "Node $nodeVer, Git $(git --version)"

# ── 2. .env ───────────────────────────────────────────────────────────────────
Step "Checking .env"
$envFile = "$ProjectRoot\.env"
if (-not (Test-Path $envFile)) {
    $example = "$ProjectRoot\.env.example"
    if (Test-Path $example) {
        Copy-Item $example $envFile
        Warn ".env created from .env.example — review it before first use"
    } else {
        Set-Content $envFile "PORT=$Port`nWORKSPACE_ROOT=$env:USERPROFILE"
        Warn "Minimal .env created — edit $envFile as needed"
    }
} else { Ok ".env exists" }

# ── 3. npm install ────────────────────────────────────────────────────────────
Step "Installing npm dependencies"
Set-Location $ProjectRoot
npm install --silent 2>&1 | Out-Null
Ok "Dependencies installed"

# ── 4. Build ──────────────────────────────────────────────────────────────────
Step "Building server + web"
$buildOut = npm run build 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host $buildOut; Fail "Build failed" }
Ok "Build complete"

# ── 5. Registry Run key (login auto-start) ────────────────────────────────────
Step "Registering login auto-start"
$regKey  = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$regName = "ClaudeCodeRemote"
$startCmd = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ProjectRoot\start-hidden.ps1`""
Set-ItemProperty -Path $regKey -Name $regName -Value $startCmd
Ok "Registry HKCU\Run\ClaudeCodeRemote set"

# ── 6. Task Scheduler watchdog (every 1 minute) ───────────────────────────────
Step "Creating watchdog task (Task Scheduler, every minute)"
schtasks /delete /tn "ClaudeCodeRemote-Watchdog" /f 2>$null | Out-Null
$watchCmd = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ProjectRoot\watchdog.ps1`""
$result = schtasks /create /tn "ClaudeCodeRemote-Watchdog" /tr $watchCmd /sc minute /mo 1 /ru "$env:USERNAME" /f 2>&1
if ($LASTEXITCODE -ne 0) {
    Warn "Watchdog task failed (may need admin): $result"
    Warn "Run as Administrator to enable the watchdog"
} else { Ok "Watchdog task created" }

# ── 7. Start server ───────────────────────────────────────────────────────────
Step "Starting server"
& "$ProjectRoot\start-hidden.ps1"

# ── 8. Health check ───────────────────────────────────────────────────────────
Step "Verifying health"
$ok = $false
for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 3
        Ok "http://localhost:$Port/api/health → $($resp.Content)"
        $ok = $true; break
    } catch { }
}
if (-not $ok) { Fail "Health check failed after 10s — check server.log" }

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║          Install complete!           ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Green
Write-Host "   URL:        http://localhost:$Port" -ForegroundColor Cyan
Write-Host "   Start:      .\start-hidden.ps1"
Write-Host "   Stop:       .\stop.ps1"
Write-Host "   Watchdog:   Task Scheduler > ClaudeCodeRemote-Watchdog"
Write-Host "   Uninstall:  .\scripts\uninstall.ps1"
