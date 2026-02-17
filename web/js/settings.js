// Setup admin page
setupLogout();

// ===== Helper: Parse value+unit string =====
function parseValueUnit(str, unitMap) {
  str = (str || '').trim().toLowerCase();
  // Try to match number + unit suffix
  for (const unit of Object.keys(unitMap)) {
    if (str.endsWith(unit)) {
      const num = str.slice(0, -unit.length).trim();
      if (num && !isNaN(num)) return { value: parseFloat(num), unit };
    }
  }
  // Fallback: treat as raw number with default unit
  if (!isNaN(str) && str !== '') {
    const defaultUnit = Object.keys(unitMap)[0];
    return { value: parseFloat(str), unit: defaultUnit };
  }
  return null;
}

function setFileSizeFields(rawValue) {
  const parsed = parseValueUnit(rawValue, { gb: 1, mb: 1, kb: 1, b: 1 });
  if (parsed) {
    document.getElementById('maxFileSizeNumber').value = parsed.value;
    document.getElementById('maxFileSizeUnit').value = parsed.unit;
  }
}

function getFileSizeValue() {
  const num = document.getElementById('maxFileSizeNumber').value;
  const unit = document.getElementById('maxFileSizeUnit').value;
  return `${num}${unit}`;
}

function setExpirationFields(rawValue) {
  const parsed = parseValueUnit(rawValue, { d: 1, h: 1, m: 1 });
  if (parsed) {
    document.getElementById('maxExpirationNumber').value = parsed.value;
    document.getElementById('maxExpirationUnit').value = parsed.unit;
  }
}

function getExpirationValue() {
  const num = document.getElementById('maxExpirationNumber').value;
  const unit = document.getElementById('maxExpirationUnit').value;
  return `${num}${unit}`;
}

// ===== Load Settings =====
async function loadSettings() {
  try {
    const response = await authFetch(`${API_URL}/admin/settings`, {
      method: 'GET',
    });
    
    if (!response.ok) {
      throw new Error('Failed to load settings');
    }
    
    const settings = await response.json();
    
    // Populate form
    const modeRadio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (modeRadio) {
      modeRadio.checked = true;
    }
    document.getElementById('maxMessageLength').value = settings.max_message_length;
    document.getElementById('maxFileCount').value = settings.max_file_count;

    // Set file size and expiration fields
    setFileSizeFields(settings.max_file_size);
    setExpirationFields(settings.max_expiration);
  } catch (error) {
    console.error('Error loading settings:', error);
    await showDialog('Error', 'Failed to load settings', 'OK', 'danger');
  }
}

// ===== Save Settings =====
document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const settings = {
    mode: document.querySelector('input[name="mode"]:checked')?.value || 'public',
    max_message_length: parseInt(document.getElementById('maxMessageLength').value),
    max_file_count: parseInt(document.getElementById('maxFileCount').value),
    max_file_size: getFileSizeValue(),
    max_expiration: getExpirationValue()
  };
  
  try {
    const response = await authFetch(`${API_URL}/admin/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(settings),
    });
    
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(result.detail || 'Failed to save settings');
    }
    
    showToast(result.message, 'success');
    
  } catch (error) {
    console.error('Error saving settings:', error);
    showToast(error.message, 'error');
  }
});

// Initialize
checkAuth().then(() => {
  loadSettings();
});
