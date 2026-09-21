// Notification store - seen IDs must survive service worker death

const MAX_SEEN_IDS = 500;

// Pure helpers (no chrome API calls - testable with node --test)
export function hasSeen(ids, id) {
  return ids.includes(id);
}

export function markSeen(ids, id) {
  if (ids.includes(id)) {
    return ids;
  }
  return [...ids, id];
}

export function trimSeenIds(ids, max) {
  if (ids.length <= max) {
    return ids;
  }
  // Keep the most recent IDs
  return ids.slice(-max);
}

// Persistence wrappers
export async function loadSeenIds() {
  const result = await chrome.storage.local.get('seenIds');
  return result.seenIds || [];
}

export async function saveSeenIds(ids) {
  const trimmed = trimSeenIds(ids, MAX_SEEN_IDS);
  await chrome.storage.local.set({ seenIds: trimmed });
}
