# TeamCity Build Notifier

Real-time TeamCity build notifications, delivered as desktop toasts and a
popup in a Chrome/Edge extension.

```text
TeamCity build agent  ──POST──►  .NET 8 API (IIS)  ──SignalR──►  Extension
  X-TeamCity-Secret              validates, dedupes,              desktop toast
                                  200-event / 60min buffer         popup + status
```

- **Backend** (`BuildStatusNotification/`) — .NET 8 Minimal API. Receives
  TeamCity webhooks, validates and de-duplicates them, broadcasts over
  SignalR. No database — state is an in-memory ring buffer.
- **Extension** (`extension/`) — Chrome/Edge Manifest V3. Desktop
  notifications, a popup with recent history and an on-demand "current
  status" pull, colour-coded by build result.
- **Security** — two independent secrets (webhook secret, team token), only
  their SHA-256 hashes ever stored; raw values live in a password manager.

## Repository structure

```text
BuildStatusNotification/          .NET 8 Minimal API
BuildStatusNotification.Tests/    xUnit tests
extension/                        Chrome/Edge extension
scripts/                          Secret generation, webhook test helper
docs/                             Design docs, integration contract, setup guide
```

## Setting this up in production

**[docs/production-setup.md](docs/production-setup.md)** is the full,
step-by-step guide — prerequisites, generating secrets, IIS deployment,
TeamCity script changes, building and installing the extension, end-to-end
verification, secret rotation, and troubleshooting. Start there for a real
deployment.

## Local development

### Backend

```bash
dotnet build
dotnet test
dotnet run --project BuildStatusNotification
```

Runs on `http://localhost:5104` with `ASPNETCORE_ENVIRONMENT=Development`
(set in `Properties/launchSettings.json`), which loads
`appsettings.Development.json` — already populated with working dev secrets.

### Extension

```bash
cd extension
npm install
npm test
npm run build
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `extension/dist`. Open the extension's Options page and point it at
`http://localhost:5104` with the dev team token from
`appsettings.Development.json` (hash it yourself, or see
[docs/production-setup.md §9.3](docs/production-setup.md#93-webhook-returns-401)
for the one-liner).

### Sending a test build event

No TeamCity instance needed:

```powershell
.\scripts\Test-TeamCityWebhook.ps1 both
```

Modes: `start`, `finish`, `both`, `duplicate`, `failure`, `cancelled`, `health`.
The payload contract itself lives in `docs/teamcity-payload.sample.json`.

## Documentation

- **[Production setup guide](docs/production-setup.md)** — everything needed
  to deploy this from scratch
- [Design specification](docs/2026-09-18-teamcity-build-notifier-design.md)
- [Implementation plan](docs/2026-09-18-teamcity-build-notifier.md)
- [Payload contract fixture](docs/teamcity-payload.sample.json)

## License

Internal use only.
