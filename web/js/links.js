// Setup admin page
setupLogout();

// Build a human-readable "time left" string from a UTC expiry timestamp
function timeLeft(expiresAt) {
  const now = Math.floor(Date.now() / 1000);
  let diff = expiresAt - now;
  if (diff <= 0) return null; // already expired

  const d = Math.floor(diff / 86400); diff %= 86400;
  const h = Math.floor(diff / 3600);  diff %= 3600;
  const m = Math.floor(diff / 60);
  const s = diff % 60;

  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

// Pagination state
let linksCurrentPage = 1;
let linksPerPage = 10;

function updateLinksPagination() {
  const allItems = Array.from(document.querySelectorAll('.link-item'));
  const visibleItems = allItems.filter(item => item.getAttribute('data-filtered') !== 'true');
  const totalItems = visibleItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / linksPerPage));

  if (linksCurrentPage > totalPages) linksCurrentPage = totalPages;
  if (linksCurrentPage < 1) linksCurrentPage = 1;

  const start = (linksCurrentPage - 1) * linksPerPage;
  const end = start + linksPerPage;

  // Hide all filtered-out items
  allItems.forEach(item => {
    if (item.getAttribute('data-filtered') === 'true') {
      item.style.display = 'none';
    }
  });

  // Show/hide visible items based on pagination
  visibleItems.forEach((item, index) => {
    item.style.display = (index >= start && index < end) ? '' : 'none';
  });

  const container = document.getElementById('linksPaginationContainer');
  const info = document.getElementById('linksPaginationInfo');
  const pageIndicator = document.getElementById('linksPageIndicator');
  const prevBtn = document.getElementById('linksPrevPageBtn');
  const nextBtn = document.getElementById('linksNextPageBtn');

  if (totalItems > 0) {
    container.style.display = '';
    document.getElementById('filterEmptyState').style.display = 'none';
    const showStart = start + 1;
    const showEnd = Math.min(end, totalItems);
    info.textContent = `${showStart}-${showEnd} of ${totalItems}`;
    pageIndicator.textContent = `${linksCurrentPage} / ${totalPages}`;
    prevBtn.disabled = linksCurrentPage <= 1;
    nextBtn.disabled = linksCurrentPage >= totalPages;
  } else {
    container.style.display = 'none';
    // Show filter empty state only when there are items but none match the filter
    const hasAnyItems = allItems.length > 0;
    const filterEmpty = document.getElementById('filterEmptyState');
    if (hasAnyItems && filterEmpty) {
      filterEmpty.style.display = 'flex';
      document.getElementById('linksContainer').style.display = '';
    }
  }
}

