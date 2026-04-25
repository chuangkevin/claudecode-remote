# Watchdog: if port 9224 is not listening, start the server
$listening = netstat -ano | Select-String ":9224\s.*LISTENING"
if (-not $listening) {
    Start-Process -WindowStyle Hidden `
        -FilePath "node" `
        -ArgumentList "--env-file=.env", "packages/server/dist/index.js" `
        -WorkingDirectory "D:\GitClone\_HomeProject\claudecode-remote"
    # Log restart
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path "D:\GitClone\_HomeProject\claudecode-remote\watchdog.log" -Value "$ts [watchdog] server was down — restarted"
}
