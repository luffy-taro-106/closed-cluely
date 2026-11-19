'use strict';
// Apply the saved appearance before CSS paints. The main process supplies the
// launch preference; the in-memory session cache also covers renderer reloads.
try {
  const theme = sessionStorage.getItem('appearance') || new URLSearchParams(location.search).get('theme');
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
} catch { document.documentElement.dataset.theme = 'dark'; }