// Load links
async function loadLinks() {
  const loading = document.getElementById('loadingIndicator');
  const container = document.getElementById('linksContainer');
  const emptyState = document.getElementById('emptyState');
  const list = document.getElementById('linksList');
  const countEl = document.getElementById('linkCount');

  loading.style.display = 'flex';
  container.style.display = 'none';
  emptyState.style.display = 'none';

  try {
    const response = await authFetch(`${API_URL}/links/list`);
    if (!response.ok) throw new Error('Failed to load links');
    
    const links = await response.json();
    
    // Sort by created_at descending (newest first)
    links.sort((a, b) => b.created_at - a.created_at);
    
    loading.style.display = 'none';
    
    if (links.length === 0) {
      countEl.textContent = '';
      emptyState.style.display = 'flex';
      const filterInput = document.getElementById('linksFilterInput');
      if (filterInput) filterInput.style.display = 'none';
      const statusFilter = document.getElementById('linksStatusFilter');
      if (statusFilter) statusFilter.style.display = 'none';
      const paginationContainer = document.getElementById('linksPaginationContainer');
      if (paginationContainer) paginationContainer.style.display = 'none';
      return;
    }

    countEl.textContent = `${links.length} link${links.length !== 1 ? 's' : ''}`;

    list.innerHTML = links.map(link => {
      const createdDate = formatDateTime(link.created_at);
      let expiresText;
      if (link.expires_at === 0) {
        expiresText = 'Never';
      } else {
        const remaining = timeLeft(link.expires_at);
        expiresText = formatDateTime(link.expires_at)
          + (remaining ? ` (${remaining})` : '');
      }
      const isExpired = link.expires_at > 0 && link.expires_at < Date.now() / 1000;
      const hasCryptex = link.cryptex_id ? true : false;
      const isUsed = hasCryptex || link.uses >= 1;
      const hasPassword = link.password ? true : false;
      const cryptexHasPassword = link.cryptex_has_password ? true : false;
      
      // Status badge
      let statusBadge;
      let statusKey;
      if (isExpired) {
        statusKey = 'expired';
        statusBadge = '<span class="link-badge link-badge-expired"><i class="bi bi-x-circle-fill"></i> Expired</span>';
      } else if (isUsed) {
        statusKey = 'used';
        statusBadge = '<span class="link-badge link-badge-used"><i class="bi bi-check-circle-fill"></i> Used</span>';
      } else {
        statusKey = 'active';
        statusBadge = '<span class="link-badge link-badge-active"><i class="bi bi-circle-fill"></i> Active</span>';
      }

      // Extra badges
      let extraBadges = '';
      if (hasCryptex) extraBadges += '<span class="link-badge link-badge-cryptex"><i class="bi bi-box-seam-fill"></i> Cryptex</span>';

      const linkUrl = `${window.location.origin}/?invite=${link.token}`;
      let cryptexUrl = hasCryptex ? `${window.location.origin}/${link.cryptex_id}` : '';
      if (hasCryptex && hasPassword && link.password) {
        cryptexUrl += `#${encodeURIComponent(link.password)}`;
      }
      
      const displayUrl = hasCryptex ? cryptexUrl : linkUrl;

      // Action buttons
      let actionButtons = '';
      actionButtons += `<button class="btn btn-secondary btn-sm api-link" data-token="${link.token}" title="API Reference"><i class="bi bi-code-slash"></i></button>`;
      actionButtons += `<button class="btn btn-secondary btn-sm qr-link" data-url="${displayUrl}" title="Show QR Code"><i class="bi bi-qr-code"></i></button>`;
      actionButtons += `<button class="btn btn-secondary btn-sm copy-link" data-url="${displayUrl}" title="Copy URL"><i class="bi bi-clipboard"></i></button>`;
      actionButtons += `<a href="${displayUrl}" class="btn btn-secondary btn-sm" target="_blank" title="Open"><i class="bi bi-box-arrow-up-right"></i></a>`;
      actionButtons += `<button class="btn btn-secondary btn-sm edit-link" data-token="${link.token}" data-label="${escapeAttr(link.label || '')}" title="Edit"><i class="bi bi-pencil"></i></button>`;
      actionButtons += `<button class="btn btn-danger btn-sm delete-link" data-token="${link.token}" data-has-cryptex="${hasCryptex}" title="Delete"><i class="bi bi-trash"></i></button>`;

      return `
        <div class="link-item" data-token="${link.token}" data-status="${statusKey}">
          <div class="link-item-top">
            <div class="link-item-left">
              <span class="link-label">${escapeAttr(link.label || 'Untitled')}</span>
              <div class="link-badges">
                ${statusBadge}
                ${extraBadges}
              </div>
            </div>
            <div class="link-item-actions">
              ${actionButtons}
            </div>
          </div>
          <div class="link-meta">
            <span class="link-meta-item"><i class="bi bi-calendar3"></i> Created ${createdDate}</span>
            <span class="link-meta-item"><i class="bi bi-hourglass-split"></i> Expires ${expiresText}</span>
            ${hasCryptex ? `<span class="link-meta-item"><i class="bi bi-box-seam"></i> ${link.cryptex_id}</span>` : ''}
          </div>
          <div class="link-url-row">
            <input type="text" class="form-control" value="${displayUrl}" readonly />
          </div>
        </div>
      `;
    }).join('');

    container.style.display = 'block';

    // Show filter inputs and preserve current values
    const filterInput = document.getElementById('linksFilterInput');
    if (filterInput) {
      filterInput.style.display = '';
    }
    const statusFilter = document.getElementById('linksStatusFilter');
    if (statusFilter) {
      statusFilter.style.display = '';
    }

    // Re-apply current filters and setup pagination
    linksCurrentPage = 1;
    applyLinksFilters();

    // Add copy button handlers
    document.querySelectorAll('.copy-link').forEach(btn => {
      btn.addEventListener('click', async () => {
        const url = btn.getAttribute('data-url');
        try {
          await navigator.clipboard.writeText(url);
          const icon = btn.querySelector('i');
          icon.className = 'bi bi-check-lg';
          setTimeout(() => { icon.className = 'bi bi-clipboard'; }, 1500);
          showToast('URL copied to clipboard', 'success', 1200);
        } catch (error) {
          console.error('Copy failed:', error);
          showToast('Failed to copy URL', 'warning');
        }
      });
    });

    // Add QR button handlers
    document.querySelectorAll('.qr-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-url');
        showQRDialog(url);
      });
    });

    // Add API button handlers
    document.querySelectorAll('.api-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const token = btn.getAttribute('data-token');
        showLinkApiDialog(token);
      });
    });

    // Add edit button handlers
    document.querySelectorAll('.edit-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const token = btn.getAttribute('data-token');
        const currentLabel = btn.getAttribute('data-label');
        showEditDialog(token, currentLabel);
      });
    });

    // Add delete button handlers
    document.querySelectorAll('.delete-link').forEach(btn => {
      btn.addEventListener('click', async () => {
        const token = btn.getAttribute('data-token');
        const hasCryptex = btn.getAttribute('data-has-cryptex') === 'true';
        showDeleteDialog(token, hasCryptex);
      });
    });

  } catch (error) {
    loading.style.display = 'none';
    emptyState.style.display = 'flex';
    emptyState.innerHTML = `
      <i class="bi bi-exclamation-triangle empty-state-icon" style="color: var(--text-primary);"></i>
      <p class="empty-state-title">Failed to load links</p>
      <p class="empty-state-desc">Check your connection and try again</p>
    `;
    console.error('Load links error:', error);
  }
}

