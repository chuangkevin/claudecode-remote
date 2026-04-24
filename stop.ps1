# Stop claudecode-remote service

Write-Host "Stopping claudecode-remote..." -ForegroundColor Cyan

# Find and kill process on port 9224
$proxy = netstat -ano | Select-String ":9224.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($proxy) {
    Write-Host "  Stopping server (PID $proxy)..." -ForegroundColor Yellow
    Stop-Process -Id $proxy -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Server stopped" -ForegroundColor Green
} else {
    Write-Host "  No server running on port 9224" -ForegroundColor Gray
}

Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
