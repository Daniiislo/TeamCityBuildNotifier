# TeamCity Integration

What the TeamCity side must send so it matches `docs/teamcity-payload.sample.json`. That file is the contract; this document is how TeamCity fulfills it.

## What changes

Nothing about the Microsoft Teams notification changes. The existing PowerShell step keeps building and posting its Adaptive Card exactly as it does today. It gains one extra POST at the end, to this API, with a flat JSON body.

Two scripts are edited: the build-started script (`event = "started"`) and the build-finished script (`event = "finished"`).

## The escaping trap

The existing script builds JSON by string interpolation into a here-string, so every value is pre-escaped for JSON — that is what the `$e` prefix means in `$eBranch`, `$eBuildTitle`, `$eStatus` and the rest.

**Do not reuse the `$e*` variables in the new POST.** It uses `ConvertTo-Json`, which escapes on its own. Feeding it a pre-escaped value escapes it twice, and a branch named `feature/a"b` or any build message containing a quote or backslash arrives corrupted.

Use the raw values the `$e*` variables were derived from. If a raw variable does not exist yet, create it and derive the escaped one from it, not the other way round.

## Three values need raw sources

The card carries these as display strings. The contract needs machine values. Values below are from a real build, `Geronimo - XYZ - Build #320`.

| Contract field | Card shows | Needs |
| --- | --- | --- |
| `durationSeconds` | `Duration: 00:22:29` | integer seconds, `1350` |
| `startedAt` / `finishedAt` | `2026-05-21 06:27:42` | ISO 8601 UTC, `2026-05-21T06:27:42Z` |
| `projects` | `📦 Projects (10)` + a markdown list | a string array of the ten names |

### Timezone — decide this before writing the script

`2026-05-21 06:50:12` carries **no timezone**. Nothing in the card says whether that is UTC, ICT, or whatever the agent's clock is set to. The Teams card gets away with it because a human reader knows the local convention; a JSON contract does not.

Confirm what the build agent's clock actually is, then convert explicitly:

~~~powershell
# if the source DateTime is agent-local
$startedUtc  = $startedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$finishedUtc = $finishedAt.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
~~~

Guessing wrong shifts every timestamp by the offset — seven hours for ICT — and the extension will show builds finishing in the future or in the middle of last night. The API cannot detect this; it will accept the value as given.

### Duration

Derive it from the timestamps, not by parsing the display string. `00:22:29` is rounded, and re-parsing a formatted value to recover a number it was formatted from is work that can only lose precision:

~~~powershell
$durationSec = [int]($finishedAt - $startedAt).TotalSeconds
~~~

### Projects

~~~powershell
$projects = @($projectList)   # the list $eProjectsMd was rendered from
~~~

`@()` matters. A build touching one project would otherwise serialize as a bare string instead of a one-element array, and the validator would reject it.

Ten project names is normal for these builds. Send the array; the extension shows the count and keeps the names for its popup rather than stuffing them into a desktop notification.

### buildTitle

`$eBuildTitle` — `Geronimo - XYZ - Build` — passes through raw as `buildTitle`. The extension uses it as the notification heading rather than recomposing one from `projectName` and `buildName`, so the two surfaces cannot drift apart.

Note the started card labels a field `Config: XYZ` while `buildTitle` renders `XYZ` as the middle segment. Check which TeamCity parameter `$eConfig` actually holds before mapping it — if it is the project name rather than the build configuration name, map it to `projectName`, not `buildName`.

## Field sources

| Field | TeamCity parameter | Notes |
| --- | --- | --- |
| `buildId` | `%teamcity.build.id%` | internal numeric ID, not the build number |
| `buildTypeId` | `%system.teamcity.buildType.id%` | |
| `projectId` | `%system.teamcity.projectId%` | **stable ID, never the display name** |
| `projectName` | `%system.teamcity.projectName%` | display only |
| `buildName` | `%system.teamcity.buildConfName%` | |
| `buildTitle` | existing `$eBuildTitle` | pass through raw |
| `buildNumber` | `%build.number%` | |
| `branch` | `%teamcity.build.branch%` | |
| `triggeredBy` | `%teamcity.build.triggeredBy%` | |
| `buildUrl` | `%teamcity.serverUrl%/viewLog.html?buildId=%teamcity.build.id%` | must be under the configured base URL |
| `logUrl` | same plus `&tab=buildLog` | `null` on `started` |

