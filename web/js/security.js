// Setup admin page
setupLogout();

// DOM Elements
const twoFactorStatus = document.getElementById('twoFactorStatus');
const twoFactorSetup = document.getElementById('twoFactorSetup');
const twoFactorActions = document.getElementById('twoFactorActions');
const enable2FABtn = document.getElementById('enable2FABtn');
const disable2FABtn = document.getElementById('disable2FABtn');
const qrCodeContainer = document.getElementById('qrCodeContainer');
const secretKeyInput = document.getElementById('secretKey');
const copySecretBtn = document.getElementById('copySecretBtn');
const verificationCode = document.getElementById('verificationCode');
const verifyCodeBtn = document.getElementById('verifyCodeBtn');
const cancelSetupBtn = document.getElementById('cancelSetupBtn');
const statusText = document.getElementById('statusText');
const statusIcon = document.getElementById('statusIcon');
const changePasswordBtn = document.getElementById('changePasswordBtn');

let currentTwoFactorEnabled = false;

// Load current security settings
async function loadSecuritySettings() {
  try {
    const response = await authFetch(`${API_URL}/admin/security`);
    if (response.ok) {
      const data = await response.json();
      currentTwoFactorEnabled = data.two_factor_enabled || false;
      updateTwoFactorUI();
    }
  } catch (error) {
    console.error('Error loading security settings:', error);
  }
}

// Update 2FA UI based on status
function updateTwoFactorUI() {
  const banner = twoFactorStatus.querySelector('.twofa-banner');
  
  if (currentTwoFactorEnabled) {
    statusText.innerHTML = 'Two-Factor Authentication is Enabled';
    statusIcon.innerHTML = '<i class="bi bi-shield-check"></i>';
    statusIcon.className = 'twofa-banner-icon status-enabled';
    banner.className = 'twofa-banner status-enabled';
    enable2FABtn.style.display = 'none';
    disable2FABtn.style.display = 'inline-flex';
    twoFactorSetup.style.display = 'none';
  } else {
    statusText.innerHTML = 'Two-Factor Authentication is Disabled';
    statusIcon.innerHTML = '<i class="bi bi-shield-x"></i>';
    statusIcon.className = 'twofa-banner-icon status-disabled';
    banner.className = 'twofa-banner status-disabled';
    enable2FABtn.style.display = 'inline-flex';
    disable2FABtn.style.display = 'none';
    twoFactorSetup.style.display = 'none';
  }
}

// Enable 2FA - Start setup
enable2FABtn.addEventListener('click', async () => {
  try {
    const response = await authFetch(`${API_URL}/admin/security/2fa/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      const data = await response.json();
      
      // Display QR code
      qrCodeContainer.innerHTML = `<img src="${data.qr_code}" alt="QR Code">`;
      
      // Display secret key
      secretKeyInput.value = data.secret;
      
      // Show setup UI
      twoFactorSetup.style.display = 'block';
      enable2FABtn.style.display = 'none';
      verificationCode.value = '';
      verificationCode.focus();
    } else {
      const error = await response.json();
      showToast(error.detail || 'Failed to setup 2FA', 'error');
    }
  } catch (error) {
    showToast('Error setting up 2FA', 'error');
  }
});

// Copy secret key
copySecretBtn.addEventListener('click', () => {
  secretKeyInput.select();
  navigator.clipboard.writeText(secretKeyInput.value);
    showToast('Secret key copied to clipboard', 'success');
});

// Verify and enable 2FA
verifyCodeBtn.addEventListener('click', async () => {
  const code = verificationCode.value.trim();
  
  if (code.length !== 6 || !/^\d{6}$/.test(code)) {
    showToast('Please enter a valid 6-digit code', 'error');
    return;
  }

  try {
    const response = await authFetch(`${API_URL}/admin/security/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totp_code: code })
    });

    if (response.ok) {
      showToast('2FA enabled successfully!', 'success');
      currentTwoFactorEnabled = true;
      updateTwoFactorUI();
    } else {
      const error = await response.json();
      showToast(error.detail || 'Invalid verification code', 'error');
    }
  } catch (error) {
    showToast('Error verifying code', 'error');
  }
});

