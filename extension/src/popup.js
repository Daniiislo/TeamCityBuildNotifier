import { loadSettings } from './settings.js';
import { isAllowedBuildUrl } from './url-validation.js';
import { currentStatus } from './build-status.js';
import { eventKind, KIND_ICON, KIND_LABEL, formatDuration, eventTimestamp, formatRelative, formatStamp } from './event-style.js';

// Events in render order (newest first). Rows reference these by integer index,
// so no user-controlled string ever lands in an HTML attribute.
let rendered = [];
let settings = null;

document.addEventListener('DOMContentLoaded', async () => {
  settings = await loadSettings();

  const { connectionStatus } = await chrome.storage.local.get('connectionStatus');
  updateStatus(connectionStatus || 'connecting');

  const { recentEvents } = await chrome.storage.local.get('recentEvents');
  renderEvents(recentEvents || []);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.connectionStatus) {
      updateStatus(changes.connectionStatus.newValue);
    }
    if (changes.recentEvents) {
      renderEvents(changes.recentEvents.newValue || []);
    }
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
    }
    // A build event just arrived. Only re-pull if the panel is actually open.
    if (changes.lastEventAt && !document.getElementById('current').hidden) {
      checkStatus();
    }
  });

  document.getElementById('clear-all').addEventListener('click', clearAll);
  document.getElementById('toggle-status').addEventListener('click', toggleStatus);
  document.getElementById('refresh-status').addEventListener('click', checkStatus);
  document.getElementById('events').addEventListener('click', onEventsClick);
});

function updateStatus(status) {
  const statusEl = document.getElementById('status');
  statusEl.className = `status ${status}`;

  const statusText = {
    connected: 'Connected',
    connecting: 'Connecting...',
    unauthorized: 'Unauthorized - Check your token',
    disabled: 'Disabled'
  };

  statusEl.textContent = statusText[status] || 'Unknown';
}

function renderEvents(events) {
  rendered = events.slice().reverse();

  const eventsEl = document.getElementById('events');
  document.getElementById('clear-all').disabled = rendered.length === 0;

  if (rendered.length === 0) {
    eventsEl.innerHTML = '<div class="empty">No recent notifications</div>';
    return;
  }

  eventsEl.innerHTML = rendered.map(renderEvent).join('');
}

function renderEvent(event, idx) {
  const kind = eventKind(event);

  // Identity line stays "what/who". Anything time-shaped goes to the row below,
  // labelled - an unlabelled "22m 30s" next to a clock reads as a timestamp.
  const meta = [`#${event.buildNumber}`, event.branch, event.triggeredBy].filter(Boolean);
  const duration = formatDuration(event.durationSeconds);
  const when = eventTimestamp(event);

  return `
    <details class="event ${kind}">
      <summary>
        <span class="caret">▶</span>
        <div class="summary-body">
          <div class="event-title">${KIND_ICON[kind]} ${escapeHtml(event.statusText || KIND_LABEL[kind])}</div>
          <div class="event-build">${escapeHtml(event.buildTitle || '')}</div>
          <div class="event-meta">${meta.map(escapeHtml).join(' · ')}</div>
          ${when || duration ? `
          <div class="event-when">
            ${when ? `<span class="when-clock">${escapeHtml(formatStamp(when))}</span>
            <span class="when-relative">${escapeHtml(formatRelative(when))}</span>` : ''}
            ${duration ? `<span class="when-duration">took ${escapeHtml(duration)}</span>` : ''}
          </div>` : ''}
        </div>
        <button class="dismiss" type="button" data-action="dismiss" data-idx="${idx}" title="Remove">×</button>
      </summary>
      ${renderDetail(event, idx)}
    </details>
  `;
}