// Link API Dialog
const linkApiDialog = document.getElementById('linkApiDialog');

function showLinkApiDialog(token) {
  const baseUrl = window.location.origin;
    const snippet = `curl -X POST ${baseUrl}/api/create \\\n  -F "invite=${token}" \\\n  -F "text=Secret message" \\\n  -F "file=@/path/to/file.pdf"`;
  document.getElementById('linkApiSnippetDialog').textContent = snippet;
  linkApiDialog.style.display = 'flex';

  const copyBtn = document.getElementById('linkApiCopyBtn');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(snippet).then(() => {
      copyBtn.innerHTML = '<i class="bi bi-check"></i>';
      setTimeout(() => { copyBtn.innerHTML = '<i class="bi bi-clipboard"></i>'; }, 1500);
    });
  };
}

document.getElementById('linkApiDialogCloseBtn').addEventListener('click', () => {
  linkApiDialog.style.display = 'none';
});
linkApiDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  linkApiDialog.style.display = 'none';
});

// Create Link Dialog
const createLinkDialog = document.getElementById('createLinkDialog');
const createLinkBtn = document.getElementById('createLinkBtn');
const createLinkCancelBtn = document.getElementById('createLinkCancelBtn');
const createLinkConfirmBtn = document.getElementById('createLinkConfirmBtn');

// Create link dialog handlers

createLinkBtn.addEventListener('click', () => {
  // Reset to form view
  document.getElementById('createLinkForm').style.display = '';
  document.getElementById('linkCreatedView').style.display = 'none';
  createLinkConfirmBtn.style.display = '';
  createLinkCancelBtn.textContent = 'Cancel';
  createLinkDialog.style.display = 'flex';
  document.getElementById('linkLabel').focus();
});

