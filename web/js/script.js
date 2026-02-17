let MAX_MESSAGE_LENGTH = 1000;
let MAX_FILES = 5;
let MAX_FILE_SIZE = 100 * 1024 * 1024;
let MAX_EXPIRATION = 86400;

const CRYPTEX_ID_PATTERN = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const MULTIPART_CHUNK_SIZE = 10 * 1024 * 1024;

let selectedFiles = [];
let uploadAbortController = null;
let countdownInterval = null;
let currentCryptexId = null;
let currentCryptexPassword = '';

const mainCard = document.getElementById('mainCard');
const linkBanner = document.getElementById('linkBanner');

const step1 = document.getElementById('step1');
const step2 = document.getElementById('step2');
const step3 = document.getElementById('step3');
const step4 = document.getElementById('step4');

const encMessage = document.getElementById('encMessage');
const encMessageCount = document.getElementById('encMessageCount');
const encFiles = document.getElementById('encFiles');
const encFilesInfo = document.getElementById('encFilesInfo');
const encFilesLimit = document.getElementById('encFilesLimit');
const encFilesList = document.getElementById('encFilesList');
const encPwd = document.getElementById('encPwd');
const encBtn = document.getElementById('encBtn');

const encStatus = document.getElementById('encStatus');
const encProgress = document.getElementById('encProgress');
const encProgressText = document.getElementById('encProgressText');
const encProgressSubtext = document.getElementById('encProgressSubtext');
const encProgressBar = document.getElementById('encProgressBar');
const encProgressPercent = document.getElementById('encProgressPercent');
const encProgressSize = document.getElementById('encProgressSize');
const encProgressFile = document.getElementById('encProgressFile');
const encCancelBtn = document.getElementById('encCancelBtn');
const encLog = document.getElementById('encLog');

const decId = document.getElementById('decId');
const decPwd = document.getElementById('decPwd');
const decBtn = document.getElementById('decBtn');
const decPwdGroup = document.getElementById('decPwdGroup');

const openedMessage = document.getElementById('openedMessage');
const openedFilesList = document.getElementById('openedFilesList');
const openedExpiration = document.getElementById('openedExpiration');
const openedViews = document.getElementById('openedViews');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const destroyBtn = document.getElementById('destroyBtn');

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseExpirationToSeconds(expiration) {
  if (!expiration) return 0;
  const parts = String(expiration).match(/(\d+)\s*(days?|hours?|minutes?|seconds?)/gi) || [];
  let total = 0;
  for (const part of parts) {
    const value = parseInt(part, 10);
    if (part.includes('day')) total += value * 86400;
    else if (part.includes('hour')) total += value * 3600;
    else if (part.includes('minute')) total += value * 60;
    else if (part.includes('second')) total += value;
  }
  return total;
}

