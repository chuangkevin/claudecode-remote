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

Start-Process -WindowStyle Hidden `
    -FilePath "node" `
    -ArgumentList "--env-file=.env", "packages/server/dist/index.js" `
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
} else {
    Write-Host "✗ Failed to start within 15s — check node / .env / server.log" -ForegroundColor Red
}
