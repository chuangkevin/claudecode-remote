# Start claudecode-remote in background (no pm2)
Set-Location $PSScriptRoot

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

Start-Sleep -Seconds 2

$check = netstat -ano | Select-String ":9224\s.*LISTENING"
if ($check) {
    Write-Host "✓ claudecode-remote started on port 9224" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to start — check node / .env" -ForegroundColor Red
}