function formatCountdown(seconds) {
  if (seconds <= 0) return 'Expired';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function startCountdown(expirationTimeMs) {
  if (countdownInterval) clearInterval(countdownInterval);
  const tick = () => {
    const remaining = Math.floor((expirationTimeMs - Date.now()) / 1000);
    if (remaining <= 0) {
      openedExpiration.textContent = 'Expired';
      clearInterval(countdownInterval);
      countdownInterval = null;
      return;
    }
    openedExpiration.textContent = `Expires in ${formatCountdown(remaining)}`;
  };
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function startCountdownForElement(element, expirationTimeMs) {
  const tick = () => {
    const remaining = Math.floor((expirationTimeMs - Date.now()) / 1000);
    if (remaining <= 0) {
      element.textContent = 'Expired';
      clearInterval(interval);
      return;
    }
    element.textContent = `Expires in ${formatCountdown(remaining)}`;
  };
  const interval = setInterval(tick, 1000);
  tick();
}

function showStep(step) {
  step1.classList.toggle('active', step === 1);
  step2.classList.toggle('active', step === 2);
  step3.classList.toggle('active', step === 3);
  step4.classList.toggle('active', step === 4);
}

function setCreateProcessing(isProcessing) {
  mainCard.classList.toggle('processing', isProcessing);
  encBtn.disabled = isProcessing;
  encMessage.readOnly = isProcessing;
  encPwd.readOnly = isProcessing;
  encFiles.disabled = isProcessing;
}

function setUploadProgress({ title, subtitle, percent, size, detail }) {
  encStatus.style.display = 'block';
  encProgress.style.display = 'block';
  encLog.style.display = 'none';
  if (title !== undefined) encProgressText.textContent = title;
  if (subtitle !== undefined) encProgressSubtext.innerHTML = subtitle;
  if (percent !== undefined) {
    const safePct = Math.max(0, Math.min(100, percent));
    encProgressBar.style.width = `${safePct}%`;
    encProgressPercent.textContent = `${Math.round(safePct)}%`;
  }
  if (size !== undefined) encProgressSize.textContent = size;
  if (detail !== undefined) encProgressFile.textContent = detail;
}

function setupPasswordToggle(inputId, buttonId, iconId) {
  const input = document.getElementById(inputId);
  const button = document.getElementById(buttonId);
  const icon = document.getElementById(iconId);
  if (!input || !button || !icon) return;

  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    icon.classList.toggle('bi-eye-fill', !show);
    icon.classList.toggle('bi-eye-slash-fill', show);
  });
}

