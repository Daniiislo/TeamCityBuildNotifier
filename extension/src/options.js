import { loadSettings, saveSettings } from './settings.js';

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await loadSettings();

  document.getElementById('serverUrl').value = settings.serverUrl;
  document.getElementById('accessToken').value = settings.accessToken;
  document.getElementById('teamCityBaseUrl').value = settings.teamCityBaseUrl;
  document.getElementById('notifyOnStarted').checked = settings.notifyOnStarted;
  document.getElementById('enabled').checked = settings.enabled;

  document.getElementById('save').addEventListener('click', async () => {
    const newSettings = {
      serverUrl: document.getElementById('serverUrl').value.trim(),
      accessToken: document.getElementById('accessToken').value.trim(),
      teamCityBaseUrl: document.getElementById('teamCityBaseUrl').value.trim(),
      notifyOnStarted: document.getElementById('notifyOnStarted').checked,
      enabled: document.getElementById('enabled').checked
    };

    try {
      await saveSettings(newSettings);

      const statusEl = document.getElementById('status');
      statusEl.textContent = 'Settings saved successfully';
      statusEl.className = 'status success';

      setTimeout(() => {
        statusEl.className = 'status';
      }, 3000);
    } catch (error) {
      const statusEl = document.getElementById('status');
      statusEl.textContent = 'Failed to save settings: ' + error.message;
      statusEl.className = 'status error';
    }
  });
});
