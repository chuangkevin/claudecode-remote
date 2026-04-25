# claudecode-remote — Windows one-click install
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
param([int]$Port = 9224)

# No $ErrorActionPreference = "Stop" — PS 5.1 wraps native-command stderr as
# ErrorRecords when 2>&1 is used, which would cause false terminating errors.

$ScriptDir   = Split-Path $MyInvocation.MyCommand.Path -Parent
$ProjectRoot = if ($ScriptDir -match '[/\\]scripts$') { Split-Path $ScriptDir -Parent } else { $ScriptDir }

function Step($msg) { Write-Host "" ; Write-Host ">> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   !!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "   ERR $msg" -ForegroundColor Red ; exit 1 }

Write-Host "=== ClaudeCode Remote - Windows Install ===" -ForegroundColor Cyan
Write-Host "    Project: $ProjectRoot"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
Step "Checking prerequisites"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js not found - install from https://nodejs.org"
}
$nodeVer = (node --version 2>&1) | Select-Object -First 1
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "Git not found"
}
Ok "Node $nodeVer"

# ── 2. .env ───────────────────────────────────────────────────────────────────
Step "Checking .env"
$envFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $envFile)) {
    $example = Join-Path $ProjectRoot ".env.example"
    if (Test-Path $example) {
        Copy-Item $example $envFile
        Warn ".env created from .env.example - review it before first use"
    } else {
        Set-Content $envFile "PORT=$Port`r`nWORKSPACE_ROOT=$env:USERPROFILE"
        Warn "Minimal .env created - edit $envFile as needed"
    }
} else {
    Ok ".env exists"
}

# ── 3. npm install ────────────────────────────────────────────────────────────
Step "Installing npm dependencies"
Push-Location $ProjectRoot
npm install
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "npm install failed" }
Ok "Dependencies installed"

# ── 4. Build ──────────────────────────────────────────────────────────────────
Step "Building server + web"
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "Build failed" }
Pop-Location
Ok "Build complete"

# ── 5. Registry Run key (login auto-start) ────────────────────────────────────
Step "Registering login auto-start (Registry Run key)"
$regKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$startCmd = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ProjectRoot\start-hidden.ps1`""
try {
    Set-ItemProperty -Path $regKey -Name "ClaudeCodeRemote" -Value $startCmd -ErrorAction Stop
    Ok "Registry HKCU\Run\ClaudeCodeRemote set"
} catch {
    Warn "Could not set Registry entry: $_"
}

# ── 6. Task Scheduler watchdog (every 1 minute, fully hidden) ────────────────
Step "Creating Task Scheduler watchdog (every minute, hidden)"

# Remove existing task (ignore errors if not present)
& schtasks.exe /delete /tn "ClaudeCodeRemote-Watchdog" /f 2>$null

try {
    $action   = New-ScheduledTaskAction -Execute "powershell.exe" `
                    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProjectRoot\watchdog.ps1`""
    $trigger  = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 1) `
                    -Once -At (Get-Date)
    $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "ClaudeCodeRemote-Watchdog" `
        -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
    Ok "Watchdog task created (runs every minute, fully hidden)"
} catch {
    Warn "Watchdog task creation failed: $_"
    Warn "Run this script as Administrator to enable the watchdog"
}

# ── 7. Start server ───────────────────────────────────────────────────────────
Step "Starting server"
& "$ProjectRoot\start-hidden.ps1"

# ── 8. Health check ───────────────────────────────────────────────────────────
Step "Health check"
$healthy = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" `
            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        Ok "http://localhost:$Port/api/health -> $($resp.Content)"
        $healthy = $true
        break
    } catch { }
}
if (-not $healthy) { Fail "Health check failed after 15s - check server.log" }

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Install complete! ===" -ForegroundColor Green
Write-Host "    URL:       http://localhost:$Port" -ForegroundColor Cyan
Write-Host "    Start:     .\start-hidden.ps1"
Write-Host "    Stop:      .\stop.ps1"
Write-Host "    Uninstall: .\scripts\uninstall.ps1"
