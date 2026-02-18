// Setup admin page
setupLogout();

// Load data
async function loadAdminData() {
  const loadingIndicator = document.getElementById('loadingIndicator');
  const tableContainer = document.getElementById('tableContainer');
  const emptyState = document.getElementById('emptyState');
  
  loadingIndicator.style.display = 'flex';
  tableContainer.style.display = 'none';
  emptyState.style.display = 'none';
  
  // Reset toolbar count and filter
  const itemCount = document.getElementById('itemCount');
  const filterInput = document.getElementById('filterInput');
  if (itemCount) itemCount.textContent = '';
  if (filterInput) filterInput.style.display = 'none';
  
  try {
    const response = await authFetch(`${API_URL}/monitor/stats`, {
      method: 'GET',
    });
    
    if (!response.ok) {
      throw new Error('Failed to load admin data');
    }
    
    const data = await response.json();
    
    // Update stats
    document.getElementById('totalItems').textContent = data.total_items;
    document.getElementById('textOnly').textContent = data.text_only;
    document.getElementById('filesOnly').textContent = data.files_only;
    document.getElementById('textWithFiles').textContent = data.text_with_files;
    document.getElementById('totalSize').textContent = formatBytes(data.total_size);
    
    // Update disk usage if available
    if (data.disk_total) {
      document.getElementById('diskFree').textContent = formatBytes(data.disk_free);
    }    
    // Update table
    const tbody = document.getElementById('itemsTableBody');
    tbody.innerHTML = '';
    
    // Update item count in toolbar
    if (itemCount) {
      const count = data.items.length;
      itemCount.textContent = `${count} item${count !== 1 ? 's' : ''}`;
    }
    
    if (data.items.length === 0) {
      loadingIndicator.style.display = 'none';
      tableContainer.style.display = 'none';
      emptyState.style.display = 'flex';
    } else {
      data.items.forEach(item => {
        const row = document.createElement('tr');
        
        // Determine type label and badge
        let typeLabel, typeBadge;
        if (item.has_text && item.has_files) {
          typeLabel = 'Text + Files';
          typeBadge = 'link-badge-cryptex';
        } else if (item.has_text) {
          typeLabel = 'Text Only';
          typeBadge = 'link-badge-encrypted';
        } else if (item.has_files) {
          typeLabel = 'Files Only';
          typeBadge = 'link-badge-amber';
        } else {
          typeLabel = 'Empty';
          typeBadge = 'link-badge-inactive';
        }
        
        const passwordBadge = item.encrypted ? 
          '<span class="link-badge link-badge-active"><i class="bi bi-lock-fill"></i> Yes</span>' : 
          '<span class="link-badge link-badge-inactive"><i class="bi bi-unlock-fill"></i> No</span>';
        
        const autodestroyBadge = item.autodestroy ? 
          '<span class="link-badge link-badge-rose"><i class="bi bi-fire"></i> Yes</span>' : 
          '<span class="link-badge link-badge-inactive"><i class="bi bi-x"></i> No</span>';
        
        // Add data attributes for sorting
        row.setAttribute('data-created', new Date(item.created).getTime());
        row.setAttribute('data-expires', item.expires_in);
        
        row.innerHTML = `
          <td><code>${item.id}</code></td>
          <td><span class="link-badge ${typeBadge}">${typeLabel}</span></td>
          <td>${passwordBadge}</td>
          <td>${autodestroyBadge}</td>
          <td>${item.file_count}</td>
          <td>${formatBytes(item.total_size)}</td>
          <td>${formatDate(item.created)}</td>
          <td>${formatTimeRemaining(item.expires_in)}</td>
          <td>${item.views || 0}</td>
          <td>
            <div class="action-btns">
              <a href="/${item.id}" class="btn btn-sm btn-primary open-btn" target="_blank" title="Open Cryptex">
                <i class="bi bi-box-arrow-up-right"></i>
              </a>
              <button class="btn btn-sm btn-danger delete-btn" data-id="${item.id}">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </td>
        `;
        
        tbody.appendChild(row);
      });
      
      // Add delete handlers
      document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const cryptexId = e.currentTarget.getAttribute('data-id');
          const confirmed = await showDialog(
            'Delete Cryptex',
            `Are you sure you want to delete cryptex ${cryptexId}?`,
            'Delete',
            'danger'
          );
          
          if (confirmed) {
            try {
              const response = await authFetch(`${API_URL}/monitor/delete/${cryptexId}`, {
                method: 'DELETE',
              });
              
              if (response.ok) {
                showToast('Cryptex deleted successfully', 'success');
                await loadAdminData();
              } else {
                await showDialog('Error', 'Failed to delete cryptex', 'OK', 'danger');
              }
            } catch (error) {
              console.error('Error deleting cryptex:', error);
              await showDialog('Error', 'Error deleting cryptex', 'OK', 'danger');
            }
          }
        });
      });
      
      loadingIndicator.style.display = 'none';
      tableContainer.style.display = 'block';
      emptyState.style.display = 'none';
      
      // Show filter input when there are items
      const filterInput = document.getElementById('filterInput');
      if (filterInput) filterInput.style.display = '';
      
      // Setup filter
      setupFilter();
      
      // Setup sorting
      setupSorting();
      
      // Setup pagination
      currentPage = 1;
      updatePagination();
    }
  } catch (error) {
    console.error('Error loading admin data:', error);
    loadingIndicator.innerHTML = `
      <i class="bi bi-exclamation-triangle text-danger" style="font-size: 3rem;"></i>
      <p class="mt-3 text-danger">Error loading data</p>
    `;
  }
}

