# IIS Deployment Guide

## Prerequisites

1. Windows Server with IIS installed
2. .NET 8 ASP.NET Core Hosting Bundle: https://dotnet.microsoft.com/download/dotnet/8.0
3. IIS WebSocket Protocol feature enabled
4. Trusted TLS certificate
5. Public hostname configured (e.g., `buildnotify.example`)

## Enable WebSocket Protocol

```powershell
Install-WindowsFeature -Name Web-WebSockets
```

Or via Server Manager: Add Roles and Features → Web Server (IIS) → Application Development → WebSocket Protocol

## Generate Secrets

Run the secret generation script:

```powershell
.\scripts\Generate-Secrets.ps1
```

Save the raw values in a password manager. You'll need:
- **Webhook secret** → for TeamCity configuration
- **Team token** → for extension users

## Build and Publish

```powershell
dotnet publish BuildStatusNotification -c Release -o C:\Deploy\BuildStatusNotification
```

## Create Application Pool

1. Open IIS Manager
2. Application Pools → Add Application Pool
   - Name: `BuildStatusNotification`
   - .NET CLR version: **No Managed Code**
   - Managed pipeline mode: **Integrated**
3. Advanced Settings:
   - Start Mode: **AlwaysRunning**
   - Idle Time-out (minutes): **0**
   - Maximum Worker Processes: **1** (critical - replay state is in-process)

## Create Web Site

1. Sites → Add Website
   - Site name: `BuildStatusNotification`
   - Application pool: `BuildStatusNotification`
   - Physical path: `C:\Deploy\BuildStatusNotification`
   - Binding:
     - Type: **https**
     - Port: **443**
     - Host name: `buildnotify.example`
     - SSL certificate: select your trusted certificate

## Configure Secrets

### Option 1: Environment Variables (Recommended)

Set at Application Pool level via IIS Manager or PowerShell:

```powershell
$appPoolName = "BuildStatusNotification"

# Replace with actual hashes from Generate-Secrets.ps1
$teamTokenHash = "YOUR_TEAM_TOKEN_SHA256_HASH"
$webhookSecretHash = "YOUR_WEBHOOK_SECRET_SHA256_HASH"
$teamCityBaseUrl = "https://teamcity.example"

Set-WebConfigurationProperty -PSPath "IIS:\AppPools\$appPoolName" `
    -Name environmentVariables `
    -Value @{
        name = "Notifier__TeamTokenSha256"
        value = $teamTokenHash
    }

Set-WebConfigurationProperty -PSPath "IIS:\AppPools\$appPoolName" `
    -Name environmentVariables `
    -Value @{
        name = "Notifier__WebhookSecretSha256"
        value = $webhookSecretHash
    }

Set-WebConfigurationProperty -PSPath "IIS:\AppPools\$appPoolName" `
    -Name environmentVariables `
    -Value @{
        name = "Notifier__TeamCityBaseUrl"
        value = $teamCityBaseUrl
    }

Set-WebConfigurationProperty -PSPath "IIS:\AppPools\$appPoolName" `
    -Name environmentVariables `
    -Value @{
        name = "ASPNETCORE_ENVIRONMENT"
        value = "Production"
    }
```

### Option 2: appsettings.Production.json

Copy `appsettings.Production.example.json` to `appsettings.Production.json` in the deployment folder and fill in the hashes. Protect with NTFS ACLs.

## Configure Log Directory

Create and secure the log directory:

```powershell
$logDir = "D:\AppData\BuildStatusNotification\Logs"
New-Item -ItemType Directory -Force -Path $logDir

# Grant write access to app pool identity
$acl = Get-Acl $logDir
$identity = "IIS AppPool\BuildStatusNotification"
$accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity,
    "Modify",
    "ContainerInherit,ObjectInherit",
    "None",
    "Allow"
)
$acl.SetAccessRule($accessRule)
Set-Acl $logDir $acl
```

## Start the Site

```powershell
Start-WebAppPool -Name "BuildStatusNotification"
Start-Website -Name "BuildStatusNotification"
```

## Verify

1. Check site is running: `https://buildnotify.example/health`
   - Should return: `{"status":"Healthy"}`

2. Test webhook endpoint with curl:

```powershell
$samplePayload = Get-Content docs/teamcity-payload.sample.json | ConvertFrom-Json
$webhookSecret = "YOUR_RAW_WEBHOOK_SECRET" # from Generate-Secrets.ps1

Invoke-RestMethod -Uri "https://buildnotify.example/webhooks/teamcity" `
    -Method Post `
    -ContentType "application/json" `
    -Headers @{ "X-TeamCity-Secret" = $webhookSecret } `
    -Body ($samplePayload.finished | ConvertTo-Json -Compress)
```

Expected:
- First call: `202` (accepted)
- Second call: `200` (duplicate)
- Wrong/missing secret: `401`

3. Check logs: `D:\AppData\BuildStatusNotification\Logs\`

4. Verify no secrets in logs:
```powershell
Select-String -Path "D:\AppData\BuildStatusNotification\Logs\*.jsonl" -Pattern "Bearer|access_token|X-TeamCity-Secret"
```
Should return nothing.

## Configure TeamCity

See `docs/teamcity-integration.md` for PowerShell script modifications.

Set on TeamCity build agent:
- `NOTIFIER_URL` = `https://buildnotify.example`
- `NOTIFIER_SECRET` = raw webhook secret from Generate-Secrets.ps1

## Troubleshooting

### Site won't start
- Check Event Viewer → Application logs
- Verify .NET 8 Hosting Bundle is installed
- Verify app pool identity has access to deployment folder

### WebSocket connections fail
- Verify WebSocket Protocol is enabled in IIS
- Check firewall allows WSS traffic
- If behind a proxy, ensure it supports WebSocket upgrades

### Notifications not received
- Check extension is connected (popup shows "Connected")
- Verify team token hash matches what extension is using
- Check SignalR hub logs in `D:\AppData\BuildStatusNotification\Logs\`

### "Unauthorized" in extension
- Regenerate secrets and reconfigure both backend and extension
- Verify SHA-256 hash calculation is correct

## Security Checklist

- [ ] TLS certificate is trusted on all team machines
- [ ] Only SHA-256 hashes stored in configuration
- [ ] Log directory has restricted ACLs
- [ ] Deployment folder has restricted ACLs
- [ ] Application pool runs as dedicated identity (not ApplicationPoolIdentity if shared)
- [ ] Secrets verified not in logs or IIS logs
- [ ] Webhook secret different from team token
- [ ] Team token stored in password manager for distribution

## Updates

To deploy a new version:

1. Stop the site:
```powershell
Stop-Website -Name "BuildStatusNotification"
```

2. Publish new version:
```powershell
dotnet publish BuildStatusNotification -c Release -o C:\Deploy\BuildStatusNotification
```

3. Start the site:
```powershell
Start-Website -Name "BuildStatusNotification"
```

Extensions will automatically reconnect.