// Cancel setup
cancelSetupBtn.addEventListener('click', () => {
  twoFactorSetup.style.display = 'none';
  updateTwoFactorUI();
  verificationCode.value = '';
});

// Disable 2FA
disable2FABtn.addEventListener('click', async () => {
  const confirmed = await showDialog(
    'Disable Two-Factor Authentication?',
    'Are you sure you want to disable two-factor authentication? This will make your account less secure.'
  );
  
  if (!confirmed) {
    return;
  }

  try {
    const response = await authFetch(`${API_URL}/admin/security/2fa/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      showToast('2FA disabled successfully', 'success');
      currentTwoFactorEnabled = false;
      updateTwoFactorUI();
    } else {
      const error = await response.json();
      showToast(error.detail || 'Failed to disable 2FA', 'error');
    }
  } catch (error) {
    showToast('Error disabling 2FA', 'error');
  }
});

// Change Password
changePasswordBtn.addEventListener('click', async () => {
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (!newPassword || !confirmPassword) {
    showToast('Please fill all password fields', 'error');
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  try {
    const response = await authFetch(`${API_URL}/admin/security/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_password: newPassword })
    });

    if (response.ok) {
      showToast('Password changed successfully!', 'success');
      document.getElementById('newPassword').value = '';
      document.getElementById('confirmPassword').value = '';
    } else {
      const error = await response.json();
      showToast(error.detail || 'Failed to change password', 'error');
    }
  } catch (error) {
    showToast('Error changing password', 'error');
  }
});

// Allow Enter key to verify code
verificationCode.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    verifyCodeBtn.click();
  }
});

// Allow Enter key in password fields to trigger change password
document.getElementById('newPassword').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    changePasswordBtn.click();
  }
});

document.getElementById('confirmPassword').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    changePasswordBtn.click();
  }
});

// Load settings on page load
checkAuth().then(authenticated => {
  if (authenticated) {
    const loader = document.getElementById('initialLoader');
    if (loader) loader.remove();
    const pageContent = document.getElementById('pageContent');
    if (pageContent) pageContent.style.display = '';
    loadSecuritySettings();
    loadApiKeys();
  }
});

// ===== API Keys Management =====
const apiKeysList = document.getElementById('apiKeysList');
const apiKeysEmpty = document.getElementById('apiKeysEmpty');
const apiKeyCount = document.getElementById('apiKeyCount');
const createApiKeyBtn = document.getElementById('createApiKeyBtn');


// Dialog elements
const createApiKeyDialog = document.getElementById('createApiKeyDialog');
const apiKeyFormView = document.getElementById('apiKeyFormView');
const apiKeyCreatedView = document.getElementById('apiKeyCreatedView');
const apiKeyNameInput = document.getElementById('apiKeyName');
const apiKeyDescriptionInput = document.getElementById('apiKeyDescription');
const apiKeyDialogCancelBtn = document.getElementById('apiKeyDialogCancelBtn');
const apiKeyDialogCreateBtn = document.getElementById('apiKeyDialogCreateBtn');
const newKeyValue = document.getElementById('newKeyValue');
const copyApiKeyBtn = document.getElementById('copyApiKeyBtn');

const apiKeysFilterInput = document.getElementById('apiKeysFilterInput');

async function loadApiKeys() {
  try {
    const response = await authFetch(`${API_URL}/admin/security/api-keys`);
    if (!response.ok) throw new Error('Failed to load API keys');
    const data = await response.json();
    const keys = data.keys || [];
    renderApiKeys(keys);
    apiKeyCount.textContent = keys.length === 1 ? '1 key' : `${keys.length} keys`;
    apiKeysFilterInput.style.display = keys.length > 0 ? '' : 'none';
  } catch (error) {
    console.error('Error loading API keys:', error);
  }
}

