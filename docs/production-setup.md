# Production Setup Guide

Everything needed to take this repository and run it in production, assuming no
prior knowledge of the project. Follow the parts in order.

- [0. What you are building](#0-what-you-are-building)
- [1. Prerequisites](#1-prerequisites)
- [2. Generate the two secrets](#2-generate-the-two-secrets)
- [3. Deploy the API to IIS](#3-deploy-the-api-to-iis)
- [4. Configure TeamCity](#4-configure-teamcity)
- [5. Build the extension](#5-build-the-extension)
- [6. Install and configure the extension](#6-install-and-configure-the-extension)
- [7. End-to-end verification](#7-end-to-end-verification)
- [8. Rotating secrets](#8-rotating-secrets)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Configuration reference](#10-configuration-reference)

---

## 0. What you are building

```text
TeamCity build agent          Notifier API (IIS)              Chrome / Edge extension
─────────────────────         ──────────────────              ───────────────────────
PowerShell step at the        POST /webhooks/teamcity         SignalR WebSocket to
end of a build   ──────────►  validates + de-duplicates  ───► /hubs/builds
                              keeps 200 events in RAM         desktop toast + popup
X-TeamCity-Secret header      (60 min TTL, no database)       Authorization: Bearer
```

Two secrets, never the same value. The API stores only their SHA-256 hashes and
never a raw value — a leaked config file hands an attacker nothing usable.

| Secret | Raw value held by | API stores |
| --- | --- | --- |
| Webhook secret | TeamCity build agent | `Notifier:WebhookSecretSha256` |
| Team access token | Every extension user | `Notifier:TeamTokenSha256` |

Keeping them separate matters: a leaked team token lets someone *read*
notifications, never *forge* build events.

---

## 1. Prerequisites

**On the server hosting the API:**

| Requirement | Note |
| --- | --- |
| Windows Server + IIS | |
| .NET 8 ASP.NET Core **Hosting Bundle** | not just the runtime — installs the IIS module |
| IIS WebSocket Protocol feature | `Install-WindowsFeature -Name Web-WebSockets`. Without it SignalR falls back to long-polling or fails. |
| Trusted TLS certificate | self-signed will not do — every team machine must trust it |

The log file path is **configuration, not code** — set via the `Serilog` section
in `appsettings.json` ([§10](#logging)). `appsettings.Production.example.json`
defaults to `D:\AppData\BuildStatusNotification\Logs`; if your server has no
`D:`, edit that one path before deploying, no code change needed.

**On the machine you build from:** .NET 8 SDK, Node.js 18+, PowerShell 5.1+.

**Decide before you start** — these two values must be byte-identical in
scheme/host/port everywhere they're used, or webhooks get rejected
(see [§9](#9-troubleshooting)):

| Thing | Example |
| --- | --- |
| API public URL | `https://buildnotify.example` |
| TeamCity base URL | `https://teamcity.example` |

---

## 2. Generate the two secrets

```powershell
.\scripts\Generate-Secrets.ps1
```

Prints a **raw** value and a **SHA-256 hash** for each secret. Each raw value is
32 bytes from a CSPRNG — that's why plain SHA-256 with no salt is fine, there's
no low-entropy password to brute-force. This is the only time the raw values
are ever shown; the server cannot recover them later.

| Value | Goes to |
| --- | --- |
| Webhook secret — raw | TeamCity agent env var `NOTIFIER_SECRET` ([§4](#4-configure-teamcity)) |
| Webhook secret — hash | API config `Notifier__WebhookSecretSha256` ([§3](#3-deploy-the-api-to-iis)) |
| Team token — raw | Each user's extension Options page ([§6](#6-install-and-configure-the-extension)) |
| Team token — hash | API config `Notifier__TeamTokenSha256` ([§3](#3-deploy-the-api-to-iis)) |

Put the raw values in the team password manager immediately. Never commit them,
never paste them into a build log or group chat.

---

## 3. Deploy the API to IIS

```powershell
dotnet publish BuildStatusNotification -c Release -o C:\Deploy\BuildStatusNotification
```

**Application pool** (IIS Manager → Application Pools → Add):

| Setting | Value | Why |
| --- | --- | --- |
| .NET CLR version | *No Managed Code* | |
| Start Mode | `AlwaysRunning` | hub must be up before the first build finishes |
| Idle Time-out | `0` | an idle shutdown drops every WebSocket |
| Max Worker Processes | `1` | **critical** — the replay buffer is in-process; two workers = two buffers, clients get whichever one they land on |

**Site** (Sites → Add Website): name `BuildStatusNotification`, physical path
`C:\Deploy\BuildStatusNotification`, binding `https:443` on your hostname with
the trusted certificate.

**Configuration** — env var names use `__` for nesting
(`Notifier__TeamTokenSha256` → `Notifier:TeamTokenSha256`):

```powershell
$appPool = "BuildStatusNotification"
$vars = @{
    "ASPNETCORE_ENVIRONMENT"        = "Production"
    "Notifier__TeamTokenSha256"     = "PASTE_TEAM_TOKEN_HASH"
    "Notifier__WebhookSecretSha256" = "PASTE_WEBHOOK_SECRET_HASH"
    "Notifier__TeamCityBaseUrl"     = "https://teamcity.example"
}
foreach ($name in $vars.Keys) {
    Set-WebConfigurationProperty -PSPath "IIS:\AppPools\$appPool" `
        -Name environmentVariables -Value @{ name = $name; value = $vars[$name] }
}
```

Alternative: copy `appsettings.Production.example.json` to
`appsettings.Production.json` in the deployment folder and fill it in, then
protect it with NTFS ACLs. Either way `ASPNETCORE_ENVIRONMENT=Production` must
be set — it's what selects that file and turns on HTTPS enforcement
([§10](#environment-selection)).

**Do this step regardless of which option you picked above.** The log file
path lives in the `Serilog:WriteTo` array in JSON, not in an env var — an
array element has no clean `Notifier__`-style env var name, so copy
`appsettings.Production.example.json` to `appsettings.Production.json` and
edit its `Serilog:WriteTo` → `File` → `Args:path` even if you're using
Option A for the secrets. It defaults to
`D:\AppData\BuildStatusNotification\Logs\notifier-.log` — change the drive
letter or path there if `D:` doesn't exist on your server.

**Log directory:** the `File` sink creates the directory itself if missing, but
the app pool identity still needs write access to it. It's kept outside the
deployment folder on purpose — a future `dotnet publish` into that folder
should never risk touching the logs — so it isn't covered by whatever
permissions the deployment folder already has:

```powershell
$logDir = "D:\AppData\BuildStatusNotification\Logs"
New-Item -ItemType Directory -Force -Path $logDir
$acl = Get-Acl $logDir
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    "IIS AppPool\BuildStatusNotification", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")))
Set-Acl $logDir $acl
```

Logs roll daily as `notifier-YYYYMMDD.log`, plain text, 14 retained — open
directly in Notepad or any editor.

**Start and confirm:**

```powershell
Start-WebAppPool -Name "BuildStatusNotification"
Start-Website   -Name "BuildStatusNotification"
Invoke-RestMethod https://buildnotify.example/health   # → status : Healthy
```

Options are validated **at startup** — a bad value stops the app immediately
with an explicit message in Event Viewer. See [§9](#9-troubleshooting).

---

## 4. Configure TeamCity

One POST per build event:

```text
POST https://buildnotify.example/webhooks/teamcity
Content-Type: application/json
X-TeamCity-Secret: <raw webhook secret>
```

The contract is `docs/teamcity-payload.sample.json` — a real `started` and
`finished` example. **That file is the source of truth**; change it first if
the contract ever changes.

| Field | TeamCity parameter | Notes |
| --- | --- | --- |
| `event` | — | `"started"` / `"finished"` |
| `buildId` | `%teamcity.build.id%` | internal ID, **not** the build number |
| `buildTypeId` | `%system.teamcity.buildType.id%` | identifies the pipeline |
| `projectId` | `%system.teamcity.projectId%` | stable ID, never the display name |
| `projectName` | `%system.teamcity.projectName%` | display only |
| `buildName` | `%system.teamcity.buildConfName%` | |
| `buildTitle` | your existing display title | used as the notification heading |
| `buildNumber` | `%build.number%` | |
| `branch` | `%teamcity.build.branch%` | |
| `status` | mapped, see below | never forward TeamCity's raw string |
| `triggeredBy` | `%teamcity.build.triggeredBy%` | |
| `startedAt` / `finishedAt` | — | ISO 8601 UTC, e.g. `2026-05-21T06:27:42Z`; `finishedAt` null on `started` |
| `durationSeconds` | — | `[int]($finishedAt - $startedAt).TotalSeconds`, not parsed from a display string |
| `buildUrl` | `%teamcity.serverUrl%/viewLog.html?buildId=%teamcity.build.id%` | must match `TeamCityBaseUrl`'s origin |
| `logUrl` | same + `&tab=buildLog` | null on `started`, required on `finished` |
| `projects` | — | `@($projects)` — without `@()` a single project serializes as a bare string and fails validation |

| Event | Allowed `status` |
| --- | --- |
| `started` | `RUNNING` |
| `finished` | `SUCCESS`, `FAILURE`, `CANCELLED` |

**Three things that silently corrupt data if skipped:**

| Trap | Fix |
| --- | --- |
| Reusing pre-escaped `$e*` variables (e.g. from an existing Teams card script) — `ConvertTo-Json` escapes again, double-escaping a `"` or `\` | Feed it the **raw** source variables, not the `$e*` ones |
| Display timestamps carry no timezone | Convert explicitly: `$startedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")`. Guessing wrong shifts every timestamp by the offset (7h for ICT) |
| Parsing `00:22:29` back into seconds | Compute from the raw `DateTime`s instead |

**The POST**, appended to the finished script:

```powershell
$buildUrl = "$($serverUrl.TrimEnd('/'))/viewLog.html?buildId=$buildId"
$notify = @{
  event = "finished"; buildId = $buildId; buildTypeId = $buildTypeId
  projectId = $projectId; projectName = $projectName; buildName = $buildName
  buildTitle = $buildTitle; buildNumber = $buildNumber; branch = $branch
  status = $status; statusText = $statusText; triggeredBy = $triggeredBy
  startedAt = $startedUtc; finishedAt = $finishedUtc; durationSeconds = $durationSec
  buildUrl = $buildUrl; logUrl = "$buildUrl&tab=buildLog"; projects = @($projects)
} | ConvertTo-Json -Compress

try {
  Invoke-RestMethod -Uri "$env:NOTIFIER_URL/webhooks/teamcity" -Method Post `
    -ContentType "application/json" -Headers @{ "X-TeamCity-Secret" = $env:NOTIFIER_SECRET } `
    -Body $notify -TimeoutSec 10 | Out-Null
} catch {
  Write-Warning "Build notifier unreachable: $($_.Exception.Message)"   # never fail the build
}
```

The **started** script is identical with `event = "started"`,
`status = "RUNNING"`, `finishedAt`/`durationSeconds`/`logUrl` = `$null`.
`try/catch` (a notifier outage must never redden a build), `-TimeoutSec 10`
(a hung API must not stall the agent) and `| Out-Null` (keep the response out
of the build log) are all load-bearing, not decoration.

**Agent config** — env vars or TeamCity `password`-type parameters, never a
plain parameter or hard-coded in the script:

| Variable | Value |
| --- | --- |
| `NOTIFIER_URL` | `https://buildnotify.example` |
| `NOTIFIER_SECRET` | raw webhook secret from [§2](#2-generate-the-two-secrets) |

**API responses:**

| Code | Meaning |
| --- | --- |
| `202` | accepted, `{"status":"accepted","notificationId":"<hex>"}` |
| `200` | duplicate (same `SHA256(projectId\|buildId\|event)` seen before), not re-broadcast |
| `400` | malformed / failed validation — message says which field |
| `401` | secret missing or wrong |
| `413` | body over 65536 bytes |
| `429` | over 60 req/min |

**Test without a real build:**

```powershell
.\scripts\Test-TeamCityWebhook.ps1 both -BaseUrl "https://buildnotify.example" `
    -WebhookSecret "<raw webhook secret>" -TeamCityBaseUrl "https://teamcity.example"
```

Modes: `start`, `finish`, `both`, `duplicate`, `failure`, `cancelled`, `health`.

---

## 5. Build the extension

```powershell
cd extension
npm install
npm test
```

**Point the manifest at production first.** `manifest.json` ships with
localhost hosts for dev; `manifest.production.json` is the template — edit its
`host_permissions` to your API host only (the extension never fetches TeamCity
directly, so it needs no TeamCity host permission):

```json
"host_permissions": ["https://buildnotify.example/*"]
```

`build.mjs` always copies `manifest.json`, so swap it in before building:

```powershell
Copy-Item manifest.json manifest.dev.json -Force
Copy-Item manifest.production.json manifest.json -Force
npm run build
Copy-Item manifest.dev.json manifest.json -Force   # restore for local work
Select-String -Path dist\manifest.json -Pattern "host_permissions" -Context 0,3   # verify
```

`extension/dist/` is the entire deliverable (manifest, `background.js`,
`popup.*`, `options.*`, `icons/`). Zip it, put it on a share.

---

## 6. Install and configure the extension

Not on the Chrome Web Store, and Chrome/Edge refuse a dragged-in `.crx` — so
this is "load unpacked", which needs no infrastructure.

1. Unzip somewhere **permanent** (not Downloads) — Chrome references the
   folder path, doesn't copy it; move/delete it and the extension breaks.
2. `chrome://extensions` (or `edge://extensions`) → **Developer mode** on →
   **Load unpacked** → select `dist`.

Each machine gets a different extension ID (derived from the folder path) —
nothing here depends on it.

**Configure**, in the extension's Options page:

| Field | Value | If wrong |
| --- | --- | --- |
| Server URL | `https://buildnotify.example` | no connection |
| Access Token | raw team token from [§2](#2-generate-the-two-secrets) | popup shows *Unauthorized* |
| TeamCity Base URL | `https://teamcity.example` | Open build / Build log do nothing, silently |
| Notify on build started | off by default | no toast for `started` events |

Distribute the token over a channel that isn't this page (password manager,
1:1). Save — status line should read **Connected**. The token sits in
`chrome.storage.local` in plain text, readable by anyone with the browser
profile; that's accepted since it's read-only access. Rotate it when someone
leaves ([§8](#8-rotating-secrets)).

**What the user gets:** a desktop toast per build (colour/icon by result,
click opens the build); a popup **Recent notifications** list (last 20,
colour-coded, click to expand detail + Open build/Build log, `×` to dismiss,
Clear all); and a collapsed **Current status** panel — press Show to pull the
server's buffer once and see the latest state per build config. It never
polls; only the Show/refresh button, or a new event while it's open, triggers
a pull.

**Updating:** rebuild, replace `dist/`, press Reload on the extension card.
No auto-update for unpacked extensions.

---

## 7. End-to-end verification

Run in order — each isolates one link in the chain.

| # | Check | Command | Expect |
| --- | --- | --- | --- |
| 1 | API up | `Invoke-RestMethod https://buildnotify.example/health` | `status : Healthy` |
| 2 | Webhook accepts valid auth | `.\scripts\Test-TeamCityWebhook.ps1 finish` with real `-WebhookSecret` | `202`, then `200` on repeat |
| 3 | Webhook rejects bad auth | same with a wrong secret | `401` — if `202`, stop and fix config |
| 4 | Extension connects | open popup | status line **Connected** |
| 5 | Notification arrives | re-run #2 | toast + new row in Recent notifications |
| 6 | Links work | expand row → Open build | TeamCity tab opens (else: TeamCity Base URL mismatch) |
| 7 | Real build | trigger one in TeamCity | arrives end to end |
| 8 | No secret leakage | `Select-String -Path "D:\AppData\BuildStatusNotification\Logs\*.log" -Pattern "Bearer\|access_token\|X-TeamCity-Secret"` | no matches |

**Security checklist:** TLS trusted on every machine · only hashes in config,
raw values only in the password manager · webhook secret ≠ team token · log
and deployment folders have restricted ACLs · `NOTIFIER_SECRET` is a
password-type parameter · step 3 above returned `401` · step 8 returned
nothing.

---

## 8. Rotating secrets

Rotate the team token when someone leaves; the webhook secret if it may have
leaked.

1. `.\scripts\Generate-Secrets.ps1` again.
2. Update the hash in API config, **restart the site** — `IOptions<NotifierOptions>`
   is a singleton captured at startup, so editing config live changes nothing.
3. Team token: send the new raw value to everyone (their popup shows
   *Unauthorized* until they re-enter it). Webhook secret: update
   `NOTIFIER_SECRET` on the agent (every webhook gets `401` until you do).

No overlap window — the API holds exactly one hash per secret, so this is a
hard cutover. Do it outside a busy build period.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **9.1** Site won't start | Options validated at startup — check Event Viewer → Application for the exact message | `TeamTokenSha256 is required` → config not reaching the app, check `ASPNETCORE_ENVIRONMENT` and `Notifier__` var names. `... 64 characters` → a raw value pasted where a hash belongs. `...must use HTTPS` → http URL in prod config. Serilog/directory errors → log dir missing or unwritable. `500.30` blank → Hosting Bundle not installed |
| **9.2** Webhook `400 BuildUrl must start with ...` | `buildUrl`'s origin (scheme+host+port) ≠ `Notifier:TeamCityBaseUrl` | Usually TeamCity's Global Settings → Server URL is an internal address (`http://tc-srv:8111`) while the API has the external one. Make them agree |
| **9.3** Webhook `401` | secret mismatch | Hash the raw value yourself and diff against config: `[BitConverter]::ToString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($raw))).Replace("-","")`. Watch for a trailing newline/space |
| **9.4** Extension shows Unauthorized | same, against `TeamTokenSha256` | same check; remember the API needs a restart after config changes |
| **9.5** Extension stuck "Connecting" | WebSocket not reaching the hub | WebSocket Protocol not enabled in IIS · proxy not forwarding upgrades · app pool idle time-out not `0` · firewall blocking WSS |
| **9.6** Open build / Build log do nothing | `isAllowedBuildUrl` rejected the URL, silently | In the popup's devtools console: `chrome.storage.local.get(['settings','recentEvents'], r => console.log(r.settings.teamCityBaseUrl, r.recentEvents.at(-1)?.buildUrl))` — origins must match |
| **9.7** Toast goes straight to Action Center | usually Windows, not the extension | Check Focus Assist (`Win+N`) · Settings → Notifications → Chrome → *Show notification banners* · full-screen mode. Isolate with a manual probe in the service worker console: `chrome.notifications.create('probe', {type:'basic', iconUrl:'icons/icon-128.png', title:'Probe', message:'test'})` |
| **9.8** Current status panel looks frozen | it shows one row per build **configuration** (newest run only), bounded by the 60-minute buffer TTL | Repeated runs of the same pipeline correctly update one row — check the `Checked HH:MM:SS` stamp. Builds longer than the TTL lose their `started` event; raise `Notifier:BufferTtlMinutes` if needed |

### 9.9 Reading the logs

Plain text, one line per event — open `notifier-YYYYMMDD.log` directly in
Notepad, VS Code, or `Get-Content -Tail 50`:

```text
2026-09-21 10:42:37.123 [INF] Accepted notification: 3E776B38... - finished - SUCCESS - Local - TeamCity Webhook Test - develop
2026-09-21 10:42:37.140 [INF] Broadcasted notification: 3E776B38...
```

Grep for: `Accepted notification`, `Duplicate notification`,
`Rejected webhook`, `Client connected`. `[ERR]` / `[WRN]` mark problems.

---

## 10. Configuration reference

**API — `Notifier` section** (via `appsettings.{Environment}.json` or env vars
with `__` for nesting):

| Key | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `TeamTokenSha256` | `Notifier__TeamTokenSha256` | — | SHA-256 hex of team token, 64 chars, required |
| `WebhookSecretSha256` | `Notifier__WebhookSecretSha256` | — | SHA-256 hex of webhook secret, 64 chars, required |
| `TeamCityBaseUrl` | `Notifier__TeamCityBaseUrl` | — | origin every `buildUrl`/`logUrl` must belong to; HTTPS required outside Development |
| `BufferCapacity` | `Notifier__BufferCapacity` | `200` | max events held in RAM |
| `BufferTtlMinutes` | `Notifier__BufferTtlMinutes` | `60` | how long an event stays replayable |
| `ReplayLimit` | `Notifier__ReplayLimit` | `50` | upper bound on one `GetRecent` call |

### Logging

Serilog reads the **`Serilog`** section, not `Logging` — `UseSerilog()`
replaces `ILoggerFactory` entirely, so a `Logging:LogLevel` section is dead
config. `Program.cs` has no sink or path logic of its own; everything below
lives in `appsettings.json` and is what you edit to change it:

| Key | Meaning |
| --- | --- |
| `Serilog:MinimumLevel:Default` | overall log level |
| `Serilog:MinimumLevel:Override:*` | per-namespace overrides (e.g. quiet down `Microsoft`) |
| `Serilog:WriteTo[0]` (Console) | stdout, same template as the file |
| `Serilog:WriteTo[1]` (File) `Args:path` | **the log file location** — relative (dev default: `Logs/notifier-.log`) or absolute (prod default: `D:\AppData\BuildStatusNotification\Logs\notifier-.log`) |
| `Serilog:WriteTo[1]` `Args:retainedFileCountLimit` | how many daily files to keep (default `14`) |

Both sinks use the same plain-text `outputTemplate`, so `{Placeholder}` values
are always rendered into the line, never left as raw braces.

```json
"Serilog": {
  "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.File" ],
  "MinimumLevel": { "Default": "Information",
    "Override": { "Microsoft": "Warning", "System": "Warning" } },
  "WriteTo": [
    { "Name": "Console", "Args": { "outputTemplate": "..." } },
    { "Name": "File", "Args": { "path": "Logs/notifier-.log", "outputTemplate": "...",
        "rollingInterval": "Day", "retainedFileCountLimit": 14 } }
  ]
}
```

There's no `Notifier__`-style env var for the file path (it's inside an array,
which env vars address only by a fragile numeric index) — change it by editing
`appsettings.Production.json` directly, as in [§3](#3-deploy-the-api-to-iis).

### Environment selection

`ASPNETCORE_ENVIRONMENT` picks which `appsettings.{Environment}.json` layers on
top of `appsettings.json`, and drives:

| Environment | HTTPS redirect | `TeamCityBaseUrl` must be HTTPS |
| --- | --- | --- |
| `Development` | off (would drop `Authorization` during SignalR negotiation on localhost) | no |
| anything else | on | yes |

`Properties/launchSettings.json` sets `Development` locally; it is not
published, so set the variable yourself on the server.

### Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | liveness |
| `POST` | `/webhooks/teamcity` | `X-TeamCity-Secret` header | ingest a build event, 60 req/min |
| WS | `/hubs/builds` | `Authorization: Bearer` or `?access_token=` | SignalR hub; server sends `BuildEvent`, client may call `GetRecent(limit)` |

### Extension settings

Stored in `chrome.storage.local.settings`:

| Key | Meaning |
| --- | --- |
| `serverUrl` | API base URL, no trailing slash |
| `accessToken` | raw team token |
| `teamCityBaseUrl` | origin used to validate build links before opening them |
| `notifyOnStarted` | whether `started` events raise a toast (default off) |
| `enabled` | master switch |
