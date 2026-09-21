# TeamCity Build Notifier Design Specification

**Date:** 2026-09-18
**Status:** Design approved for implementation planning
**Scope:** Internal test site on IIS, Chrome/Edge extension distributed from one internal package

## Goal

When a TeamCity build starts or finishes, an ASP.NET Core .NET 8 Minimal API receives a secured webhook and broadcasts a notification through SignalR to every connected Chrome/Edge extension holding the shared team token. The system keeps a bounded replay buffer in RAM and writes structured audit logs to disk, without using a database.

## Decisions

| Decision | Value |
| --- | --- |
| Backend | ASP.NET Core 8 Minimal API |
| Realtime transport | SignalR, WebSocket preferred with fallback transports |
| Hosting | IIS on Windows Server |
| Deployment stage | Public HTTPS test site |
| Browser clients | Chrome and Microsoft Edge, Manifest V3 |
| Extension distribution | One internally distributed package with stable extension ID |
| Extension authentication | One shared team access token |
| Webhook authentication | Separate X-TeamCity-Secret header |
| Persistent database | None |
| Replay | Bounded in-memory buffer, 200 items, 60-minute TTL |
| Audit log | Rolling JSON Lines files, 14-day retention |
| IIS process model | One application pool worker process |
| Notification events | Build started and build finished |
| Webhook payload | Flat JSON posted by a PowerShell step inside the TeamCity build |
| Delivery model | Broadcast to all authenticated clients; no per-project routing |

### Why there is no project subscription

An earlier draft routed notifications into SignalR groups keyed by project and exposed a project catalog endpoint. That was dropped. Every team member shares one token, so a project filter could never be an authorization boundary — it was routing dressed up as access control, and it cost a catalog endpoint, two hub methods, group-name canonicalization, a per-client preference and a project-filtered buffer read.

Everyone who installs the extension and enters the token receives every build event. Per-project filtering is a later feature, and when it arrives it belongs on the client, not as a security control.

## Scope

### In scope

- Receive POST /webhooks/teamcity.
- Validate JSON content type, body size and webhook secret.
- Validate the flat notification contract posted by the TeamCity build step.
- Accept both build-started and build-finished events.
- Deduplicate webhook retries by stable NotificationId.
- Store recent notifications in a thread-safe bounded RAM buffer.
- Broadcast new events to all authenticated SignalR clients.
- Authenticate extension connections with the shared team token.
- Provide GET /health, returning a static 200 — there is no database or downstream dependency whose health could differ from the process being up.
- Reconnect and replay recent events in the extension.
- Display OS notifications and open the validated TeamCity build URL.
- Write structured JSONL audit logs without logging secrets.
- Deploy the test site to IIS with HTTPS, WebSocket support and one worker process.

### Out of scope

- User accounts, OAuth, JWT, Entra ID or per-user tokens.
- Per-project subscription, routing or filtering.
- A project catalog endpoint.
- Database, Redis, message broker or durable notification history.
- Guaranteed delivery after IIS/server restart.
- Store publication workflow for Chrome Web Store or Edge Add-ons.
- Multi-instance or multi-worker SignalR scaling.
- Native desktop application.

## Architecture

~~~text
TeamCity build step (PowerShell)
  |- POST Adaptive Card -> Microsoft Teams (existing, unchanged)
  | HTTPS POST flat JSON + X-TeamCity-Secret
  v
IIS / ASP.NET Core Minimal API
  |- request validation
  |- payload validation
  |- dedupe
  |- bounded RAM buffer
  |- JSONL audit logger
  |- SignalR BuildHub -> Clients.All
       | HTTPS/WSS + shared team access token
       v
Chrome/Edge Manifest V3 extension
  |- service worker
  |- reconnect and replay
  |- OS notification
~~~

The API is public over HTTPS, but the webhook and SignalR paths have independent credentials.

There is no CORS allowlist. CORS defends against a browser attaching ambient credentials — cookies — to a cross-origin request made by a hostile page. This API has no cookies and no session: the token is presented explicitly on every call, and a page that does not hold it gains nothing from being allowed to ask. The token is the boundary; origin is not. The extension reaches the API through its manifest `host_permissions`, which is what Chrome actually checks for a service worker.

## Component boundaries

### Webhook endpoint

POST /webhooks/teamcity is anonymous at the ASP.NET authentication layer because it uses its own shared secret. It must:

1. Reject non-JSON requests.
2. Reject bodies larger than 64 KB.
3. Compare the SHA-256 hash of X-TeamCity-Secret with the configured hash using constant-time comparison.
4. Deserialize and validate the payload against the notification contract.
5. Build the BuildNotification and derive its NotificationId.
6. Dedupe before broadcast.
7. Add a new notification to the RAM buffer.
8. Write an audit event.
9. Broadcast BuildEvent to all connected clients.

