// ===== Shared Constants =====
const API_URL = '/api';

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
const escapeHtml = escapeAttr;

/**
 * Format a UTC timestamp (seconds) to a local datetime string.
 */
function formatDateTime(timestamp) {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * Attempt to refresh the access token using the refresh-token cookie.
 * Returns true if a new access token was obtained.
 */
async function tryRefresh() {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper: fetch with credentials.
 * Automatically retries once via the refresh endpoint on 401.
 */
async function authFetch(url, options = {}) {
  let res = await fetch(url, { ...options, credentials: 'include' });

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry the original request with the new access token
      res = await fetch(url, { ...options, credentials: 'include' });
    }
  }

  if (res.status === 429) {
    showToast('Too many requests. Please wait a moment and try again.', 'warning', 4000);
  }

  return res;
}

// ===== Toast Notifications =====
function showToast(message, type = 'warning', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) {
    console.error('Toast container not found');
    return;
  }
  const toast = document.createElement('div');
  toast.className = `app-toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ===== Custom Dialog =====
function showDialog(title, message, confirmText = 'Confirm', confirmType = 'danger') {
  return new Promise((resolve) => {
    const dialog = document.getElementById('customDialog');
    const dialogTitle = document.getElementById('dialogTitle');
    const dialogMessage = document.getElementById('dialogMessage');
    const dialogConfirmBtn = document.getElementById('dialogConfirmBtn');
    const dialogCancelBtn = document.getElementById('dialogCancelBtn');
    const backdrop = dialog.querySelector('.custom-dialog-backdrop');

    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    dialogConfirmBtn.textContent = confirmText;
    dialogConfirmBtn.className = `btn btn-${confirmType}`;

    dialog.style.display = 'flex';

    const handleConfirm = () => {
      dialog.style.display = 'none';
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      dialog.style.display = 'none';
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      dialogConfirmBtn.removeEventListener('click', handleConfirm);
      dialogCancelBtn.removeEventListener('click', handleCancel);
      if (backdrop) backdrop.removeEventListener('click', handleCancel);
    };

    dialogConfirmBtn.addEventListener('click', handleConfirm);
    dialogCancelBtn.addEventListener('click', handleCancel);
    if (backdrop) backdrop.addEventListener('click', handleCancel);
  });
}

// ===== Theme Management =====
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-bs-theme', theme);
  localStorage.setItem('theme', theme);

  const themeIcon = document.getElementById('themeIcon');
  const themeBtn = document.getElementById('themeToggle');
  if (themeIcon) {
    themeIcon.className = theme === 'dark' ? 'bi bi-moon-fill' : 'bi bi-sun-fill';
  }
  if (themeBtn) {
    const label = theme === 'light' ? 'Light mode' : 'Dark mode';
    themeBtn.setAttribute('title', label);
    themeBtn.setAttribute('aria-label', label);
    const themeText = themeBtn.querySelector('span');
    if (themeText) themeText.textContent = theme === 'dark' ? 'Dark' : 'Light';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(currentTheme === 'dark' ? 'light' : 'dark');
}

let _themeInitialized = false;

function initTheme() {
  if (_themeInitialized) return;
  _themeInitialized = true;

  const savedTheme = localStorage.getItem('theme') || 'dark';
  setTheme(savedTheme);

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', toggleTheme);
  }
}

// ===== Auth Check =====
async function checkAuth() {
  try {
    let response = await fetch(`${API_URL}/auth/check`, {
      method: 'GET',
      credentials: 'include',
    });

    // If access token expired, try refreshing once
    if (!response.ok) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        response = await fetch(`${API_URL}/auth/check`, {
          method: 'GET',
          credentials: 'include',
        });
      }
    }

    if (!response.ok) {
      window.location.href = '/login';
      return false;
    }
    return true;
  } catch (error) {
    window.location.href = '/login';
    return false;
  }
}

// ===== Logout Handler =====
function setupLogout() {
  const logoutBtn = document.getElementById('logoutToggle');
  if (!logoutBtn) return;

  logoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      await authFetch(`${API_URL}/auth/logout`, {
        method: 'POST',
      });
      window.location.href = '/login';
    } catch (error) {
      console.error('Logout error:', error);
      window.location.href = '/login';
    }
  });
}

// Auto-initialize theme on load
initTheme();
