# Extension Installation

The extension is installed locally from a folder. It is not published to the Chrome Web Store or Edge Add-ons.

## Why not a .crx file

Chrome and Edge on Windows refuse extensions installed by dragging a `.crx` onto the extensions page — they must come from the store or from enterprise policy. Handing the team a `.crx` file does not work.

Two options remain:

- **Load unpacked** — each person loads a folder. No infrastructure. This is what we use.
- **Enterprise policy** — force-install through Group Policy pointing at an internally hosted update URL. Proper managed distribution: automatic install, automatic updates, no Developer mode. But it needs GPO access and a server hosting `updates.xml` plus the `.crx`. Worth doing when the tool outgrows the test site; not before.

## What gets distributed

`npm run build` produces a self-contained `extension/dist/` folder:

~~~text
extension/dist/
  manifest.json
  background.js      bundled service worker
  options.html
  options.js
  icons/
~~~

That folder is the whole deliverable. Zip it, put it on a share, and everyone unzips it somewhere permanent.

**The folder must stay where it was loaded from.** Chrome does not copy it — it references the path. Move or delete the folder and the extension breaks on next browser start. Tell people not to unzip it into Downloads.

## Installing

Identical in both browsers.

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `dist` folder.
4. Open the extension's **Options** and fill in:
   - **Server URL** — the API base, e.g. `https://buildnotify.example`
   - **Access token** — the shared team token, sent over a channel that is not this page
   - **TeamCity base URL** — used to validate build links before opening them
   - **Notify on build started** — off by default
5. Save. The status line should read connected.

Developer mode has to stay on for an unpacked extension to keep running, and the browser may warn about developer-mode extensions at startup. That is the cost of not being in the store.

## Extension ID

Each machine gets a different ID, because an unpacked extension's ID comes from its folder path. Nothing here depends on it, so it does not matter.

Pinning the ID — a fixed `key` in `manifest.json`, generated from a `key.pem` — is only worth doing if this later moves to enterprise policy install, which addresses extensions by ID.

## How the extension reaches the API

The API host is listed in the manifest's `host_permissions`. That is what grants the service worker permission to call the API and open the SignalR WebSocket; Chrome allows those cross-origin requests on the strength of the host permission.

The server has no CORS allowlist, deliberately. CORS exists to stop a hostile page from riding a user's ambient credentials — cookies — on a cross-origin request. This API has no cookies and no session: every call carries the token explicitly, and a page without the token gains nothing from being allowed to ask. The token is the security boundary. Adding an origin allowlist on top would be a second lock on a door that is already the wrong door to attack.

## Updating

Rebuild, replace the contents of the `dist` folder, then press **Reload** on the extension card. There is no auto-update for unpacked extensions — that is one of the things enterprise policy would buy.

Because there is no auto-update, avoid shipping breaking API changes without telling people to reload.

## Uninstalling

Remove from the extensions page. The stored token lives in `chrome.storage.local` and goes with it.

## A note on the token

The shared token sits in `chrome.storage.local` in plain text. Anyone with access to the browser profile can read it. That is an accepted trade-off of the shared-token design — the token grants read-only access to build notifications and nothing else. If someone leaves the team, rotate it: change the hash in the server config and have everyone re-enter the new value.