Bind them as build parameters at the top of the step so the script reads plain PowerShell variables:

~~~powershell
$buildId     = "%teamcity.build.id%"
$buildTypeId = "%system.teamcity.buildType.id%"
$projectId   = "%system.teamcity.projectId%"
$projectName = "%system.teamcity.projectName%"
$buildName   = "%system.teamcity.buildConfName%"
$buildNumber = "%build.number%"
$branch      = "%teamcity.build.branch%"
$triggeredBy = "%teamcity.build.triggeredBy%"
$serverUrl   = "%teamcity.serverUrl%"
$buildUrl    = "$serverUrl/viewLog.html?buildId=$buildId"
~~~

## Status values

Only four are accepted. Anything else is rejected with 400.

| Event | Status |
| --- | --- |
| `started` | `RUNNING` |
| `finished` | `SUCCESS`, `FAILURE` or `CANCELLED` |

Map TeamCity's own status text to these explicitly. Do not forward the raw TeamCity string.

## The POST

Appended to the **finished** script, after the Teams call:

~~~powershell
$notify = @{
  event           = "finished"
  buildId         = $buildId
  buildTypeId     = $buildTypeId
  projectId       = $projectId
  projectName     = $projectName
  buildName       = $buildName
  buildTitle      = $buildTitle      # raw, not $eBuildTitle
  buildNumber     = $buildNumber
  branch          = $branch
  status          = $status          # SUCCESS | FAILURE | CANCELLED
  statusText      = $statusText
  triggeredBy     = $triggeredBy
  startedAt       = $startedUtc
  finishedAt      = $finishedUtc
  durationSeconds = $durationSec
  buildUrl        = $buildUrl
  logUrl          = "$buildUrl&tab=buildLog"
  projects        = @($projects)
} | ConvertTo-Json -Compress

try {
  Invoke-RestMethod -Uri "$env:NOTIFIER_URL/webhooks/teamcity" -Method Post `
    -ContentType "application/json" `
    -Headers @{ "X-TeamCity-Secret" = $env:NOTIFIER_SECRET } `
    -Body $notify `
    -TimeoutSec 10 | Out-Null
} catch {
  Write-Warning "Build notifier unreachable: $($_.Exception.Message)"
}
~~~

The **started** script is the same block with `event = "started"`, `status = "RUNNING"`, and `finishedAt`, `durationSeconds` and `logUrl` set to `$null`.

Three things in that block are not decoration:

- **`try/catch`** — a notifier outage must never turn a build red. This is a notification, not a build step.
- **`-TimeoutSec 10`** — without it a hung API stalls every build on the agent.
- **`| Out-Null`** — keeps the response body out of the build log.

## Configuration

`NOTIFIER_URL` and `NOTIFIER_SECRET` are environment variables on the build agent, or TeamCity parameters of type `password`. The secret must never appear in the script body, in a plain build parameter, or in the build log.

The API stores only the SHA-256 hash of that secret. Generate the pair with the `New-Secret` helper in Task 2 of the implementation plan, which uses `RandomNumberGenerator.Fill` — `Get-Random` is not a cryptographic source and must not be used for this.

The webhook secret is a different value from the team access token. Sharing one value between them means a leaked extension token also lets anyone forge build events.

## Verifying without running a build

Post the fixture directly:

~~~powershell
$sample = (Get-Content docs/teamcity-payload.sample.json -Raw | ConvertFrom-Json).finished
Invoke-RestMethod -Uri "$env:NOTIFIER_URL/webhooks/teamcity" -Method Post `
  -ContentType "application/json" `
  -Headers @{ "X-TeamCity-Secret" = $env:NOTIFIER_SECRET } `
  -Body ($sample | ConvertTo-Json -Compress)
~~~

Expected: `202` the first time, `200` the second (duplicate, no second notification). Wrong or missing secret: `401`.

## Changing the contract later

Adding an optional field is safe — the validator ignores unknown fields and the extension renders what it knows. Renaming or removing a field is not: update `docs/teamcity-payload.sample.json` first, then the validator and its tests, then both PowerShell scripts. The fixture is what keeps the two sides honest.