function updateFilesList() {
  encFilesList.innerHTML = '';

  if (!selectedFiles.length) {
    encFilesInfo.style.display = 'none';
    return;
  }

  encFilesInfo.style.display = '';
  encFilesInfo.textContent = `${selectedFiles.length} / ${MAX_FILES} files`;

  selectedFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <div class="file-info">
        <i class="bi bi-file-earmark"></i>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-size">${formatFileSize(file.size)}</div>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="btn-file-action remove" title="Remove">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
    `;
    item.querySelector('.btn-file-action.remove').addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      updateFilesList();
    });
    encFilesList.appendChild(item);
  });
}

function addFilesToSelection(files) {
  for (const file of files) {
    if (selectedFiles.length >= MAX_FILES) {
      showToast(`Maximum ${MAX_FILES} files allowed`, 'error');
      break;
    }
    if (file.size > MAX_FILE_SIZE) {
      showToast(`File "${file.name}" exceeds ${formatFileSize(MAX_FILE_SIZE)} limit`, 'error');
      continue;
    }
    const duplicate = selectedFiles.some((f) => f.name === file.name && f.size === file.size);
    if (duplicate) continue;
    selectedFiles.push(file);
  }
  updateFilesList();
}

function setupDragAndDrop(fileInput) {
  const card = fileInput.closest('.card');
  if (!card) return;

  const preventDefaults = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((name) => {
    card.addEventListener(name, preventDefaults, false);
  });

  ['dragenter', 'dragover'].forEach((name) => {
    card.addEventListener(name, () => {
      card.classList.add('drag-over');
      fileInput.classList.add('drag-over');
    }, false);
  });

  ['dragleave', 'drop'].forEach((name) => {
    card.addEventListener(name, () => {
      card.classList.remove('drag-over');
      fileInput.classList.remove('drag-over');
    }, false);
  });

  card.addEventListener('drop', (e) => {
    addFilesToSelection(Array.from(e.dataTransfer.files || []));
  }, false);
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  if (res.status === 429) {
    throw new Error('Too many requests. Please wait a moment and try again.');
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const message = typeof payload?.detail === 'string'
      ? payload.detail
      : (payload?.detail?.message || `Request failed (${res.status})`);
    throw new Error(message);
  }
  return payload;
}

function getRetentionSeconds() {
  const value = parseInt(document.getElementById('encExpirationValue').value, 10);
  const unit = document.getElementById('encExpirationUnit').value;
  if (!value || value < 1) throw new Error('Expiration value must be at least 1');

  if (unit === 'minutes') return value * 60;
  if (unit === 'hours') return value * 3600;
  return value * 86400;
}

async function uploadFileMultipart(cryptexId, file, uploadIndex, totalFiles, signal, bytesBefore, totalBytes) {
  setUploadProgress({
    title: totalFiles > 1 ? `Uploading file ${uploadIndex + 1} of ${totalFiles}` : 'Uploading file',
    subtitle: `<i class="bi bi-file-earmark file-icon"></i><span class="file-name">${escapeHtml(file.name)}</span><span class="file-size-badge">${formatFileSize(file.size)}</span>`,
    percent: totalBytes > 0 ? (bytesBefore / totalBytes) * 100 : 0,
    size: `0 / ${formatFileSize(file.size)}`,
    detail: 'Preparing multipart upload...'
  });

  const started = await requestJson(
    `${API_URL}/create/file/start?cryptex_id=${encodeURIComponent(cryptexId)}&filename=${encodeURIComponent(file.name)}`,
    { method: 'POST', signal }
  );
  const uploadId = started.upload_id;

  try {
    const totalChunks = Math.max(1, Math.ceil(file.size / MULTIPART_CHUNK_SIZE));
    let uploadedBytes = 0;

    for (let part = 0; part < totalChunks; part++) {
      if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');

      const from = part * MULTIPART_CHUNK_SIZE;
      const to = Math.min(from + MULTIPART_CHUNK_SIZE, file.size);
      const chunk = file.slice(from, to);

      const response = await fetch(
        `${API_URL}/create/file/part?cryptex_id=${encodeURIComponent(cryptexId)}&upload_id=${encodeURIComponent(uploadId)}&part=${part}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal,
        }
      );

      if (!response.ok) {
        let err = null;
        try { err = await response.json(); } catch {}
        throw new Error(typeof err?.detail === 'string' ? err.detail : `Failed to upload part ${part + 1}`);
      }

      uploadedBytes += (to - from);
      const filePct = (uploadedBytes / file.size) * 100;
      const overallPct = totalBytes > 0 ? ((bytesBefore + uploadedBytes) / totalBytes) * 100 : filePct;

      setUploadProgress({
        title: totalFiles > 1 ? `Uploading file ${uploadIndex + 1} of ${totalFiles}` : 'Uploading file',
        subtitle: `<i class="bi bi-file-earmark file-icon"></i><span class="file-name">${escapeHtml(file.name)}</span><span class="file-size-badge">${formatFileSize(file.size)}</span>`,
        percent: overallPct,
        size: `${formatFileSize(uploadedBytes)} / ${formatFileSize(file.size)}`,
        detail: `Part ${part + 1} / ${totalChunks} (${Math.round(filePct)}%)`
      });
    }

    await requestJson(
      `${API_URL}/create/file/complete?cryptex_id=${encodeURIComponent(cryptexId)}&upload_id=${encodeURIComponent(uploadId)}`,
      { method: 'POST', signal }
    );
  } catch (error) {
    try {
      await fetch(
        `${API_URL}/create/file/abort?cryptex_id=${encodeURIComponent(cryptexId)}&upload_id=${encodeURIComponent(uploadId)}`,
        { method: 'POST' }
      );
    } catch {}
    throw error;
  }
}

function generateShareUrl(cryptexId, password = '') {
  const base = `${window.location.origin}/${cryptexId}`;
  if (!password) return base;
  return `${base}#${encodeURIComponent(password)}`;
}

function generateQrPreview(url) {
  const qrPreview = document.getElementById('qrPreview');
  if (!window.qrcode || !qrPreview) {
    if (qrPreview) qrPreview.style.display = 'none';
    return;
  }

  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();

  const imageContainer = qrPreview.querySelector('.qr-preview-image');
  if (imageContainer) {
    imageContainer.innerHTML = qr.createImgTag(4, 2);
  }
  qrPreview.style.display = 'flex';

  const container = qrPreview.querySelector('.qr-preview-container');
  (container || qrPreview).onclick = () => {
    const dialog = document.getElementById('qrDialog');
    const body = document.getElementById('qrDialogBody');
    if (!dialog || !body) return;
    body.innerHTML = qr.createImgTag(8, 16);
    dialog.style.display = 'flex';
  };
}

