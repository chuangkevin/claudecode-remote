# Stop claudecode-remote service

Write-Host "Stopping claudecode-remote..." -ForegroundColor Cyan

pm2 stop claudecode-remote 2>$null
pm2 delete claudecode-remote 2>$null

# Fallback: kill any remaining process on port 9224
$proxy = netstat -ano | Select-String ":9224.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($proxy) {
    Stop-Process -Id $proxy -Force -ErrorAction SilentlyContinue
}

Write-Host "✓ Server stopped" -ForegroundColor Green
Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
