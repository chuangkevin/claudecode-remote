# Restart claudecode-remote service

Write-Host "Stopping claudecode-remote..." -ForegroundColor Yellow

# Kill process on port 9224
$existing = netstat -ano | Select-String ":9224.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($existing) {
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Write-Host "  Stopped (PID $existing)" -ForegroundColor Gray
}

Start-Sleep -Seconds 2

Write-Host "Starting claudecode-remote..." -ForegroundColor Cyan

Set-Location "D:\GitClone\_HomeProject\claudecode-remote"
npm start
