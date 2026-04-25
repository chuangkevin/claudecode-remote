# Stop claudecode-remote
Write-Host "Stopping claudecode-remote..." -ForegroundColor Cyan

$pid_ = netstat -ano | Select-String ":9224\s.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($pid_) {
    Write-Host "  Killing PID $pid_..." -ForegroundColor Yellow
    Stop-Process -Id ([int]$pid_) -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Server stopped" -ForegroundColor Green
} else {
    Write-Host "  No server running on port 9224" -ForegroundColor Gray
}

Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
