# Start claudecode-remote (foreground)

# Kill any existing process on port 9224
$existing = netstat -ano | Select-String ":9224.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($existing) {
    Write-Host "Stopping existing process (PID $existing)..." -ForegroundColor Yellow
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Start the server
Write-Host "Starting claudecode-remote..." -ForegroundColor Cyan
Set-Location $PSScriptRoot
npm start
