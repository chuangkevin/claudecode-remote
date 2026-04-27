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

# Add a startup marker so log boundaries are visible across restarts.
# Retry briefly because the previous cmd.exe may still hold the file handle
# while flushing — race window is short, a couple of retries is enough.
$ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
$serverLog = Join-Path $PSScriptRoot "server.log"
for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
        Add-Content -Path $serverLog -Value "`r`n=== $ts [start-hidden] starting node ===" -ErrorAction Stop
        break
    } catch {
        if ($attempt -eq 5) { Write-Host "  !! could not write log header: $_" -ForegroundColor DarkYellow }
        else { Start-Sleep -Milliseconds 200 }
    }
}

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
