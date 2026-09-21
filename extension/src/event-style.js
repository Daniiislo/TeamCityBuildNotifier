// Single source of truth for how a build event is labelled, iconed and coloured.
// background.js (desktop notification) and popup.js (list) both read from here
// so the two can't drift apart again.

export function eventKind(notification) {
  if (notification.event === 'started') return 'started';

  switch (notification.status) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': return 'failure';
    case 'CANCELLED': return 'cancelled';
    default: return 'unknown';
  }
}

export const KIND_ICON = {
  success: '✅',
  failure: '❌',
  cancelled: '⚠️',
  started: '🚀',
  unknown: '🔔'
};

export const KIND_LABEL = {
  success: 'Build Succeeded',
  failure: 'Build Failed',
  cancelled: 'Build Cancelled',
  started: 'Build Started',
  unknown: 'Build Status'
};

export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return null;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

// When the event actually happened: a finished build is stamped by its end,
// a running one by its start. receivedAt is the last resort.
export function eventTimestamp(notification) {
  const raw = notification.finishedAt || notification.startedAt || notification.receivedAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

const RELATIVE_UNITS = [['day', 86400], ['hour', 3600], ['minute', 60]];

// "5 minutes ago" - for the collapsed list, where a glance is all you get.
export function formatRelative(date, now = Date.now()) {
  const diffSeconds = Math.round((date.getTime() - now) / 1000);
  const magnitude = Math.abs(diffSeconds);

  if (magnitude < 45) return 'just now';

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (magnitude >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
  }
  return rtf.format(Math.round(diffSeconds / 60), 'minute');
}

// "13:50", or "Sep 21, 13:50" once it is no longer today. Used on the desktop
// toast, where a replayed build could be hours old and "just now" would lie.
export function formatStamp(date, now = new Date()) {
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
