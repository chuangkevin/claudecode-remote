# Watchdog: if port 9224 is not listening, start the server.
# Path is derived from this script's location, so the repo can move.

$projectRoot = $PSScriptRoot
$logPath     = Join-Path $projectRoot "watchdog.log"
$ts          = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# Defer auth-token expiry checking to check-auth.ps1 (which is .env-aware).
# Its LogWarn function already writes to watchdog.log on issues.
& "$projectRoot\check-auth.ps1" *> $null

# Port check + restart
$listening = netstat -ano | Select-String ":9224\s.*LISTENING"
if (-not $listening) {
    Start-Process -WindowStyle Hidden `
        -FilePath "node" `
        -ArgumentList "--env-file=.env", "packages/server/dist/index.js" `
        -WorkingDirectory $projectRoot
    Add-Content -Path $logPath -Value "$ts [watchdog] server was down — restarted"
}