Steps 1 through 3 run before deserialization so an unauthenticated caller never reaches the JSON parser.

### Authentication handler

TeamTokenAuthenticationHandler accepts:

- Authorization: Bearer token on normal HTTP requests.
- access_token=token only on /hubs/builds, because browser WebSocket/SSE APIs cannot set a custom authorization header during the transport handshake.

The raw token is never stored by the backend. The handler hashes the supplied token and compares it with the configured SHA-256 hash.

### SignalR hub

Hub path: /hubs/builds. Authorized with the TeamToken scheme.

Method:

~~~csharp
IReadOnlyList<BuildNotification> GetRecent(int limit)
~~~

Server event:

~~~text
BuildEvent(BuildNotification notification)
~~~

One server event carries both started and finished notifications; clients branch on the Event field. `limit` is clamped to 1 through NotifierOptions.ReplayLimit. There are no groups: broadcast targets Clients.All.

### RAM buffer

NotificationBuffer is a singleton process-local service with:

- Maximum capacity: 200 items.
- Expiration: 60 minutes after ReceivedAt.
- FIFO eviction when capacity is exceeded.
- Dedupe by NotificationId.
- Thread-safe add and read operations.

The buffer is intentionally not restored from audit logs after process restart.

### Audit logging

Serilog writes normalized JSON Lines to:

~~~text
D:\AppData\BuildStatusNotification\Logs\notifier-yyyyMMdd.jsonl
~~~

The sink rolls daily and retains 14 days. Logging is for inspection and audit only. A logging failure is recorded to console/Event Viewer and does not block an otherwise valid notification from reaching the RAM buffer and SignalR clients.

The logger may record NotificationId, event, project, build ID/number, branch, status, received time, duplicate status and broadcast result. It must not record raw secrets, bearer tokens, Authorization headers, access_token query values or unfiltered webhook payloads.

## Data contracts

### Incoming contract

TeamCity already runs a PowerShell step that posts a Microsoft Teams Adaptive Card on build start and build finish. That same step posts a second, flat JSON body to this API. The API never parses the Adaptive Card: the build step already holds every field value, so sending it directly is cheaper and more robust than reverse-engineering a presentation format whose text labels can change at any time.

Both samples are stored at docs/teamcity-payload.sample.json and serve as test fixtures. They are authored, not captured, because the build step owns the payload shape.

~~~json
{
  "event": "finished",
  "buildId": "12345",
  "buildTypeId": "BestOutings_Deploy",
  "projectId": "BestOutings",
  "projectName": "Best Outings",
  "buildName": "Deploy",
  "buildTitle": "Geronimo - Best Outings - Deploy",
  "buildNumber": "2026.09.18.4",
  "branch": "develop",
  "status": "SUCCESS",
  "statusText": "Build Succeeded",
  "triggeredBy": "Alex Dang",
  "startedAt": "2026-09-18T08:26:48Z",
  "finishedAt": "2026-09-18T08:30:00Z",
  "durationSeconds": 192,
  "buildUrl": "https://teamcity.example/viewLog.html?buildId=12345",
  "logUrl": "https://teamcity.example/viewLog.html?buildId=12345&tab=buildLog",
  "projects": ["Web", "Api", "Worker"]
}
~~~

For event `started`, `status` is `RUNNING` and `finishedAt`, `durationSeconds` and `logUrl` are null. Every other field is required for both events.

Accepted `event` values: `started`, `finished`. Accepted `status` values: `RUNNING`, `SUCCESS`, `FAILURE`, `CANCELLED`. Timestamps are ISO 8601 UTC.

`projectId` and `projectName` are carried for display only. Nothing routes on them.

Field sources in the build step:

| Field | TeamCity parameter |
| --- | --- |
| buildId | %teamcity.build.id% |
| buildTypeId | %system.teamcity.buildType.id% |
| projectId | %system.teamcity.projectId% |
| projectName | %system.teamcity.projectName% |
| buildName | %system.teamcity.buildConfName% |
| buildTitle | the composed title the Teams card already shows, e.g. `Geronimo - XYZ - Build` |
| buildNumber | %build.number% |
| branch | %teamcity.build.branch% |
| triggeredBy | %teamcity.build.triggeredBy% |

`buildTitle` is carried rather than recomposed on the client: the build step already builds that string for the Teams card, and duplicating its separator convention in the extension would guarantee the two drift apart.

