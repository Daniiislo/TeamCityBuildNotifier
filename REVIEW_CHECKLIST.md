# Review & Testing Checklist

## Automated Review Tasks

When classifier becomes available, spawn these agents:

### Agent 1: Backend Security & Architecture Review

**Focus Areas:**
- [ ] Secret handling - verify no raw secrets stored or logged
- [ ] Authentication - TeamTokenAuthenticationHandler logic
- [ ] Input validation - BuildEventValidator edge cases
- [ ] Rate limiting - verify IP-based rate limiter configuration
- [ ] Thread safety - NotificationBuffer lock usage
- [ ] SQL injection / XSS prevention (N/A but verify)
- [ ] URL validation - origin comparison in BuildEventValidator
- [ ] Error handling - exceptions properly caught and logged
- [ ] Resource disposal - SignalR connections, HTTP contexts

**Critical Code Paths:**
1. Webhook endpoint: secret verification BEFORE deserialization
2. NotificationBuffer: dedupe logic under concurrent access
3. BuildEventValidator: URL allowlist validation
4. TeamTokenAuthenticationHandler: query string access_token only for /hubs/builds

### Agent 2: Extension Security & MV3 Patterns Review

**Focus Areas:**
- [ ] Service worker lifecycle - handles death/revival correctly
- [ ] Seen-ID persistence - survives worker restart
- [ ] Race conditions - settings/seenIds loaded before first connection
- [ ] URL validation - origin comparison, not string prefix
- [ ] Notification deduplication - mark seen BEFORE creating notification
- [ ] 401 handling - stops retry loop on unauthorized
- [ ] SignalR reconnect - automatic reconnect configured correctly
- [ ] Memory leaks - event listeners cleaned up
- [ ] XSS prevention - popup.js uses escapeHtml

**Critical Code Paths:**
1. background.js initialization - await loadSettings() and loadSeenIds()
2. handleNotification - dedupe → markSeen → saveSeenIds → create notification
3. ensureConnection - idempotent, doesn't hammer on 401
4. url-validation.js - rejects evil.com subdomain attack

### Agent 3: End-to-End Integration Tester

**Test Scenarios:**

#### Backend Tests
- [ ] POST /health returns 200 with {"status":"Healthy"}
- [ ] POST /webhooks/teamcity with valid secret → 202
- [ ] Same payload again → 200 (duplicate, no second broadcast)
- [ ] Missing X-TeamCity-Secret header → 401
- [ ] Wrong X-TeamCity-Secret → 401
- [ ] Invalid JSON → 400
- [ ] Body > 64KB → 413
- [ ] buildUrl on different host → 400
- [ ] Started and finished for same build → both accepted, different IDs
- [ ] 61st request in same minute → 429 (rate limited)

#### Extension Tests
- [ ] npm test passes all pure function tests
- [ ] evil.com URL rejected (test already exists)
- [ ] trimSeenIds keeps most recent when over limit
- [ ] markSeen doesn't duplicate

#### Integration Tests (requires running API)
- [ ] Extension connects with valid token → popup shows "Connected"
- [ ] Extension with wrong token → popup shows "Unauthorized"
- [ ] POST webhook → desktop notification appears
- [ ] Click notification → TeamCity tab opens
- [ ] Kill service worker → alarm revives it within 1 minute
- [ ] Worker restart → replay doesn't re-notify (seen-ID persistence)
- [ ] Two events from same build → both show, not treated as duplicate

## Manual Verification Checklist

### Before First Run

- [ ] Run `dotnet restore` and `dotnet build` successfully
- [ ] Run `dotnet test` - all tests pass
- [ ] Run `npm install` in extension/
- [ ] Run `npm test` - all tests pass
- [ ] Run `npm run build` - dist/ folder created
- [ ] Convert icons SVG → PNG (or accept SVG for dev)

### Local API Testing

Start API:
```powershell
cd BuildStatusNotification
dotnet run
```

- [ ] Browse to https://localhost:5001/health (adjust port)
- [ ] Returns {"status":"Healthy"}

Generate test secrets:
```powershell
.\scripts\Generate-Secrets.ps1
```

Update appsettings.Development.json with SHA-256 hashes.