function renderApiKeys(keys) {
  apiKeysList.innerHTML = '';
  if (keys.length === 0) {
    apiKeysEmpty.style.display = '';
    return;
  }
  apiKeysEmpty.style.display = 'none';

  keys.forEach(key => {
    const item = document.createElement('div');
    item.className = 'api-key-item';
    const lastUsed = key.last_used ? formatRelativeTime(key.last_used) : 'Never';
    const createdDate = formatDateTime(key.created);
    const createdAgo = formatRelativeTime(key.created);
    const description = key.description ? `<div class="api-key-description">${escapeHtml(key.description)}</div>` : '';
    item.innerHTML = `
      <div class="api-key-info">
        <div class="api-key-name">${escapeHtml(key.name)}</div>
        ${description}
        <div class="api-key-meta"><i class="bi bi-calendar3"></i> Created ${createdDate} (${createdAgo})</div>
        <div class="api-key-meta"><i class="bi bi-clock"></i> Last used: ${lastUsed}</div>
      </div>
      <button class="btn btn-sm btn-danger api-key-revoke" data-id="${key.id}" title="Revoke">
        <i class="bi bi-trash"></i>
      </button>
    `;
    item.querySelector('.api-key-revoke').addEventListener('click', () => revokeApiKey(key.id, key.name));
    apiKeysList.appendChild(item);
  });
}

// Filter API keys by name
apiKeysFilterInput.addEventListener('input', () => {
  const filter = apiKeysFilterInput.value.toLowerCase();
  const items = apiKeysList.querySelectorAll('.api-key-item');
  items.forEach(item => {
    const name = item.querySelector('.api-key-name').textContent.toLowerCase();
    item.style.display = name.includes(filter) ? '' : 'none';
  });
});



// Open create dialog
createApiKeyBtn.addEventListener('click', () => {
  apiKeyNameInput.value = '';
  apiKeyDescriptionInput.value = '';
  apiKeyFormView.style.display = '';
  apiKeyCreatedView.style.display = 'none';
  apiKeyDialogCreateBtn.style.display = '';
  apiKeyDialogCancelBtn.textContent = 'Cancel';
  createApiKeyDialog.style.display = '';
  apiKeyNameInput.focus();
});

// Close dialog
let apiKeyDialogLocked = false;

apiKeyDialogCancelBtn.addEventListener('click', () => {
  apiKeyDialogLocked = false;
  createApiKeyDialog.style.display = 'none';
});
createApiKeyDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  if (!apiKeyDialogLocked) {
    createApiKeyDialog.style.display = 'none';
  }
});

// Create key
apiKeyDialogCreateBtn.addEventListener('click', async () => {
  const name = apiKeyNameInput.value.trim();
  const description = apiKeyDescriptionInput.value.trim();
  if (!name) {
    showToast('Please enter a name for the API key', 'error');
    apiKeyNameInput.focus();
    return;
  }

  try {
    const response = await authFetch(`${API_URL}/admin/security/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });

    if (!response.ok) {
      const error = await response.json();
      showToast(error.detail || 'Failed to create API key', 'error');
      return;
    }

    const data = await response.json();

    // Switch dialog to show the created key
    apiKeyFormView.style.display = 'none';
    apiKeyCreatedView.style.display = '';
    newKeyValue.value = data.key;
    apiKeyDialogCreateBtn.style.display = 'none';
    apiKeyDialogCancelBtn.textContent = 'Close';
    apiKeyDialogLocked = true;

    // Reload the list
    await loadApiKeys();
    showToast('API key created successfully', 'success');
  } catch (error) {
    showToast('Error creating API key', 'error');
  }
});

// Copy key
copyApiKeyBtn.addEventListener('click', () => {
  newKeyValue.select();
  navigator.clipboard.writeText(newKeyValue.value);
  showToast('API key copied to clipboard', 'success');
});

// Enter key support in dialog
apiKeyNameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') apiKeyDialogCreateBtn.click();
});

apiKeyDescriptionInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') apiKeyDialogCreateBtn.click();
});

async function revokeApiKey(id, name) {
  const confirmed = await showDialog(
    'Revoke API Key?',
    `Are you sure you want to revoke the API key "${name}"? This action cannot be undone.`
  );
  if (!confirmed) return;

  try {
    const response = await authFetch(`${API_URL}/admin/security/api-keys/${id}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      showToast('API key revoked', 'success');
      await loadApiKeys();
    } else {
      const error = await response.json();
      showToast(error.detail || 'Failed to revoke API key', 'error');
    }
  } catch (error) {
    showToast('Error revoking API key', 'error');
  }
}

function formatRelativeTime(timestamp) {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}