# TeamCity Build Notifier Implementation Plan

**Goal:** A .NET 8 Minimal API on IIS plus a Chrome/Edge Manifest V3 extension. TeamCity posts build started/finished events to a secured webhook; the API broadcasts them over SignalR to every extension holding the shared team token.

**Spec:** 2026-09-18-teamcity-build-notifier-design.md

**Tech stack:** .NET 8, ASP.NET Core Minimal API, SignalR, Serilog, xUnit, @microsoft/signalr, esbuild, Manifest V3, IIS.

**Repo layout:** flat, as it already exists.

~~~text
D:\BuildStatusNotification\
  BuildStatusNotification.slnx
  BuildStatusNotification\          API
  BuildStatusNotification.Tests\    xUnit
  extension\                        MV3 extension
  docs\
~~~

## Constraints

- .NET 8 target; SDK 10.0.301 is installed and is what handles `.slnx` from the CLI.
- One IIS worker process. Replay state is in process memory.
- No database, Redis or queue.
- Buffer: 200 items, 60-minute TTL.
- Body limit 64 KB; webhook rate limit 60/min per IP.
- Store SHA-256 hashes of both secrets, never raw values.
- Never log secrets, Authorization headers or access_token values.
- Broadcast to all clients. No groups, no project catalog, no per-project routing.

## Testing

Two test files, covering the only logic that can silently be wrong:

- `NotificationBufferTests` — dedupe, FIFO eviction, TTL expiry.
- `BuildEventValidatorTests` — stable/distinct NotificationId, required fields, URL allowlist.

Everything else is verified by running it. No integration test host, no per-step red-green cycle.

---

## Task 1: Setup

- [ ] `git init` and add a `.gitignore` covering `bin/`, `obj/`, `.vs/`, `*.user`, `node_modules/`, `extension/dist/`.
- [ ] Add the test project:

~~~powershell
dotnet new xunit -n BuildStatusNotification.Tests -o BuildStatusNotification.Tests --framework net8.0
dotnet add BuildStatusNotification.Tests reference BuildStatusNotification
dotnet sln BuildStatusNotification.slnx add BuildStatusNotification.Tests
~~~

- [ ] In `Program.cs`, delete the weatherforecast endpoint and the `WeatherForecast` record. Map `GET /health` returning `{ "status": "Healthy" }`.
- [ ] Drop the `Swashbuckle.AspNetCore` package reference. Nothing here needs Swagger.
- [ ] Write `docs/teamcity-payload.sample.json` with one `started` and one `finished` sample matching the spec contract. These are the test fixtures.
- [ ] `dotnet build` and commit.

## Task 2: Configuration and secret verification

**Files:** `Options/NotifierOptions.cs`, `Security/SecretVerifier.cs`, `appsettings.json`, `appsettings.Development.json`

- [ ] `NotifierOptions`: `TeamTokenSha256`, `WebhookSecretSha256`, `TeamCityBaseUrl`, `BufferCapacity` (200), `BufferTtlMinutes` (60), `ReplayLimit` (50).
- [ ] `SecretVerifier.MatchesSha256(string raw, string expectedHex)`: SHA-256 the UTF-8 bytes, `Convert.FromHexString` the expected value, compare with `CryptographicOperations.FixedTimeEquals`. Return false on a malformed hash rather than throwing.
- [ ] Bind the `Notifier` section with `ValidateOnStart`. Reject empty or non-64-character hashes and a non-HTTPS `TeamCityBaseUrl` outside Development — a bad secret hash must fail at boot, not on the first webhook.
- [ ] Environment variable names stay ASP.NET-standard: `Notifier__TeamTokenSha256`, `Notifier__WebhookSecretSha256`.
- [ ] Generate the two secrets now and record where each one goes. They are different values with different audiences: the webhook secret is known only to TeamCity, the team token only to extension users. Reusing one value for both means a leaked extension token also lets anyone forge build events.