createLinkCancelBtn.addEventListener('click', () => {
  createLinkDialog.style.display = 'none';
});

createLinkDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  createLinkDialog.style.display = 'none';
});

// Prevent form submission on Enter and trigger create instead
document.getElementById('createLinkForm').addEventListener('submit', (e) => {
  e.preventDefault();
  createLinkConfirmBtn.click();
});

// Create link
createLinkConfirmBtn.addEventListener('click', async () => {
  
  const label = document.getElementById('linkLabel').value.trim();
  const expires = parseInt(document.getElementById('linkExpires').value);

  try {
    const response = await authFetch(`${API_URL}/links/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        label, 
        expires_in: expires
      })
    });

    if (!response.ok) throw new Error('Failed to create link');

    const linkData = await response.json();
    const linkUrl = `${window.location.origin}/?invite=${linkData.token}`;

    // Switch to created view
    document.getElementById('createLinkForm').style.display = 'none';
    document.getElementById('linkCreatedView').style.display = '';
    document.getElementById('createdLinkUrl').value = linkUrl;
    createLinkConfirmBtn.style.display = 'none';
    createLinkCancelBtn.textContent = 'Close';

    // Copy URL button
    document.getElementById('copyCreatedLinkBtn').onclick = () => {
      navigator.clipboard.writeText(linkUrl);
      showToast('URL copied to clipboard', 'success', 1200);
    };

    // Reset form
    document.getElementById('linkLabel').value = '';
    document.getElementById('linkExpires').value = '604800';

    showToast('Link created successfully', 'success');

    // Reload links in background
    await loadLinks();
  } catch (error) {
    console.error('Create link error:', error);
    showToast('Failed to create link', 'error');
  }
});

// Edit Link Dialog
const editLinkDialog = document.getElementById('editLinkDialog');
const editLinkCancelBtn = document.getElementById('editLinkCancelBtn');
const editLinkConfirmBtn = document.getElementById('editLinkConfirmBtn');
const editLinkLabel = document.getElementById('editLinkLabel');
let currentEditToken = null;

function showEditDialog(token, currentLabel) {
  currentEditToken = token;
  editLinkLabel.value = currentLabel;
  editLinkDialog.style.display = 'flex';
  editLinkLabel.focus();
}

editLinkCancelBtn.addEventListener('click', () => {
  editLinkDialog.style.display = 'none';
  currentEditToken = null;
});

editLinkDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  editLinkDialog.style.display = 'none';
  currentEditToken = null;
});

editLinkConfirmBtn.addEventListener('click', async () => {
  if (!currentEditToken) return;
  
  const newLabel = editLinkLabel.value.trim();
  
  try {
    const response = await authFetch(`${API_URL}/links/update/${currentEditToken}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel })
    });

    if (!response.ok) throw new Error('Failed to update link');

    // Close dialog
    editLinkDialog.style.display = 'none';
    currentEditToken = null;

    // Show success toast
    showToast('Link updated successfully', 'success');

    // Reload links
    await loadLinks();
  } catch (error) {
    console.error('Update link error:', error);
    showToast('Failed to update link', 'error');
  }
});

// Delete Link Dialog
const deleteLinkDialog = document.getElementById('deleteLinkDialog');
const deleteLinkCancelBtn = document.getElementById('deleteLinkCancelBtn');
const deleteLinkConfirmBtn = document.getElementById('deleteLinkConfirmBtn');
const deleteDialogMessage = document.getElementById('deleteDialogMessage');
const deleteDataOption = document.getElementById('deleteDataOption');
const deleteCryptexData = document.getElementById('deleteCryptexData');
let deleteTargetToken = null;

function showDeleteDialog(token, hasCryptex) {
  deleteTargetToken = token;
  deleteCryptexData.checked = false;
  
  if (hasCryptex) {
    deleteDialogMessage.textContent = 'Are you sure you want to delete this link?';
    deleteDataOption.style.display = '';
  } else {
    deleteDialogMessage.textContent = 'Are you sure you want to delete this link?';
    deleteDataOption.style.display = 'none';
  }
  
  deleteLinkDialog.style.display = 'flex';
}