Test webhook (replace secret with generated value):
```powershell
$sample = (Get-Content docs/teamcity-payload.sample.json | ConvertFrom-Json).finished
$secret = "YOUR_RAW_WEBHOOK_SECRET"

Invoke-RestMethod -Uri "https://localhost:5001/webhooks/teamcity" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "X-TeamCity-Secret" = $secret } `
  -Body ($sample | ConvertTo-Json -Compress) `
  -SkipCertificateCheck
```

Expected:
- [ ] First call: 202
- [ ] Second call: 200 (duplicate)

Wrong secret:
```powershell
Invoke-RestMethod -Uri "https://localhost:5001/webhooks/teamcity" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "X-TeamCity-Secret" = "wrong" } `
  -Body ($sample | ConvertTo-Json -Compress) `
  -SkipCertificateCheck
```

Expected:
- [ ] 401 Unauthorized

### Extension Testing

1. Update manifest.json host_permissions:
   - Replace `https://buildnotify.example/*` with `https://localhost:5001/*`
   - Keep TeamCity URL or use `https://teamcity.example/*`

2. Load unpacked:
   - [ ] Open chrome://extensions
   - [ ] Enable Developer mode
   - [ ] Load unpacked → select extension/dist/
   - [ ] No errors in console

3. Configure options:
   - [ ] Click extension icon → Options
   - [ ] Server URL: `https://localhost:5001`
   - [ ] Access Token: raw team token from Generate-Secrets.ps1
   - [ ] TeamCity Base URL: `https://teamcity.example`
   - [ ] Enable notifications: checked
   - [ ] Save

4. Check connection:
   - [ ] Open extension popup
   - [ ] Status shows "Connected" (may take up to 1 minute)
   - [ ] No errors in service worker console (chrome://extensions → service worker)

5. Test notification:
   - [ ] POST webhook again (first or finished sample)
   - [ ] Desktop notification appears
   - [ ] Notification shows correct title, build info
   - [ ] Click notification → opens tab (URL validation may block if TeamCity URL mismatch)
   - [ ] Check popup → event appears in recent list

6. Test deduplication:
   - [ ] POST same webhook again
   - [ ] No second notification appears
   - [ ] API logs show "duplicate"

7. Test service worker survival:
   - [ ] chrome://extensions → service worker → Terminate
   - [ ] Wait ~1 minute for alarm
   - [ ] Check popup → still shows "Connected"
   - [ ] POST new webhook → notification appears

8. Test replay after disconnect:
   - [ ] POST webhook while connected
   - [ ] Terminate service worker
   - [ ] Wait for reconnect
   - [ ] Check: notification should NOT reappear (seen-ID persistence)

## Security Verification

- [ ] Grep logs for secrets:
  ```powershell
  Select-String -Path "D:\AppData\BuildStatusNotification\Logs\*.jsonl" -Pattern "Bearer|access_token|X-TeamCity-Secret"
  ```
  Should return nothing.

- [ ] Check appsettings.json contains only SHA-256 hashes, not raw secrets
- [ ] Verify secrets are 32 bytes (44 chars base64) minimum
- [ ] Verify webhook secret ≠ team token
- [ ] Test: buildUrl on evil.com subdomain rejected

## Performance Testing

- [ ] Send 60 webhooks in 60 seconds → all accepted
- [ ] Send 61st webhook → 429 rate limited
- [ ] Buffer at capacity (200 items) → oldest evicted
- [ ] 10 connected extensions → all receive broadcast

## Documentation Review

- [ ] README.md complete and accurate
- [ ] docs/iis-deployment.md has all necessary steps
- [ ] docs/teamcity-integration.md sample scripts correct
- [ ] docs/extension-install.md load-unpacked steps accurate
- [ ] IMPLEMENTATION_SUMMARY.md reflects actual implementation

## Known Issues to Document

List any issues found during review/testing here:

1. 
2. 
3. 

## Sign-off

- [ ] Backend review complete - Reviewer: __________ Date: __________
- [ ] Extension review complete - Reviewer: __________ Date: __________
- [ ] Integration tests pass - Tester: __________ Date: __________
- [ ] Security verification complete - Security: __________ Date: __________
- [ ] Ready for production deployment

## Notes

Additional observations or recommendations:
