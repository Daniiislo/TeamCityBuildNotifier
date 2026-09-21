import * as signalR from '@microsoft/signalr';
import { loadSettings, saveSettings } from './settings.js';
import { loadSeenIds, saveSeenIds, hasSeen, markSeen } from './notification-store.js';
import { isAllowedBuildUrl } from './url-validation.js';
import { eventKind, KIND_ICON, KIND_LABEL, formatDuration, eventTimestamp, formatStamp } from './event-style.js';

let connection = null;
let settings = null;
let seenIds = [];
let isUnauthorized = false;
let isInitialized = false;

// Initialize on worker start
(async () => {
  settings = await loadSettings();
  seenIds = await loadSeenIds();
  isInitialized = true;
  await ensureConnection();
})();

// Ensure connection exists
async function ensureConnection() {
  if (!isInitialized) return; // Guard against early calls

  if (!settings.enabled || !settings.serverUrl || !settings.accessToken) {
    await setConnectionStatus('disabled');
    return;
  }

  if (isUnauthorized) {
    await setConnectionStatus('unauthorized');
    return;
  }

  if (connection && (connection.state === signalR.HubConnectionState.Connected ||
                     connection.state === signalR.HubConnectionState.Connecting)) {
    return;
  }

  await setConnectionStatus('connecting');

  try {
    connection = new signalR.HubConnectionBuilder()
      .withUrl(`${settings.serverUrl}/hubs/builds`, {
        accessTokenFactory: () => settings.accessToken
      })
      .withAutomaticReconnect([0, 2000, 10000, 30000, 60000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    connection.on('BuildEvent', handleNotification);

    connection.onreconnected(async () => {
      console.log('Reconnected to SignalR hub');
      await setConnectionStatus('connected');
      await replay();
    });

    connection.onclose(async (error) => {
      if (error) {
        console.error('Connection closed with error:', error);
      }
      await setConnectionStatus('connecting');
    });

    await connection.start();
    await setConnectionStatus('connected');
    await replay();

  } catch (error) {
    console.error('Failed to connect:', error);

    if (error?.statusCode === 401 || error?.message?.includes('401')) {
      isUnauthorized = true;
      await setConnectionStatus('unauthorized');
    } else {
      await setConnectionStatus('connecting');
    }
  }
}

// Replay recent notifications
async function replay() {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
    return;
  }

  try {
    const notifications = await connection.invoke('GetRecent', 50);

    // Display only unseen events, oldest first
    for (const notification of notifications) {
      if (!hasSeen(seenIds, notification.notificationId)) {
        await handleNotification(notification, true);
      }
    }
  } catch (error) {
    console.error('Failed to replay notifications:', error);
  }
}

// Handle incoming notification
async function handleNotification(notification, isReplay = false) {
  // Skip if already seen
  if (hasSeen(seenIds, notification.notificationId)) {
    return;
  }

  // Ping on every new event, including 'started' ones the toast preference
  // drops below, so an open status panel can refresh itself off the push we
  // already receive - no polling.
  await chrome.storage.local.set({ lastEventAt: Date.now() });

  // Skip started events if preference is off
  if (notification.event === 'started' && !settings.notifyOnStarted) {
    return;
  }

  // Mark as seen BEFORE creating notification
  seenIds = markSeen(seenIds, notification.notificationId);
  await saveSeenIds(seenIds);

  // Add to recent events list
  await addToRecentEvents(notification);

  // Create desktop notification.
  // Windows renders the title plus roughly two body lines and truncates the
  // rest, so those two lines carry what matters: which build, and when.
  const kind = eventKind(notification);
  const when = eventTimestamp(notification);
  const duration = formatDuration(notification.durationSeconds);

  const timeLine = [
    when ? formatStamp(when) : null,
    duration ? `took ${duration}` : null
  ].filter(Boolean).join(' · ');

  // Secondary detail. Chrome renders it as a smaller third line where the
  // platform allows one; if it is dropped nothing is lost, the popup has it all.
  const contextMessage = [
    notification.branch,
    notification.triggeredBy,
    notification.projects?.length
      ? `📦 ${notification.projects.length} project${notification.projects.length > 1 ? 's' : ''}`
      : null
  ].filter(Boolean).join(' · ');

  chrome.notifications.create(notification.notificationId, {
    type: 'basic',
    iconUrl: 'icons/icon-128.png',
    title: `${KIND_ICON[kind]} ${KIND_LABEL[kind]}${notification.buildNumber ? ` · #${notification.buildNumber}` : ''}`,
    message: [notification.buildTitle, timeLine].filter(Boolean).join('\n'),
    contextMessage: contextMessage || undefined,
    priority: kind === 'failure' ? 2 : 0,
    requireInteraction: false
  });
}

// Add to recent events list for popup
async function addToRecentEvents(notification) {
  const { recentEvents = [] } = await chrome.storage.local.get('recentEvents');
  recentEvents.push(notification);

  // Keep only last 20
  const trimmed = recentEvents.slice(-20);
  await chrome.storage.local.set({ recentEvents: trimmed });
}

// Set connection status
async function setConnectionStatus(status) {
  await chrome.storage.local.set({ connectionStatus: status });
}

// Handle notification click
chrome.notifications.onClicked.addListener(async (notificationId) => {
  // recentEvents already holds buildUrl keyed by notificationId, so there is no
  // separate id -> url map to keep in sync (and to grow forever).
  const { recentEvents = [] } = await chrome.storage.local.get('recentEvents');
  const buildUrl = recentEvents.find(e => e.notificationId === notificationId)?.buildUrl;

  // settings may still be null if the worker woke up for this click.
  if (buildUrl && isAllowedBuildUrl(buildUrl, settings?.teamCityBaseUrl)) {
    await chrome.tabs.create({ url: buildUrl });
  }

  chrome.notifications.clear(notificationId);
});

// On-demand status pull from the popup. Nothing here is pushed or polled:
// it runs only when the user asks. Deliberately bypasses handleNotification,
// so checking status never raises a toast nor marks anything as seen.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'getStatus') return;
  pullRecent().then(sendResponse);
  return true; // keep the channel open for the async reply
});

async function pullRecent() {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
    await ensureConnection();
  }

  if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
    return { error: isUnauthorized ? 'Unauthorized - check your token' : 'Not connected to the server' };
  }

  try {
    return { notifications: await connection.invoke('GetRecent', 50) };
  } catch (error) {
    console.error('Status pull failed:', error);
    return { error: error?.message || 'Could not reach the server' };
  }
}

// Create alarm to ensure connection
chrome.alarms.create('ensure-connection', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ensure-connection') {
    ensureConnection();
  }
});

// Reconnect on startup
chrome.runtime.onStartup.addListener(() => {
  ensureConnection();
});

// Reconnect on install
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove('notificationUrls'); // removed in favour of recentEvents
  await ensureConnection();
});

// Reconnect when settings change
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.settings) {
    settings = await loadSettings();
    isUnauthorized = false; // Reset unauthorized flag on settings change

    // Close existing connection if any
    if (connection) {
      await connection.stop();
      connection = null;
    }

    await ensureConnection();
  }
});