function renderCreateSuccess(data, password) {
  const cryptexUrlInput = document.getElementById('cryptexUrl');
  const cryptexUrlExpiration = document.getElementById('cryptexUrlExpiration');
  const includePasswordCheckbox = document.getElementById('includePasswordInUrl');
  const passwordField = document.getElementById('passwordField');
  const passwordSection = document.getElementById('passwordSection');
  const cryptexPassword = document.getElementById('cryptexPassword');

  const baseUrl = generateShareUrl(data.id);
  const urlWithPassword = generateShareUrl(data.id, password);
  const hasPassword = !!password;

  cryptexUrlInput.value = baseUrl;
  includePasswordCheckbox.checked = false;
  includePasswordCheckbox.style.display = hasPassword ? '' : 'none';

  passwordField.style.display = hasPassword ? '' : 'none';
  passwordSection.style.display = hasPassword ? '' : 'none';
  cryptexPassword.value = password || '';

  includePasswordCheckbox.onchange = () => {
    cryptexUrlInput.value = includePasswordCheckbox.checked ? urlWithPassword : baseUrl;
    generateQrPreview(cryptexUrlInput.value);
  };

  generateQrPreview(baseUrl);

  const expSeconds = parseExpirationToSeconds(data.expiration);
  if (expSeconds > 0) {
    startCountdownForElement(cryptexUrlExpiration, Date.now() + expSeconds * 1000);
  } else {
    cryptexUrlExpiration.textContent = data.expiration || '';
  }
}

async function createCryptex() {
  const text = encMessage.value.trim();
  const password = encPwd.value;
  const hasFiles = selectedFiles.length > 0;

  if (!text && !hasFiles) {
    showToast('Please provide either text or files', 'error');
    return;
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    showToast(`Text cannot be greater than ${MAX_MESSAGE_LENGTH} characters`, 'error');
    return;
  }
  if (password.length > 100) {
    showToast('Password cannot be greater than 100 characters', 'error');
    return;
  }
  if (selectedFiles.length > MAX_FILES) {
    showToast(`Maximum ${MAX_FILES} files allowed`, 'error');
    return;
  }

  let retention = 0;
  try {
    retention = getRetentionSeconds();
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  if (retention > MAX_EXPIRATION) {
    showToast('Expiration exceeds configured limit', 'error');
    return;
  }
  if (retention < 60) {
    showToast('Expiration must be at least 1 minute', 'error');
    return;
  }

  setCreateProcessing(true);
  uploadAbortController = new AbortController();
  encCancelBtn.onclick = () => uploadAbortController?.abort();

  try {
    setUploadProgress({
      title: 'Creating Cryptex',
      subtitle: hasFiles ? 'Preparing metadata...' : 'Saving content...',
      percent: 0,
      size: '',
      detail: ''
    });

    const formData = new FormData();
    formData.append('text', text);
    formData.append('password', password);
    formData.append('retention', String(retention));
    formData.append('autodestroy', document.getElementById('autodestroy').checked ? 'true' : 'false');
    formData.append('has_pending_files', hasFiles ? 'true' : 'false');

    const linkToken = new URLSearchParams(window.location.search).get('invite');
    if (linkToken) formData.append('invite', linkToken);

    const response = await fetch(`${API_URL}/create`, {
      method: 'POST',
      body: formData,
      signal: uploadAbortController.signal,
    });

    if (response.status === 429) {
      throw new Error('Too many requests. Please wait a moment and try again.');
    }

    const created = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = typeof created?.detail === 'string'
        ? created.detail
        : (created?.detail?.message || 'Failed to create cryptex');
      throw new Error(msg);
    }

    if (linkToken) {
      setUploadProgress({ title: 'Success', subtitle: 'Cryptex created', percent: 100, detail: '' });
      showToast('Cryptex created successfully', 'success');
      showStep(1);
      encMessage.value = '';
      selectedFiles = [];
      updateFilesList();
      return;
    }

    if (!created.id) throw new Error('Server did not return cryptex ID');

    if (hasFiles) {
      const totalBytes = selectedFiles.reduce((sum, f) => sum + f.size, 0);
      let bytesBefore = 0;
      for (let i = 0; i < selectedFiles.length; i++) {
        await uploadFileMultipart(created.id, selectedFiles[i], i, selectedFiles.length, uploadAbortController.signal, bytesBefore, totalBytes);
        bytesBefore += selectedFiles[i].size;
      }
    }

    setUploadProgress({
      title: 'Success',
      subtitle: 'Your cryptex is ready',
      percent: 100,
      size: '',
      detail: ''
    });

    renderCreateSuccess(created, password);
    showStep(3);
    window.history.replaceState({}, '', `/${created.id}`);
    showToast('Cryptex created successfully', 'success');

    encMessage.value = '';
    encPwd.value = '';
    encMessageCount.textContent = `0 / ${MAX_MESSAGE_LENGTH}`;
    selectedFiles = [];
    updateFilesList();
  } catch (error) {
    if (error.name === 'AbortError') {
      showToast('Upload cancelled', 'warning');
    } else {
      showToast(error.message || 'Failed to create cryptex', 'error');
    }
    encProgress.style.display = 'none';
  } finally {
    setCreateProcessing(false);
    uploadAbortController = null;
  }
}