~~~powershell
function New-Secret {
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $raw  = [Convert]::ToBase64String($bytes)
  $hash = [BitConverter]::ToString(
            [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($raw))
          ).Replace("-", "")
  [pscustomobject]@{ Raw = $raw; Sha256 = $hash }
}
$webhook = New-Secret   # Raw -> TeamCity;  Sha256 -> Notifier__WebhookSecretSha256
$team    = New-Secret   # Raw -> extension users;  Sha256 -> Notifier__TeamTokenSha256
~~~

  `RandomNumberGenerator.Fill` matters — `Get-Random` is not a cryptographic source and must not generate either value.

- [ ] Put only the hashes in configuration. The raw values go to TeamCity and to the team through a password manager, never into the repo or `appsettings.json`.
- [ ] Commit.

## Task 3: Notification model and validator

**Files:** `Models/BuildEventPayload.cs`, `Models/BuildNotification.cs`, `Services/BuildEventValidator.cs`, `BuildStatusNotification.Tests/BuildEventValidatorTests.cs`

- [ ] `BuildEventPayload` mirrors the incoming JSON. `BuildNotification` is the record in the spec. Both samples in `docs/teamcity-payload.sample.json` are the fixtures — load that file in the tests rather than hand-building objects, so a contract change breaks the tests instead of drifting silently.
- [ ] `BuildEventValidator.TryCreate(payload)` returns success/error/value and must:
  - require every field the spec marks required for that event type;
  - accept only `started`/`finished` and the four status values;
  - reject `buildUrl` and `logUrl` that do not start with `TeamCityBaseUrl`;
  - derive `NotificationId` = SHA-256 over `projectId | buildId | event`;
  - set `ReceivedAt` from the server clock, never from the payload.
- [ ] Tests: started and finished from the same build get different IDs; the same payload twice gets the same ID; missing `buildId` fails; a `buildUrl` on another host fails.
- [ ] `dotnet test` and commit.

## Task 4: Buffer and audit logging

**Files:** `Services/NotificationBuffer.cs`, `BuildStatusNotification.Tests/NotificationBufferTests.cs`, `Program.cs`, csproj

- [ ] `NotificationBuffer` singleton: `TryAdd(notification) : bool`, `GetRecent(int limit)`, `Count`. Lock-protected `LinkedList` plus a `HashSet` of IDs. Purge expired entries before add and read, evict oldest past capacity, return chronological order.
- [ ] Tests: duplicate ID returns false and does not grow Count; the oldest entry is evicted at capacity; an entry past TTL disappears.
- [ ] Add `Serilog.AspNetCore` and `Serilog.Sinks.File`. Daily rolling JSONL sink at `D:\AppData\BuildStatusNotification\Logs\notifier-.jsonl`, `retainedFileCountLimit: 14`.
- [ ] Log accepted / duplicate / rejected / broadcast outcomes with normalized fields only. A sink failure must not block the notification — wrap the write, do not let it throw into the request path.
- [ ] `dotnet test` and commit.

## Task 5: Auth, hub and webhook endpoint

**Files:** `Auth/TeamTokenAuthenticationHandler.cs`, `Hubs/BuildHub.cs`, `Endpoints/TeamCityWebhookEndpoint.cs`, `Program.cs`

- [ ] `TeamTokenAuthenticationHandler`: read `Authorization: Bearer` first; read `access_token` from the query **only** when `Request.Path.StartsWithSegments("/hubs/builds")`. Verify with `SecretVerifier`, build a `ClaimsPrincipal` with NameIdentifier `team`. Never log the supplied value.
- [ ] `BuildHub` at `/hubs/builds`, `[Authorize]` with the TeamToken scheme. One method: `GetRecent(int limit)` returning `buffer.GetRecent(Math.Clamp(limit, 1, options.ReplayLimit))`.
- [ ] `POST /webhooks/teamcity`, anonymous at the auth layer, in this order:
  1. require `application/json`; reject `Content-Length` > 65536 with 413;
  2. verify `X-TeamCity-Secret` against the configured hash — **before** deserializing;
  3. deserialize and validate, 400 on failure;
  4. `buffer.TryAdd` — 200 if false (duplicate), no broadcast;
  5. write the audit event;
  6. `hub.Clients.All.SendAsync("BuildEvent", notification, ct)`;
  7. 202.