deleteLinkCancelBtn.addEventListener('click', () => {
  deleteLinkDialog.style.display = 'none';
  deleteTargetToken = null;
});

deleteLinkDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  deleteLinkDialog.style.display = 'none';
  deleteTargetToken = null;
});

deleteLinkConfirmBtn.addEventListener('click', async () => {
  if (!deleteTargetToken) return;
  const deleteData = deleteCryptexData.checked;
  const token = deleteTargetToken;
  
  deleteLinkDialog.style.display = 'none';
  deleteTargetToken = null;
  
  await deleteLink(token, deleteData);
});

// Delete link
async function deleteLink(token, deleteData = false) {
  try {
    const response = await authFetch(`${API_URL}/links/delete/${token}?delete_data=${deleteData}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete link');
    showToast('Link deleted successfully', 'success');
    await loadLinks();
  } catch (error) {
    console.error('Delete link error:', error);
    showToast('Failed to delete link', 'error');
  }
}

// Refresh button
document.getElementById('refreshLinksBtn').addEventListener('click', loadLinks);

// Pagination controls
document.getElementById('linksPrevPageBtn').addEventListener('click', () => {
  if (linksCurrentPage > 1) {
    linksCurrentPage--;
    updateLinksPagination();
  }
});

document.getElementById('linksNextPageBtn').addEventListener('click', () => {
  linksCurrentPage++;
  updateLinksPagination();
});

document.getElementById('linksPerPageSelect').addEventListener('change', (e) => {
  linksPerPage = parseInt(e.target.value);
  linksCurrentPage = 1;
  updateLinksPagination();
});

// QR Code Dialog
const qrDialog = document.getElementById('qrDialog');
const qrDialogCloseBtn = document.getElementById('qrDialogCloseBtn');

function showQRDialog(url) {
  const canvas = document.getElementById('qrCanvas');
  
  // Generate QR code using qrcode-generator
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  canvas.innerHTML = qr.createImgTag(5, 0);
  qrDialog.style.display = 'flex';
}

qrDialogCloseBtn.addEventListener('click', () => {
  qrDialog.style.display = 'none';
});

qrDialog.querySelector('.custom-dialog-backdrop').addEventListener('click', () => {
  qrDialog.style.display = 'none';
});

// Initialize: set up filter listener once, then check auth and load links
let linksFilterInitialized = false;

function applyLinksFilters() {
  const filterInput = document.getElementById('linksFilterInput');
  const statusFilter = document.getElementById('linksStatusFilter');
  const query = filterInput ? filterInput.value.toLowerCase() : '';
  const status = statusFilter ? statusFilter.value : 'all';

  document.querySelectorAll('.link-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    const urlInput = item.querySelector('.link-url-row input');
    const url = urlInput ? urlInput.value.toLowerCase() : '';
    const matchesText = !query || text.includes(query) || url.includes(query);
    const matchesStatus = status === 'all' || item.getAttribute('data-status') === status;
    item.setAttribute('data-filtered', (matchesText && matchesStatus) ? 'false' : 'true');
  });
  linksCurrentPage = 1;
  updateLinksPagination();
}

function setupLinksFilter() {
  if (linksFilterInitialized) return;
  linksFilterInitialized = true;
  
  document.getElementById('linksFilterInput')?.addEventListener('input', applyLinksFilters);
  document.getElementById('linksStatusFilter')?.addEventListener('change', applyLinksFilters);
}

// Initialize
function init() {
  checkAuth().then((authenticated) => {
    if (authenticated) {
      const loader = document.getElementById('initialLoader');
      if (loader) loader.remove();
      const pageContent = document.getElementById('pageContent');
      if (pageContent) pageContent.style.display = '';
      setupLinksFilter();
      loadLinks();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