function renderDetail(event, idx) {
  const rows = [
    ['Project', event.projectName],
    ['Build', event.buildName],
    ['Number', event.buildNumber],
    ['Branch', event.branch],
    ['Status', event.status],
    ['Triggered by', event.triggeredBy],
    ['Started', formatTime(event.startedAt)],
    ['Finished', formatTime(event.finishedAt)],
    ['Duration', formatDuration(event.durationSeconds)],
    ['Projects', event.projects?.length ? event.projects.join(', ') : null]
  ];

  const cells = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(String(value))}</dd>`)
    .join('');

  const links = [
    event.buildUrl ? `<button class="link-btn" type="button" data-action="open" data-idx="${idx}" data-link="build">Open build</button>` : '',
    event.logUrl ? `<button class="link-btn" type="button" data-action="open" data-idx="${idx}" data-link="log">Build log</button>` : ''
  ].join('');

  return `<dl class="detail">${cells}${links ? `<div class="detail-links">${links}</div>` : ''}</dl>`;
}

async function onEventsClick(e) {
  const button = e.target.closest('button[data-action]');
  if (!button) return;

  // Buttons live inside <summary>; without this the row would also toggle.
  e.preventDefault();

  const event = rendered[Number(button.dataset.idx)];
  if (!event) return;

  if (button.dataset.action === 'dismiss') {
    await dismiss(event.notificationId);
  } else if (button.dataset.action === 'open') {
    const url = button.dataset.link === 'log' ? event.logUrl : event.buildUrl;
    if (url && isAllowedBuildUrl(url, settings.teamCityBaseUrl)) {
      await chrome.tabs.create({ url });
    }
  }
}

// recentEvents is also what background.js resolves a clicked desktop
// notification against, so a removed row takes its OS toast with it.
async function dismiss(notificationId) {
  const { recentEvents = [] } = await chrome.storage.local.get('recentEvents');
  await chrome.storage.local.set({
    recentEvents: recentEvents.filter(e => e.notificationId !== notificationId)
  });
  chrome.notifications.clear(notificationId);
}

// Only the displayed list is cleared. seenIds is deliberately left alone,
// otherwise the next replay would re-notify everything that was just cleared.
async function clearAll() {
  const ids = rendered.map(e => e.notificationId);
  await chrome.storage.local.set({ recentEvents: [] });
  for (const id of ids) {
    chrome.notifications.clear(id);
  }
}

// Pull-only. The panel is collapsed until the user opens it, fetches once on
// open, and otherwise refreshes only when the refresh button is pressed.
async function toggleStatus() {
  const panel = document.getElementById('current');
  const toggle = document.getElementById('toggle-status');
  const refresh = document.getElementById('refresh-status');

  const opening = panel.hidden;
  panel.hidden = !opening;
  refresh.hidden = !opening;
  toggle.textContent = opening ? 'Hide' : 'Show';

  if (opening) await checkStatus();
}

async function checkStatus() {
  const refresh = document.getElementById('refresh-status');
  const panel = document.getElementById('current');

  refresh.disabled = true;
  panel.innerHTML = '<div class="current-message">Checking...</div>';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
    panel.innerHTML = response?.error
      ? `<div class="current-message">${escapeHtml(response.error)}</div>`
      : renderCurrent(response?.notifications || []);
  } catch (error) {
    panel.innerHTML = `<div class="current-message">${escapeHtml(error?.message || 'Could not reach the service worker')}</div>`;
  } finally {
    refresh.disabled = false;
  }
}

function renderCurrent(notifications) {
  const { rows, counts } = currentStatus(notifications);

  const tallies = [
    ['running', counts.running, 'running'],
    ['success', counts.success, 'passed'],
    ['failure', counts.failure, 'failed'],
    ['cancelled', counts.cancelled, 'cancelled']
  ]
    .filter(([, n]) => n > 0)
    .map(([cls, n, word]) => `<span class="count ${cls}"><b>${n}</b> ${word}</span>`)
    .join('');

  const head = `<div class="current-counts">${tallies || '<span class="count">Nothing in the window</span>'}</div>`;

  const body = rows.length === 0
    ? '<div class="current-message">No build has started or finished recently.</div>'
    : rows.map(renderCurrentRow).join('');

  // Stamped to the second: two checks a minute apart must look different,
  // otherwise an unchanged panel reads as a broken button.
  const foot = `<div class="current-foot">Checked ${new Date().toLocaleTimeString()} · ${notifications.length} event${notifications.length === 1 ? '' : 's'} in the server's last 60 minutes</div>`;

  return head + body + foot;
}

const STATE_LABEL = {
  started: 'Running now',
  success: 'Succeeded',
  failure: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown'
};

function renderCurrentRow({ running, build }) {
  const kind = running ? 'started' : eventKind(build);
  const when = eventTimestamp(build);
  const duration = formatDuration(build.durationSeconds);

  const name = [build.buildTitle, build.buildNumber ? `#${build.buildNumber}` : null]
    .filter(Boolean).join('  ');

  const detail = [
    when ? `${running ? 'started' : 'finished'} ${formatStamp(when)}` : null,
    when ? formatRelative(when) : null,
    duration ? `took ${duration}` : null
  ].filter(Boolean).join(' · ');

  return `
    <div class="current-row ${kind}">
      <div class="current-state">${KIND_ICON[kind]} ${STATE_LABEL[kind]}</div>
      <div class="current-name">${escapeHtml(name)}</div>
      <div class="current-when">${escapeHtml(detail)}</div>
    </div>
  `;
}

function formatTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