- [ ] SignalR: 15s keepalive, 45s client timeout, 32 KB max message. No CORS configuration — the extension is authorized by its host permissions and the shared token.
- [ ] Fixed-window rate limiter keyed by source IP, 60/min, no queue, applied only to the webhook route. Note what this does and does not buy: every legitimate call comes from the TeamCity server, so it is effectively one global limit, not per-caller fairness. It caps the damage from a leaked webhook secret and nothing else. At two events per build it allows 30 builds a minute — check that against the real build farm before shipping.
- [ ] If anything sits in front of IIS — a reverse proxy, a load balancer — add `ForwardedHeaders` middleware, or every request appears to come from the proxy and the limiter becomes a single shared bucket.
- [ ] Run the API, POST both sample payloads with curl, confirm 202 then 200 on a repeat. Commit.

---

## How the extension stays alive

Worth understanding before Tasks 6 to 8, because it drives most of their design.

An MV3 service worker is not a background page. Chrome kills it after roughly 30 seconds idle, and a killed worker takes the SignalR connection with it. Three things keep this working:

1. **WebSocket traffic resets the idle timer** (Chrome 116+). The backend's SignalR `KeepAliveInterval` is 15 seconds, comfortably under 30, so an established connection keeps the worker alive on its own. That 15s in Task 5 is not an arbitrary number — it is what makes the extension viable.
2. **A 1-minute alarm is the backstop.** When the worker did die — laptop slept, network dropped, Chrome reclaimed memory — the alarm revives it and it reconnects.
3. **Replay covers the gap.** Every connect and reconnect calls `GetRecent`. Anything that happened while the worker was dead is still in the server's 60-minute buffer, and the seen-ID set stops it being shown twice.

A build event that lands while the worker is down is therefore delayed, not lost — as long as reconnect happens inside 60 minutes. Past that, the buffer has dropped it and it is gone by design.

## Task 6: Extension scaffold, settings and pure helpers

**Files:** `extension/package.json`, `build.mjs`, `manifest.json`, `icons/`, `src/settings.js`, `src/notification-store.js`, `src/url-validation.js`, `src/options.html`, `src/options.js`, `src/popup.html`, `src/popup.js`, `test/store.test.js`

- [ ] `npm init -y`, `npm i @microsoft/signalr`, `npm i -D esbuild`.
- [ ] `build.mjs` produces a **self-contained `dist/`** — that folder is the whole deliverable, since installation is load-unpacked (see `docs/extension-install.md`):
  - bundle `src/background.js`, `src/options.js` and `src/popup.js` into `dist/`, `format: "esm"`, `target: "chrome116"`;
  - copy `manifest.json`, `src/options.html`, `src/popup.html` and `icons/` into `dist/`.
- [ ] `manifest.json` v3: permissions `notifications`, `storage`, `alarms`; `host_permissions` for the API host and the TeamCity host; `background.service_worker` = `background.js` with `"type": "module"`; `options_page` = `options.html`; `action.default_popup` = `popup.html`. Paths are relative to `dist/`, not to the repo root.
- [ ] Icons at 16/48/128. Keep them plain — status is conveyed by the notification title, not by swapping icon files.
- [ ] `settings.js`: `loadSettings()` / `saveSettings()` over `chrome.storage.local`, with defaults — `serverUrl: ""`, `accessToken: ""`, `teamCityBaseUrl: ""`, `notifyOnStarted: false`, `enabled: true`.
- [ ] `url-validation.js`: `isAllowedBuildUrl(url, baseUrl)`. Parse both with `new URL()` and compare **origin**, not a string prefix — a `startsWith` check passes `https://teamcity.example.evil.com`. Return false on a parse failure.

