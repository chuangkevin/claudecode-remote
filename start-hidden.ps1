# Start claudecode-remote in background (no pm2)
Set-Location $PSScriptRoot

# Pre-flight: warn if Claude auth token is expired
& "$PSScriptRoot\check-auth.ps1"

# Kill any stale process on port 9224
$existing = netstat -ano | Select-String ":9224\s.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1
if ($existing) {
    Write-Host "Stopping existing process (PID $existing)..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$existing) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Add a startup marker so log boundaries are visible across restarts
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$serverLog = Join-Path $PSScriptRoot "server.log"
Add-Content -Path $serverLog -Value "`r`n=== $ts [start-hidden] starting node ==="

# Spawn via cmd /c so we can append stdout+stderr to server.log in one shot.
# (Start-Process -RedirectStandardOutput is overwrite-only; cmd's >> is append.)
Start-Process -WindowStyle Hidden `
    -FilePath "cmd.exe" `
    -ArgumentList "/c", "node --env-file=.env packages\server\dist\index.js >> server.log 2>&1" `
    -WorkingDirectory $PSScriptRoot

# Poll until port 9224 is listening (up to 15s — cold start needs SQLite init etc.)
$started = $false
for ($i = 1; $i -le 15; $i++) {
    Start-Sleep -Seconds 1
    if (netstat -ano | Select-String ":9224\s.*LISTENING") {
        $started = $true
        break
    }
}

if ($started) {
    Write-Host "✓ claudecode-remote started on port 9224 (after ${i}s)" -ForegroundColor Green
    Write-Host "  Log: $serverLog" -ForegroundColor DarkGray
} else {
    Write-Host "✗ Failed to start within 15s — see $serverLog" -ForegroundColor Red
}
