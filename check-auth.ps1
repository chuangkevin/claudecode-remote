# check-auth.ps1 — verify Claude auth before server start
# Priority: .env CLAUDE_CODE_OAUTH_TOKEN (long-lived) > ~/.claude/.credentials.json (short-lived OAuth)
# Returns exit 0 if ok, 1 if not configured (logs warning but does not block)

$envPath  = Join-Path $PSScriptRoot ".env"
$credPath = Join-Path $env:USERPROFILE ".claude\.credentials.json"
$logPath  = Join-Path $PSScriptRoot "watchdog.log"

function LogWarn($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "  !! $msg" -ForegroundColor Yellow
    Add-Content -Path $logPath -Value "$ts [auth] WARNING: $msg" -ErrorAction SilentlyContinue
}

# ── 1) Prefer .env CLAUDE_CODE_OAUTH_TOKEN ────────────────────────────────────
# This is what `node --env-file=.env` loads into process.env, then inherited by
# the spawned `claude` CLI. Long-lived (1 year), produced by `claude setup-token`.
if (Test-Path $envPath) {
    $envContent = Get-Content $envPath -Raw -ErrorAction SilentlyContinue
    if ($envContent -match '(?m)^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$') {
        $token = $Matches[1].Trim().Trim('"').Trim("'")
        # Reject empty / placeholder values
        if ($token -and $token.Length -gt 20 -and $token -notmatch '^sk-ant-oat01-\.\.\.$') {
            Write-Host "  OK  Claude auth: long-lived token in .env (1 year)" -ForegroundColor Green
            exit 0
        }
    }
}

# ── 2) Fallback: credentials.json (claude login) ──────────────────────────────
if (-not (Test-Path $credPath)) {
    LogWarn "No CLAUDE_CODE_OAUTH_TOKEN in .env and no ~/.claude/.credentials.json — run: claude setup-token"
    exit 1
}

try {
    $cred = Get-Content $credPath -Raw | ConvertFrom-Json
    $expiresAt = $cred.claudeAiOauth.expiresAt
    if (-not $expiresAt) {
        Write-Host "  OK  Claude auth: credentials.json long-lived (no expiry)" -ForegroundColor Green
        exit 0
    }

    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $diffMs = $expiresAt - $nowMs
    $diffH  = [math]::Round($diffMs / 3600000, 1)

    if ($diffMs -lt 0) {
        $expiredAgoH = [math]::Round(-$diffMs / 3600000, 1)
        LogWarn "OAuth access token expired ${expiredAgoH}h ago — run: claude setup-token (then put token in .env)"
        exit 1
    } elseif ($diffMs -lt (24 * 3600000)) {
        LogWarn "OAuth access token expires in ${diffH}h — consider: claude setup-token (then put token in .env)"
        exit 0
    } else {
        Write-Host "  OK  Claude auth: credentials.json valid for ${diffH}h" -ForegroundColor Green
        exit 0
    }
} catch {
    LogWarn "Could not parse credentials: $_"
    exit 1
}