### notification-store.js — the seen-ID set must survive the worker

This is the one place where getting it wrong is silent and constant. The service worker dies routinely; if the seen set lives only in memory, every revival reconnects, calls `GetRecent`, gets the whole 60-minute buffer back and re-notifies all of it. The deduplication would fail exactly when it is needed.

- [ ] Pure helpers, no `chrome` reference, so they run under `node --test`: `hasSeen(ids, id)`, `markSeen(ids, id)`, `trimSeenIds(ids, max)`. Cap at 500.
- [ ] Persistence wrapper in the same file: `loadSeenIds()` and `saveSeenIds(ids)` over `chrome.storage.local`.
- [ ] `background.js` loads the set **before** its first `GetRecent` and saves after every change. Never hold it only in a module variable.

### popup.html — where `projects` lives

Desktop notifications cannot show ten project names, so without a popup that array is carried across the whole system and displayed nowhere.

- [ ] Popup shows: connection status, the last ~20 notifications from a `recentEvents` list the worker keeps in `chrome.storage.local`, and each entry's project list.
- [ ] Connection status is **not** an options-page concern. The worker writes `connectionStatus` (`connected` / `connecting` / `unauthorized` / `disabled`) to `chrome.storage.local`; the popup reads it and subscribes to `storage.onChanged`. An options page cannot see the worker's live state any other way.
- [ ] Options page holds settings only: `serverUrl`, `accessToken` (type `password`), `teamCityBaseUrl`, `notifyOnStarted`, `enabled`, Save.
- [ ] `node --test extension/test` covering `trimSeenIds`, `markSeen` and `isAllowedBuildUrl`, including the `evil.com` case. Commit.

## Task 7: Connection, replay and notifications

**Files:** `extension/src/background.js`

- [ ] On worker start, `await` both `loadSettings()` and `loadSeenIds()` before anything else. A `GetRecent` that races ahead of the seen set re-notifies the whole buffer.
- [ ] `ensureConnection()` — idempotent. Return early if a connection is already `Connected` or `Connecting`; return early if disabled or credentials are missing.
- [ ] `HubConnectionBuilder` on `${serverUrl}/hubs/builds`, `accessTokenFactory: () => settings.accessToken`, `withAutomaticReconnect([0, 2000, 10000, 30000, 60000])`, log level Warning.
- [ ] After `start()` and again in `onreconnected`, call `replay()`: `invoke("GetRecent", 50)`, then display only unseen events, oldest first.
- [ ] `BuildEvent` handler → `handleNotification(n)`:
  - skip if `n.event === "started"` and `notifyOnStarted` is false;
  - skip if `hasSeen(seenIds, n.notificationId)`;
  - mark seen and `await saveSeenIds(...)` **before** creating the notification, so a worker death mid-call cannot double-show it;
  - append to the `recentEvents` list the popup reads, trimmed to 20;
  - `chrome.notifications.create(n.notificationId, {...})` — passing our own ID means a repeat replaces rather than stacks.
- [ ] Notification content, modelled on the existing Teams cards:
  - title: `${icon} ${statusText}` — `🚀 Build Started`, `✅ Build Succeeded`, `❌ Build Failed`;
  - message line 1: `buildTitle` as sent, e.g. `Geronimo - XYZ - Build`;
  - message line 2: `#${buildNumber} · ${branch} · ${triggeredBy}`, plus formatted duration on `finished`;
  - priority 2 for `FAILURE`, 0 otherwise.
