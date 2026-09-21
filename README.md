# TeamCity Build Notifier

Real-time TeamCity build notifications via Chrome/Edge extension.

## Architecture

- **Backend:** .NET 8 Minimal API on IIS, receives TeamCity webhooks, broadcasts via SignalR
- **Frontend:** Chrome/Edge Manifest V3 extension, displays desktop notifications
- **Security:** Separate webhook secret and team token, SHA-256 hashes stored
- **State:** 200-item RAM buffer (60min TTL), 14-day JSONL audit logs

## Repository Structure

```
BuildStatusNotification/          # .NET 8 Minimal API
BuildStatusNotification.Tests/    # xUnit tests
extension/                         # Chrome/Edge extension
docs/                             # Design specs and integration guides
```

## Quick Start

### Backend

1. Install .NET 8 SDK and IIS with WebSocket support
2. Generate secrets:
```powershell
function New-Secret {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $raw  = [Convert]::ToBase64String($bytes)
  $hash = [BitConverter]::ToString(
            [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($raw))
          ).Replace("-", "")
  [pscustomobject]@{ Raw = $raw; Sha256 = $hash }
}
$webhook = New-Secret
$team    = New-Secret
```

3. Configure `appsettings.json` with the SHA-256 hashes
4. Build and run:
```bash
dotnet build
dotnet test
dotnet run --project BuildStatusNotification
```

### Extension

1. Install dependencies:
```bash
cd extension
npm install
```

2. Build:
```bash
npm run build
```

3. Load unpacked extension from `extension/dist/` in Chrome/Edge
4. Configure in extension options:
   - Server URL (e.g., `https://buildnotify.example`)
   - Access Token (the raw team token from step 2)
   - TeamCity Base URL
   - Enable notifications

### TeamCity Integration

See `docs/teamcity-integration.md` for PowerShell script modifications.

## Testing

```bash
# Backend tests
dotnet test

# Extension tests
cd extension
npm test
```

## Documentation

- [Design Specification](docs/2026-09-18-teamcity-build-notifier-design.md)
- [Implementation Plan](docs/2026-09-18-teamcity-build-notifier.md)
- [TeamCity Integration](docs/teamcity-integration.md)
- [Extension Installation](docs/extension-install.md)

## Security Notes

- Store only SHA-256 hashes in configuration, never raw secrets
- Use different secrets for webhook and team token
- Backend validates all URLs against TeamCityBaseUrl
- Extension validates build URLs before opening
- No secrets logged to files or console

## Deployment

See implementation plan Task 9 for IIS deployment steps.

## License

Internal use only.