// Filter functionality
function setupFilter() {
  const filterInput = document.getElementById('filterInput');
  
  filterInput.addEventListener('input', (e) => {
    const filterValue = e.target.value.toLowerCase();
    const tbody = document.getElementById('itemsTableBody');
    const rows = tbody.querySelectorAll('tr');
    
    rows.forEach(row => {
      const text = row.textContent.toLowerCase();
      const matches = text.includes(filterValue);
      row.setAttribute('data-filtered', matches ? 'false' : 'true');
    });
    
    currentPage = 1;
    updatePagination();
  });
}

// Sorting functionality
let currentSort = { column: null, direction: 'asc' };
let sortingInitialized = false;

// Pagination state
let currentPage = 1;
let perPage = 10;

function getVisibleRows() {
  const tbody = document.getElementById('itemsTableBody');
  return Array.from(tbody.querySelectorAll('tr')).filter(row => row.getAttribute('data-filtered') !== 'true');
}

function updatePagination() {
  const rows = getVisibleRows();
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / perPage));
  
  // Clamp current page
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  
  const start = (currentPage - 1) * perPage;
  const end = start + perPage;
  
  // Show/hide rows
  rows.forEach((row, index) => {
    row.style.display = (index >= start && index < end) ? '' : 'none';
  });
  
  // Update controls
  const paginationContainer = document.getElementById('paginationContainer');
  const paginationInfo = document.getElementById('paginationInfo');
  const pageIndicator = document.getElementById('pageIndicator');
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');
  
  if (totalRows > 0) {
    paginationContainer.style.display = '';
    const showStart = start + 1;
    const showEnd = Math.min(end, totalRows);
    paginationInfo.textContent = `${showStart}-${showEnd} of ${totalRows}`;
    pageIndicator.textContent = `${currentPage} / ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  } else {
    paginationContainer.style.display = 'none';
  }
}

function setupSorting() {
  if (sortingInitialized) return;
  sortingInitialized = true;
  
  const headers = document.querySelectorAll('.sortable');
  
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const column = header.getAttribute('data-column');
      
      // Toggle direction if clicking same column
      if (currentSort.column === column) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.column = column;
        currentSort.direction = 'asc';
      }
      
      // Update header styles
      headers.forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      header.classList.add(`sort-${currentSort.direction}`);
      
      // Sort the table
      sortTable(column, currentSort.direction);
    });
  });
}

function sortTable(column, direction) {
  const tbody = document.getElementById('itemsTableBody');
  const rows = Array.from(tbody.querySelectorAll('tr'));
  
  rows.sort((a, b) => {
    let aValue, bValue;
    
    // Get values based on column
    switch(column) {
      case 'cryptex_id':
        aValue = a.cells[0].textContent;
        bValue = b.cells[0].textContent;
        break;
      case 'type':
        aValue = a.cells[1].textContent;
        bValue = b.cells[1].textContent;
        break;
      case 'encrypted':
        aValue = a.cells[2].textContent;
        bValue = b.cells[2].textContent;
        break;
      case 'autodestroy':
        aValue = a.cells[3].textContent;
        bValue = b.cells[3].textContent;
        break;
      case 'file_count':
        aValue = parseInt(a.cells[4].textContent) || 0;
        bValue = parseInt(b.cells[4].textContent) || 0;
        break;
      case 'total_size':
        aValue = parseSize(a.cells[5].textContent);
        bValue = parseSize(b.cells[5].textContent);
        break;
      case 'created':
        aValue = a.getAttribute('data-created') || 0;
        bValue = b.getAttribute('data-created') || 0;
        break;
      case 'expires_in':
        aValue = parseInt(a.getAttribute('data-expires')) || 0;
        bValue = parseInt(b.getAttribute('data-expires')) || 0;
        break;
      case 'views':
        aValue = parseInt(a.cells[8].textContent) || 0;
        bValue = parseInt(b.cells[8].textContent) || 0;
        break;
      default:
        aValue = a.cells[0].textContent;
        bValue = b.cells[0].textContent;
    }
    
    // Compare values
    let comparison = 0;
    if (typeof aValue === 'string' && typeof bValue === 'string') {
      comparison = aValue.localeCompare(bValue);
    } else {
      comparison = aValue - bValue;
    }
    
    return direction === 'asc' ? comparison : -comparison;
  });
  
  // Re-append rows in sorted order
  rows.forEach(row => tbody.appendChild(row));
  
  // Re-apply pagination after sorting
  updatePagination();
}

// Parse size strings like "1.5 MB" to bytes for comparison
function parseSize(sizeStr) {
  const units = { 'B': 1, 'KB': 1024, 'MB': 1024*1024, 'GB': 1024*1024*1024 };
  const match = sizeStr.match(/^([\d.]+)\s*([A-Z]+)$/);
  if (!match) return 0;
  return parseFloat(match[1]) * (units[match[2]] || 1);
}

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', loadAdminData);

// Pagination controls
document.getElementById('prevPageBtn').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage--;
    updatePagination();
  }
});

document.getElementById('nextPageBtn').addEventListener('click', () => {
  currentPage++;
  updatePagination();
});

document.getElementById('perPageSelect').addEventListener('change', (e) => {
  perPage = parseInt(e.target.value);
  currentPage = 1;
  updatePagination();
});

// Delete all button
document.getElementById('deleteAllBtn').addEventListener('click', async () => {
  const confirmed1 = await showDialog(
    'Delete All Cryptex Items',
    'Are you sure you want to delete ALL cryptex items? This action cannot be undone!',
    'Continue',
    'danger'
  );
  
  if (confirmed1) {
    const confirmed2 = await showDialog(
      'Final Confirmation',
      'This will permanently delete all cryptex items and their files. Are you absolutely sure?',
      'Delete All',
      'danger'
    );
    
    if (confirmed2) {
      try {
        const response = await authFetch(`${API_URL}/monitor/delete-all`, {
          method: 'DELETE',
        });
        
        if (response.ok) {
          showToast('All cryptex items deleted successfully', 'success');
          await loadAdminData();
        } else {
          await showDialog('Error', 'Failed to delete all items', 'OK', 'danger');
        }
      } catch (error) {
        console.error('Error deleting all items:', error);
        await showDialog('Error', 'Error deleting all items', 'OK', 'danger');
      }
    }
  }
});

// Utility functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatTimeRemaining(seconds) {
  if (seconds <= 0) return 'Expired';
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.join(' ') || '< 1m';
}

// Initialize
(async function() {
  const authenticated = await checkAuth();
  if (authenticated) {
    const loader = document.getElementById('initialLoader');
    if (loader) loader.remove();
    const pageContent = document.getElementById('pageContent');
    if (pageContent) pageContent.style.display = '';
    await loadAdminData();
  }
})();