async function openCryptex({ silent = false } = {}) {
  const id = decId.value.trim();
  const password = decPwd.value;

  if (!id) {
    showToast('Please enter a cryptex ID', 'error');
    return;
  }

  decBtn.disabled = true;
  try {
    const data = await requestJson(`${API_URL}/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        password,
      }),
    });

    currentCryptexId = id;
    currentCryptexPassword = password;

    openedMessage.textContent = data.text || '(No text message)';
    openedMessage.style.fontStyle = data.text ? 'normal' : 'italic';
    openedMessage.style.color = data.text ? '' : 'var(--text-muted)';

    const expSeconds = parseExpirationToSeconds(data.expiration);
    if (expSeconds > 0) startCountdown(Date.now() + expSeconds * 1000);
    else openedExpiration.textContent = data.expiration || '';

    const views = data.views || 0;
    openedViews.innerHTML = `<i class="bi bi-eye"></i> Viewed ${views} ${views === 1 ? 'time' : 'times'}`;

    renderFilesForDownload(id, data.files || [], password);

    if (data.autodestroy) {
      sessionStorage.setItem('autodestroyCryptexId', id);
      sessionStorage.setItem('autodestroyCryptexPassword', password || '');
      if (destroyBtn) destroyBtn.style.display = 'none';
      document.getElementById('autoDestroyBanner').style.display = '';
    } else if (destroyBtn) {
      destroyBtn.style.display = '';
      document.getElementById('autoDestroyBanner').style.display = 'none';
    }

    showStep(4);
    showToast('Cryptex opened successfully', 'success');
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('password required')) {
      decPwdGroup.style.display = '';
      decPwd.focus();
      if (!silent) showToast('Password required', 'error');
    } else {
      showToast(error.message || 'Failed to open cryptex', 'error');
    }
  } finally {
    decBtn.disabled = false;
  }
}

function triggerDownloadUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function startFileDownload(cryptexId, filename, password, button) {
  if (button) button.disabled = true;
  const originalHtml = button?.innerHTML || '';
  if (button) button.innerHTML = '<i class="bi bi-hourglass-split"></i>';

  try {
    const data = await requestJson(`${API_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cryptex_id: cryptexId,
        filename,
        password,
      }),
    });

    if (!data?.token) throw new Error('No download token received');
    triggerDownloadUrl(`${API_URL}/download/${encodeURIComponent(data.token)}`, filename);

    if (button) {
      button.innerHTML = '<i class="bi bi-check-circle-fill"></i>';
      setTimeout(() => {
        button.innerHTML = originalHtml;
        button.disabled = false;
      }, 1200);
    }
  } catch (error) {
    showToast(error.message || 'File download failed', 'error');
    if (button) {
      button.innerHTML = originalHtml;
      button.disabled = false;
    }
  }
}