`projects` is a real list — observed builds carry ten entries. It is display data for the popup, not something to render into a desktop notification body.

The build step wraps its POST to this API in try/catch. A notifier outage must never fail a TeamCity build.

### Internal notification contract

~~~csharp
public sealed record BuildNotification(
    string NotificationId,
    string Event,
    string ProjectId,
    string ProjectName,
    string BuildId,
    string BuildTypeId,
    string BuildNumber,
    string BuildName,
    string BuildTitle,
    string Branch,
    string Status,
    string StatusText,
    string TriggeredBy,
    string BuildUrl,
    string? LogUrl,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    int? DurationSeconds,
    IReadOnlyList<string> Projects,
    DateTimeOffset ReceivedAt);
~~~

NotificationId is a deterministic SHA-256 value derived from projectId, buildId and event. The event discriminator is required: one build produces both a started and a finished notification with the same buildId, and omitting it would make the finished event look like a duplicate of the started one and be silently dropped. A retry of the same event must produce the same ID.

ReceivedAt is set from the server clock and never from the payload, so a wrong clock on a build agent cannot control buffer expiry.

## Endpoint behavior

| Endpoint | Auth | Success | Failure |
| --- | --- | --- | --- |
| POST /webhooks/teamcity | X-TeamCity-Secret | 202 for new event, 200 for duplicate | 400, 401, 413, 429, 500 |
| GET /health | Anonymous | 200 with status Healthy | — |
| /hubs/builds | Shared team token | Connected hub | 401/403 |

Webhook rate limit is 60 requests per minute per source IP. The body limit is 64 KB.

## Extension behavior

The extension stores serverUrl, accessToken, notifyOnStarted, a bounded list of seen notification IDs and build URL mappings in chrome.storage.local.

notifyOnStarted defaults to false. Finished events are always displayed; started events only when the preference is on. The filter is client-side because the server broadcasts every event to every client.

On startup it loads settings, stops if disabled or credentials are missing, creates a SignalR connection using accessTokenFactory, starts the connection, invokes GetRecent and shows only unseen notifications.

On reconnect it repeats the replay. A chrome.alarms alarm runs once per minute to wake the service worker and ensure a connection exists. A failed token must not cause an unbounded retry loop.

Build URLs are opened only when they start with the configured TeamCity base URL.

## Security requirements

- Production/test traffic uses HTTPS and WSS.
- Webhook secret and team access token are different random values of at least 32 bytes.
- Backend configuration stores SHA-256 hashes, not raw values.
- Raw team token is entered after extension installation and is not bundled in the package.
- The extension is granted API access through manifest host_permissions, not through a server-side origin allowlist.
- The server does not log request authorization headers or query strings containing access_token.
- The test site uses a trusted certificate on all team machines.
- IIS and log-directory ACLs are restricted to the application identity and administrators.
- The single-worker requirement is enforced because replay state is in process memory.

## IIS deployment constraints

- Install the .NET 8 ASP.NET Core Hosting Bundle.
- Enable IIS WebSocket Protocol.
- Use an HTTPS binding and the approved public test hostname.
- Configure one Application Pool worker process.
- Set App Pool start mode to AlwaysRunning.
- Keep deployment and log storage outside the source repository.
- Configure production secrets through protected IIS/environment configuration.
- Verify IIS logs and reverse-proxy logs do not expose bearer tokens.

## Acceptance criteria

- A valid build-finished event reaches the test API and returns 202.
- A build-started event for the same build also returns 202 and is not treated as a duplicate.
- A repeated event returns 200 and produces no second notification.
- A missing or incorrect webhook secret returns 401.
- A valid extension token can connect to /hubs/builds.
- An invalid extension token cannot connect.
- Every connected extension receives BuildEvent for every build.
- With notifyOnStarted off, a started event is received but not displayed.
- An extension that disconnects briefly receives still-buffered events after reconnect.
- An extension does not display the same NotificationId twice.
- IIS restart causes reconnect but intentionally does not restore events removed with the old process.
- JSONL audit logs are created, rotate daily, retain 14 days and contain no secrets.
- Chrome and Edge both install the same unpacked folder and connect with the same token.
- End-to-end tests cover success, failure, cancellation, duplicate webhook, invalid credentials, reconnect and click-through URL validation.

## Known limitations

The shared token cannot revoke one member independently. Everyone receives every build event, so a team with many noisy projects will want client-side filtering sooner rather than later. The RAM buffer cannot survive process/server restart. A browser that is fully closed cannot receive a live event. These are explicit MVP trade-offs; durable history, per-user identity and Web Push require a new design review.
