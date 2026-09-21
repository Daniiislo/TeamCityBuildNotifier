#requires -Version 5.1
<##
.SYNOPSIS
    Sends fake TeamCity build events to the local notifier API.

.EXAMPLES
    .\Test-TeamCityWebhook.ps1 start
    .\Test-TeamCityWebhook.ps1 finish
    .\Test-TeamCityWebhook.ps1 both
    .\Test-TeamCityWebhook.ps1 duplicate
    .\Test-TeamCityWebhook.ps1 failure
    .\Test-TeamCityWebhook.ps1 cancelled
    .\Test-TeamCityWebhook.ps1 health
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("start", "started", "finish", "finished", "both", "duplicate", "failure", "cancelled", "health")]
    [string]$Event = "both",

    # Use HTTP locally to avoid Windows PowerShell 5.1 certificate issues.
    [string]$BaseUrl = "http://localhost:5104",

    # Put the raw webhook secret here, or pass -WebhookSecret at runtime.
    [string]$WebhookSecret = "nR3sWIDvtNCC027IuxECM9HsNPtPouRxX0j8RsGxyAs=",

    [string]$BuildId = "",
    [string]$TeamCityBaseUrl = "https://teamcity.example",
    [switch]$IgnoreCertificate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($WebhookSecret) -or $WebhookSecret -eq "PUT_RAW_WEBHOOK_SECRET_HERE") {
    throw "Configure the raw webhook secret in this script or pass -WebhookSecret. Do not use the SHA-256 hash here."
}

$previousCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback

function Send-Webhook {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Payload,
        [Parameter(Mandatory = $true)]
        [string]$Url
    )

    $json = $Payload | ConvertTo-Json -Depth 10 -Compress
    Write-Host "Sending $($Payload.event) event for build $($Payload.buildId) ..." -ForegroundColor Cyan

    try {
        $response = Invoke-WebRequest `
            -Uri $Url `
            -Method Post `
            -ContentType "application/json" `
            -Headers @{ "X-TeamCity-Secret" = $WebhookSecret } `
            -Body $json

        Write-Host "HTTP $([int]$response.StatusCode): $($response.Content)" -ForegroundColor Green
        return $response
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }

        throw "Webhook request failed. HTTP status: $statusCode. $($_.Exception.Message)"
    }
}

try {
    if ($IgnoreCertificate) {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    }

    $rootUrl = $BaseUrl.TrimEnd('/')
    $healthUrl = "$rootUrl/health"
    $webhookUrl = "$rootUrl/webhooks/teamcity"

    Write-Host "Checking API health: $healthUrl" -ForegroundColor Cyan
    $health = Invoke-RestMethod -Uri $healthUrl -Method Get
    Write-Host "Health: $($health.status)" -ForegroundColor Green

    if ($health.status -ne "Healthy") {
        throw "API health check did not return Healthy."
    }

    if ($Event -eq "health") {
        Write-Host "Health check completed." -ForegroundColor Green
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($BuildId)) {
        $BuildId = "local-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    }

    # A finished build finished in the past; stamping it in the future is not
    # something TeamCity ever sends, and clients may treat it as scheduled.
    $finishedAt = [DateTimeOffset]::UtcNow
    $startedAt = $finishedAt.AddSeconds(-42)
    # Short, like a real %build.number% (the fixture uses "320"). Uniqueness for
    # notification dedup comes from $BuildId, not from this.
    $buildNumber = [DateTime]::UtcNow.ToString('HHmmss')
    $buildUrl = "$($TeamCityBaseUrl.TrimEnd('/'))/viewLog.html?buildId=$BuildId"

    $startedPayload = @{
        event = "started"
        buildId = $BuildId
        buildTypeId = "Local_Test_Build"
        projectId = "Local_Test_Project"
        projectName = "Local Test Project"
        buildName = "Webhook Test"
        buildTitle = "Local - TeamCity Webhook Test"
        buildNumber = $buildNumber
        branch = "develop"
        status = "RUNNING"
        statusText = "Build Started"
        triggeredBy = "Local webhook test"
        startedAt = $startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        finishedAt = $null
        durationSeconds = $null
        buildUrl = $buildUrl
        logUrl = $null
        projects = @("Api", "Worker")
    }

    $finishedStatus = "SUCCESS"
    $finishedStatusText = "Build Succeeded"
    if ($Event -eq "failure") {
        $finishedStatus = "FAILURE"
        $finishedStatusText = "Build Failed"
    }
    elseif ($Event -eq "cancelled") {
        $finishedStatus = "CANCELLED"
        $finishedStatusText = "Build Cancelled"
    }

    $finishedPayload = @{
        event = "finished"
        buildId = $BuildId
        buildTypeId = "Local_Test_Build"
        projectId = "Local_Test_Project"
        projectName = "Local Test Project"
        buildName = "Webhook Test"
        buildTitle = "Local - TeamCity Webhook Test"
        buildNumber = $buildNumber
        branch = "develop"
        status = $finishedStatus
        statusText = $finishedStatusText
        triggeredBy = "Local webhook test"
        startedAt = $startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        finishedAt = $finishedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        durationSeconds = 42
        buildUrl = $buildUrl
        logUrl = "$buildUrl&tab=buildLog"
        projects = @("Api", "Worker")
    }

    switch ($Event) {
        "start" { [void](Send-Webhook -Payload $startedPayload -Url $webhookUrl) }
        "started" { [void](Send-Webhook -Payload $startedPayload -Url $webhookUrl) }
        "finish" { [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl) }
        "finished" { [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl) }
        "failure" { [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl) }
        "cancelled" { [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl) }
        "both" {
            [void](Send-Webhook -Payload $startedPayload -Url $webhookUrl)
            [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl)
        }
        "duplicate" {
            [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl)
            Write-Host "Sending the same finished event again to test deduplication ..." -ForegroundColor Cyan
            [void](Send-Webhook -Payload $finishedPayload -Url $webhookUrl)
        }
    }

    Write-Host "Test completed." -ForegroundColor Green
}
finally {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCallback
}