function renderFilesForDownload(cryptexId, files, password) {
  openedFilesList.innerHTML = '<label class="form-label">Attachments</label>';

  if (!files.length) {
    openedFilesList.style.display = 'none';
    downloadAllBtn.style.display = 'none';
    return;
  }

  openedFilesList.style.display = '';
  for (const file of files) {
    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.innerHTML = `
      <div class="file-info">
        <i class="bi bi-file-earmark"></i>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.filename)}</div>
          <div class="file-size">${formatFileSize(file.size)}</div>
        </div>
      </div>
      <div class="file-actions">
        <button class="btn-file-action download" title="Download">
          <i class="bi bi-arrow-down"></i>
        </button>
      </div>
    `;

    const btn = fileItem.querySelector('.btn-file-action.download');
    btn.onclick = () => startFileDownload(cryptexId, file.filename, password, btn);
    openedFilesList.appendChild(fileItem);
  }

  if (files.length > 1) {
    downloadAllBtn.style.display = '';
    downloadAllBtn.onclick = async () => {
      downloadAllBtn.disabled = true;
      try {
        for (const file of files) {
          const tokenRes = await requestJson(`${API_URL}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cryptex_id: cryptexId,
              filename: file.filename,
              password,
            }),
          });
          triggerDownloadUrl(`${API_URL}/download/${encodeURIComponent(tokenRes.token)}`, file.filename);
          await new Promise((resolve) => setTimeout(resolve, 120));
        }
      } catch (error) {
        showToast(error.message || 'Failed to download all files', 'error');
      } finally {
        downloadAllBtn.disabled = false;
      }
    };
  } else {
    downloadAllBtn.style.display = 'none';
  }
}

async function destroyCryptex(id, password) {
  const confirmed = await showDialog(
    'Destroy Cryptex',
    'Are you sure you want to permanently destroy this cryptex? This action cannot be undone.',
    'Destroy',
    'danger'
  );
  if (!confirmed) return;

  if (destroyBtn) destroyBtn.disabled = true;
  mainCard.classList.add('processing');
  try {
    await requestJson(`${API_URL}/destroy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, password }),
    });
    showToast('Cryptex destroyed successfully', 'success');
    sessionStorage.removeItem('autodestroyCryptexId');
    sessionStorage.removeItem('autodestroyCryptexPassword');
    window.location.href = '/';
  } catch (error) {
    showToast(error.message || 'Failed to destroy cryptex', 'error');
  } finally {
    if (destroyBtn) destroyBtn.disabled = false;
    mainCard.classList.remove('processing');
  }
}

async function isAuthenticated() {
  try {
    const response = await fetch(`${API_URL}/auth/check`, {
      method: 'GET',
      credentials: 'include'
    });
    return response.ok;
  } catch {
    return false;
  }
}

function showBannerPage({ icon, iconClass, title, description, btnHref, btnIcon, btnLabel }) {
  mainCard.style.display = 'none';
  linkBanner.className = 'status-page';
  linkBanner.innerHTML = `
    <div class="status-page-icon ${iconClass}"><i class="bi ${icon}"></i></div>
    <h2 class="status-page-title" style="margin-bottom: 0.75rem;">${title}</h2>
    <p class="status-page-desc">${description}</p>
    <a href="${btnHref}" class="btn btn-primary status-page-btn" style="margin-top: 0.5rem;">
      <i class="bi ${btnIcon}"></i> ${btnLabel}
    </a>
  `;
  linkBanner.style.display = '';
}

