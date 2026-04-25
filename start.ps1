# Start claudecode-remote (via pm2 with auto-restart)

Set-Location $PSScriptRoot

# Kill any stale process on port 9224
$existing = netstat -ano | Select-String ":9224.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1
if ($existing) {
    Write-Host "Stopping existing process (PID $existing)..." -ForegroundColor Yellow
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Delete any stale pm2 entry
pm2 delete claudecode-remote 2>$null

Write-Host "Starting claudecode-remote..." -ForegroundColor Cyan

pm2 start packages/server/dist/index.js `
    --name claudecode-remote `
    --node-args "--env-file=.env" `
    --cwd "$PSScriptRoot" `
    --restart-delay 3000 `
    --max-restarts 20 `
    --log "$PSScriptRoot\pm2.log"

pm2 save

Write-Host ""
Write-Host "✓ Started under pm2 (auto-restart on crash)" -ForegroundColor Green
Write-Host "  Health: http://localhost:9224/api/health" -ForegroundColor Cyan
Write-Host "  Logs:   pm2 logs claudecode-remote" -ForegroundColor Cyan
Write-Host "  Stop:   .\stop.ps1" -ForegroundColor Yellow
