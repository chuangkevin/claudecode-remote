# check-auth.ps1 — verify Claude OAuth token validity before server start
# Returns exit code 0 if ok, 1 if expired (logs warning but does not block)

$credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
$logPath  = Join-Path $PSScriptRoot "watchdog.log"

function LogWarn($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "  !! $msg" -ForegroundColor Yellow
    Add-Content -Path $logPath -Value "$ts [auth] WARNING: $msg" -ErrorAction SilentlyContinue
}

if (-not (Test-Path $credPath)) {
    LogWarn "~/.claude/.credentials.json not found — run: claude login"
    exit 1
}

try {
    $cred = Get-Content $credPath -Raw | ConvertFrom-Json
    $expiresAt = $cred.claudeAiOauth.expiresAt
    if (-not $expiresAt) {
        # setup-token style credentials have no expiresAt — always valid
        Write-Host "  OK  Claude auth: long-lived token (no expiry)" -ForegroundColor Green
        exit 0
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $diffMs = $expiresAt - $nowMs
    $diffH  = [math]::Round($diffMs / 3600000, 1)

    if ($diffMs -lt 0) {
        $expiredAgoH = [math]::Round(-$diffMs / 3600000, 1)
        LogWarn "OAuth access token expired ${expiredAgoH}h ago — run: claude setup-token"
        exit 1
    } elseif ($diffMs -lt (24 * 3600000)) {
        LogWarn "OAuth access token expires in ${diffH}h — consider: claude setup-token"
        exit 0
    } else {
        Write-Host "  OK  Claude auth: token valid for ${diffH}h" -ForegroundColor Green
        exit 0
    }
} catch {
    LogWarn "Could not parse credentials: $_"
    exit 1
}
