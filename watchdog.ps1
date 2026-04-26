# Watchdog: if port 9224 is not listening, start the server
# Also checks Claude auth token expiry and logs warnings

$projectRoot = "D:\GitClone\_HomeProject\claudecode-remote"
$logPath     = Join-Path $projectRoot "watchdog.log"
$ts          = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

# ── Auth token expiry check ───────────────────────────────────────────────────
$credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
if (Test-Path $credPath) {
    try {
        $cred      = Get-Content $credPath -Raw | ConvertFrom-Json
        $expiresAt = $cred.claudeAiOauth.expiresAt
        if ($expiresAt) {
            $nowMs  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            $diffMs = $expiresAt - $nowMs
            if ($diffMs -lt 0) {
                $agoH = [math]::Round(-$diffMs / 3600000, 1)
                Add-Content -Path $logPath -Value "$ts [auth] EXPIRED ${agoH}h ago — run: claude setup-token"
            } elseif ($diffMs -lt (6 * 3600000)) {
                $h = [math]::Round($diffMs / 3600000, 1)
                Add-Content -Path $logPath -Value "$ts [auth] expires in ${h}h — run: claude setup-token soon"
            }
        }
    } catch { }
}

# ── Port check + restart ──────────────────────────────────────────────────────
$listening = netstat -ano | Select-String ":9224\s.*LISTENING"
if (-not $listening) {
    Start-Process -WindowStyle Hidden `
        -FilePath "node" `
        -ArgumentList "--env-file=.env", "packages/server/dist/index.js" `
        -WorkingDirectory $projectRoot
    Add-Content -Path $logPath -Value "$ts [watchdog] server was down — restarted"
}