- [ ] Do **not** render the `projects` array into the notification body — real builds carry ten names and it will not fit. Show `📦 ${projects.length} projects`; the popup shows the names.
- [ ] Write `connectionStatus` to `chrome.storage.local` on every state change so the popup can read it.
- [ ] Store `notificationId → buildUrl` in `chrome.storage.local`. In `chrome.notifications.onClicked`, look it up, check `isAllowedBuildUrl` against `teamCityBaseUrl`, open the tab, then clear both the notification and the mapping.
- [ ] `chrome.alarms.create("ensure-connection", { periodInMinutes: 1 })`. Call `ensureConnection()` from the alarm, `onInstalled`, `onStartup` and `storage.onChanged`.
- [ ] On a 401 from the handshake: stop, set status `unauthorized`, and do **not** let automatic reconnect keep retrying. A bad token must not hammer the server once per minute forever. Clear the flag when settings change.
- [ ] Build, load unpacked, confirm a manually posted fixture appears as a desktop notification. Commit.

## Task 8: Distribute

**Files:** `docs/extension-install.md`

Load unpacked from the built `dist/` folder. Chrome and Edge on Windows reject a manually installed `.crx`, so that folder is the deliverable.

- [ ] Zip `dist/` and put it on the team share.
- [ ] Write `docs/extension-install.md`: the load-unpacked steps for both browsers, entering the token, and the two things that bite — the folder must stay where it was loaded from, and there is no auto-update.
- [ ] Verify a teammate can install it and connect. Commit.

Extension IDs differ per machine under load-unpacked, and nothing here depends on them: the hub is protected by the shared token, not by origin. If this later moves to enterprise policy install, pin the ID then with a `key` in the manifest.

## Task 9: Deploy and verify end to end

**Files:** `appsettings.Production.example.json`, `docs/iis-deployment.md`

`dotnet publish` generates `web.config` for IIS on its own. Only author one if something in it actually needs overriding.

**Operator inputs — settle these before starting, they are not derivable from the code:**

| Input | Needed for |
| --- | --- |
| Public test hostname | IIS binding, extension `serverUrl` |
| TLS certificate, trusted on every team machine | HTTPS binding |
| TeamCity base URL | `Notifier__TeamCityBaseUrl` and the extension's URL check |
| Build agent timezone | the timestamp conversion in `docs/teamcity-integration.md` |
| A writable log directory on the server | the Serilog sink — confirm the drive in the configured path exists |

- [ ] Install the .NET 8 ASP.NET Core Hosting Bundle and enable the IIS WebSocket Protocol.
- [ ] `dotnet publish BuildStatusNotification -c Release -o C:\Deploy\BuildStatusNotification`.
- [ ] App Pool: No Managed Code, Integrated, AlwaysRunning, idle timeout 0, **max worker processes 1**.
- [ ] Site: approved hostname, HTTPS/443 with the trusted certificate.
- [ ] Set `ASPNETCORE_ENVIRONMENT`, both hashes and `Notifier__TeamCityBaseUrl` through protected IIS/environment config. Grant the app identity write access to the log directory.
- [ ] Edit both TeamCity PowerShell scripts per `docs/teamcity-integration.md`. That document carries the full block, the field mapping and the two traps — pre-escaped `$e*` values, and the timestamps that arrive without a timezone.
- [ ] Confirm the agent clock question from that document is answered before the first real build, not after.
- [ ] Verify: wrong secret → 401; valid event → 202; same event again → 200 with no second notification; a real build shows a desktop notification in both Chrome and Edge; a `started` and its `finished` both appear rather than the second being swallowed as a duplicate; timestamps match wall-clock time; clicking opens the build; an off-host URL does not open; restart the App Pool and confirm the extension reconnects; grep the log files for the token and secret and find nothing.
- [ ] Verify the seen-ID set survives a worker restart: with events in the buffer, kill the service worker from `chrome://extensions`, let the alarm revive it, and confirm **nothing is re-notified**. This is the failure mode that looks fine in testing and floods everyone in production.
- [ ] Commit.
