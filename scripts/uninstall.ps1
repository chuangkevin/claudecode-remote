# claudecode-remote — Windows one-click uninstall
[CmdletBinding()]
param([int]$Port = 9224)

$ScriptDir   = Split-Path $MyInvocation.MyCommand.Path -Parent
$ProjectRoot = if ($ScriptDir -match "scripts$") { Split-Path $ScriptDir -Parent } else { $ScriptDir }

function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   ✓ $msg"  -ForegroundColor Green }
function Skip($msg) { Write-Host "   - $msg"  -ForegroundColor Gray }

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Yellow
Write-Host "║  ClaudeCode Remote — Windows Remove  ║" -ForegroundColor Yellow
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Yellow

# ── 1. Stop server ────────────────────────────────────────────────────────────
Step "Stopping server"
$pid_ = netstat -ano | Select-String ":$Port\s.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1
if ($pid_) {
    Stop-Process -Id ([int]$pid_) -Force -ErrorAction SilentlyContinue
    Ok "Process PID $pid_ killed"
} else { Skip "Server was not running" }

# ── 2. Remove Registry Run key ────────────────────────────────────────────────
Step "Removing Registry startup entry"
$regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$entry  = Get-ItemProperty -Path $regKey -Name "ClaudeCodeRemote" -ErrorAction SilentlyContinue
if ($entry) {
    Remove-ItemProperty -Path $regKey -Name "ClaudeCodeRemote" -ErrorAction SilentlyContinue
    Ok "Registry HKCU\Run\ClaudeCodeRemote removed"
} else { Skip "Registry entry not found" }

# ── 3. Remove Task Scheduler tasks ───────────────────────────────────────────
Step "Removing Task Scheduler tasks"
foreach ($tn in @("ClaudeCodeRemote-Watchdog", "ClaudeCodeRemote-Startup")) {
    $exists = schtasks /query /tn $tn 2>&1
    if ($LASTEXITCODE -eq 0) {
        schtasks /delete /tn $tn /f | Out-Null
        Ok "Task '$tn' deleted"
    } else { Skip "Task '$tn' not found" }
}

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         Uninstall complete!          ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Green
Write-Host "   Note: node_modules/ and dist/ are not removed." -ForegroundColor Gray
Write-Host "   Delete them manually if you want a full clean." -ForegroundColor Gray
