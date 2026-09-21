# Generate Secrets for BuildStatusNotification
# Run this script to generate webhook secret and team token with their SHA-256 hashes

function New-Secret {
    param([string]$Purpose)

    Write-Host "`n=== Generating $Purpose ===" -ForegroundColor Cyan

    $bytes = [byte[]]::new(32)
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $rng.GetBytes($bytes)
    }
    finally {
        $rng.Dispose()
    }
    $raw = [Convert]::ToBase64String($bytes)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString(
        $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($raw))
    ).Replace("-", "")
    $sha256.Dispose()

    Write-Host "Raw Value (share securely):" -ForegroundColor Yellow
    Write-Host "  $raw" -ForegroundColor White
    Write-Host "`nSHA-256 Hash (store in config):" -ForegroundColor Yellow
    Write-Host "  $hash" -ForegroundColor White

    # Explicitly return to avoid pipeline pollution
    [pscustomobject]@{ Raw = $raw; Sha256 = $hash }
}

Write-Host "BuildStatusNotification Secret Generator" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

$webhook = New-Secret -Purpose "Webhook Secret"
$team = New-Secret -Purpose "Team Access Token"

Write-Host "`n=== Configuration Instructions ===" -ForegroundColor Cyan
Write-Host "`n1. Backend Configuration (appsettings.json or environment variables):" -ForegroundColor Yellow
Write-Host "   Notifier__WebhookSecretSha256 = $($webhook.Sha256)"
Write-Host "   Notifier__TeamTokenSha256 = $($team.Sha256)"

Write-Host "`n2. TeamCity Configuration:" -ForegroundColor Yellow
Write-Host "   Set environment variable on build agent:"
Write-Host "   NOTIFIER_SECRET = $($webhook.Raw)"

Write-Host "`n3. Extension Configuration:" -ForegroundColor Yellow
Write-Host "   Enter in extension options page:"
Write-Host "   Access Token = $($team.Raw)"

Write-Host "`n=== SECURITY NOTES ===" -ForegroundColor Red
Write-Host "- Save raw values in password manager"
Write-Host "- Only store SHA-256 hashes in appsettings.json"
Write-Host "- Never commit raw values to git"
Write-Host "- Webhook secret and team token must be DIFFERENT values"
Write-Host ""