async function checkLinkToken() {
  const linkToken = new URLSearchParams(window.location.search).get('invite');

  try {
    const root = await requestJson(`${API_URL}/`, { method: 'GET' });
    if (root?.config?.mode === 'private' && !linkToken) {
      const authed = await isAuthenticated();
      if (!authed) {
        showBannerPage({
          icon: 'bi-shield-lock-fill',
          iconClass: 'status-icon-blue',
          title: 'Private Mode',
          description: 'This Cryptex instance is in private mode.',
          btnHref: '/login?redirect=/',
          btnIcon: 'bi-box-arrow-in-right',
          btnLabel: 'Login'
        });
      }
      return;
    }
  } catch {
    return;
  }

  if (!linkToken) return;

  try {
    const result = await requestJson(`${API_URL}/links/check/${encodeURIComponent(linkToken)}`, { method: 'GET' });
    if (result.valid) {
      const passwordSection = document.querySelector('.password-section');
      const advancedOptionsWrapper = document.querySelector('.advanced-options-wrapper');
      if (result.has_password && result.password) encPwd.value = result.password;
      if (passwordSection) passwordSection.style.display = 'none';
      if (advancedOptionsWrapper) advancedOptionsWrapper.style.display = 'none';
      if (encBtn) encBtn.style.marginTop = '12px';
      return;
    }

    showBannerPage({
      icon: 'bi-x-circle-fill',
      iconClass: 'status-icon-red',
      title: 'Link Invalid',
      description: 'This link is no longer valid.',
      btnHref: '/',
      btnIcon: 'bi-house-door',
      btnLabel: 'Go to Homepage'
    });
  } catch {
    showBannerPage({
      icon: 'bi-exclamation-triangle-fill',
      iconClass: 'status-icon-red',
      title: 'Unable to Verify Link',
      description: 'There was an error verifying your link. Please try again later.',
      btnHref: '/',
      btnIcon: 'bi-arrow-clockwise',
      btnLabel: 'Try Again'
    });
  }
}

async function loadLimits() {
  try {
    const data = await requestJson(`${API_URL}/`, { method: 'GET' });
    document.getElementById('appVersion').textContent = `v${data.version}`;
    MAX_MESSAGE_LENGTH = data.config.max_message_length;
    MAX_FILES = data.config.max_file_count;
    MAX_FILE_SIZE = data.config.max_file_size;
    MAX_EXPIRATION = data.config.max_expiration;

    encMessageCount.textContent = `0 / ${MAX_MESSAGE_LENGTH}`;
    encFilesLimit.textContent = `(max ${MAX_FILES} files)`;
  } catch {
    // keep defaults
  }
}

async function updateAuthButtons() {
  const logoutBtn = document.getElementById('logoutToggle');
  const adminBtn = document.getElementById('adminToggle');
  const loginBtn = document.getElementById('loginToggle');
  if (!logoutBtn) return;

  const authed = await isAuthenticated();
  logoutBtn.style.display = authed ? 'flex' : 'none';
  if (adminBtn) adminBtn.style.display = authed ? 'flex' : 'none';
  if (loginBtn) loginBtn.style.display = authed ? 'none' : 'flex';

  if (authed) {
    logoutBtn.onclick = async (e) => {
      e.preventDefault();
      try {
        await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
      } catch {}
      window.location.href = '/login';
    };
  }
}

