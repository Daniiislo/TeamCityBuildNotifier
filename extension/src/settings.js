// Settings management
const DEFAULTS = {
  serverUrl: '',
  accessToken: '',
  teamCityBaseUrl: '',
  notifyOnStarted: false,
  enabled: true
};

export async function loadSettings() {
  const result = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(result.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