function initUi() {
  showStep(1);

  setupPasswordToggle('encPwd', 'encPwdToggle', 'encPwdToggleIcon');
  setupPasswordToggle('decPwd', 'decPwdToggle', 'decPwdToggleIcon');
  setupPasswordToggle('cryptexPassword', 'cryptexPwdToggle', 'cryptexPwdToggleIcon');

  const generatePwdBtn = document.getElementById('generatePwdBtn');
  generatePwdBtn.addEventListener('click', () => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    encPwd.value = btoa(String.fromCharCode(...bytes));
    encPwd.type = 'text';
  });

  const advancedToggle = document.getElementById('advancedToggle');
  const advancedOptions = document.getElementById('advancedOptions');
  advancedToggle.addEventListener('click', () => {
    const expanded = advancedToggle.getAttribute('aria-expanded') === 'true';
    advancedToggle.setAttribute('aria-expanded', String(!expanded));
    advancedOptions.classList.toggle('expanded');
  });

  encMessage.addEventListener('input', () => {
    if (encMessage.value.length > MAX_MESSAGE_LENGTH) {
      encMessage.value = encMessage.value.slice(0, MAX_MESSAGE_LENGTH);
    }
    encMessageCount.textContent = `${encMessage.value.length} / ${MAX_MESSAGE_LENGTH}`;
  });

  encFiles.addEventListener('change', () => {
    addFilesToSelection(Array.from(encFiles.files || []));
    encFiles.value = '';
  });

  setupDragAndDrop(encFiles);

  // Position tooltips dynamically for elements inside overflow:hidden containers
  document.querySelectorAll('[data-tooltip]').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--tooltip-top', `${rect.top - 8}px`);
      el.style.setProperty('--tooltip-left', `${rect.left + rect.width / 2}px`);
    });
  });

  encBtn.onclick = createCryptex;
  encPwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createCryptex(); } });
  decBtn.onclick = openCryptex;
  decPwd.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openCryptex(); } });
  if (destroyBtn) {
    destroyBtn.onclick = () => {
      if (currentCryptexId) {
        destroyCryptex(currentCryptexId, currentCryptexPassword);
      }
    };
  }

  document.getElementById('openCryptexBtn').onclick = () => {
    const id = (document.getElementById('cryptexUrl').value.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/) || [])[1];
    if (!id) return;
    decId.value = id;
    decPwd.value = '';
    decPwdGroup.style.display = 'none';
    showStep(2);
    openCryptex({ silent: true });
  };

  document.getElementById('copyUrlBtn').onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById('cryptexUrl').value || '');
    showToast('URL copied', 'success');
  };

  document.getElementById('copyPwdBtn').onclick = async () => {
    await navigator.clipboard.writeText(document.getElementById('cryptexPassword').value || '');
    showToast('Password copied', 'success');
  };

  document.getElementById('copyMessageBtn').onclick = async () => {
    await navigator.clipboard.writeText(openedMessage.textContent || '');
    showToast('Message copied', 'success');
  };

  const qrDialog = document.getElementById('qrDialog');
  const qrDialogBackdrop = qrDialog?.querySelector('.qr-dialog-backdrop');
  const qrDialogCloseBtn = document.getElementById('qrDialogCloseBtn');
  if (qrDialogBackdrop) qrDialogBackdrop.onclick = () => { qrDialog.style.display = 'none'; };
  if (qrDialogCloseBtn) qrDialogCloseBtn.onclick = () => { qrDialog.style.display = 'none'; };
}

function autoFillFromUrl() {
  const path = window.location.pathname.replace(/^\//, '');
  const hashPassword = decodeURIComponent((window.location.hash || '').replace(/^#/, ''));

  if (CRYPTEX_ID_PATTERN.test(path)) {
    decId.value = path;
    if (hashPassword) decPwd.value = hashPassword;
    showStep(2);
    openCryptex({ silent: true });
  }
}

window.addEventListener('beforeunload', (e) => {
  const cryptexId = sessionStorage.getItem('autodestroyCryptexId');
  if (cryptexId) {
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});

window.addEventListener('pagehide', () => {
  const cryptexId = sessionStorage.getItem('autodestroyCryptexId');
  const password = sessionStorage.getItem('autodestroyCryptexPassword') || '';
  if (!cryptexId) return;

  const payload = JSON.stringify({ id: cryptexId, password });
  fetch(`${API_URL}/destroy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true,
  }).catch(() => {
    navigator.sendBeacon(`${API_URL}/destroy`, new Blob([payload], { type: 'application/json' }));
  });

  sessionStorage.removeItem('autodestroyCryptexId');
  sessionStorage.removeItem('autodestroyCryptexPassword');
});

document.addEventListener('DOMContentLoaded', async () => {
  initUi();
  await Promise.all([loadLimits(), updateAuthButtons()]);
  await checkLinkToken();
  autoFillFromUrl();
});
