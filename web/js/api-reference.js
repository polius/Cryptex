// API Reference Dialog — reusable across all pages
(function () {
  // Build and inject the dialog HTML
  const dialogHTML = `
  <div id="apiReferenceDialog" class="custom-dialog" style="display: none;">
    <div class="custom-dialog-backdrop"></div>
    <div class="custom-dialog-content custom-dialog-wide">
      <div class="custom-dialog-header">
        <i class="bi bi-code-slash" style="color: #3b82f6; -webkit-text-fill-color: #3b82f6;"></i>
        <h3>API Reference</h3>
      </div>
      <div class="custom-dialog-body api-usage-body">

        <!-- Overview -->
        <div class="api-overview">
          <div class="api-overview-item">
            <i class="bi bi-globe2"></i>
            <div>
              <strong>Public API</strong>
              <span>No authentication required. Available when Cryptex is in public mode.</span>
            </div>
          </div>
          <div class="api-overview-item">
            <i class="bi bi-lock-fill"></i>
            <div>
              <strong>Private API</strong>
              <span>Requires an <code>X-API-Key</code> header. Works in both public and private mode.</span>
              <span style="display:block; margin-top:0.25rem; font-size:0.8125rem;">API keys can be created in Admin &gt; Security</span>
            </div>
          </div>
        </div>

        <!-- Endpoints Table -->
        <div class="api-ref-table-wrap">
          <table class="api-ref-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Endpoint</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span class="api-method">POST</span></td>
                <td class="api-endpoint-cell">/api/create</td>
                <td>Create a new Cryptex</td>
              </tr>
              <tr>
                <td><span class="api-method">POST</span></td>
                <td class="api-endpoint-cell">/api/open</td>
                <td>Open and read a Cryptex</td>
              </tr>
              <tr>
                <td><span class="api-method">POST</span></td>
                <td class="api-endpoint-cell">/api/download</td>
                <td>Generate a presigned file download URL</td>
              </tr>
              <tr>
                <td><span class="api-method">GET</span></td>
                <td class="api-endpoint-cell">/api/download/{token}</td>
                <td>Download file (presigned URL)</td>
              </tr>
              <tr>
                <td><span class="api-method">POST</span></td>
                <td class="api-endpoint-cell">/api/destroy</td>
                <td>Permanently destroy a Cryptex</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Create -->
        <h5 class="api-section-title">Create</h5>
        <div class="api-usage-section">
          <div class="api-section-header">
            <span class="api-method">POST</span>
            <span class="api-endpoint">/api/create</span>
          </div>
          <p class="api-desc">Create a new Cryptex with text and/or files.</p>
          <div class="api-label">Request</div>
          <div class="api-code-block">
            <button class="btn btn-sm api-copy-btn" title="Copy"><i class="bi bi-clipboard"></i></button>
            <pre><code>curl -X POST <span class="api-url-placeholder">URL</span>/api/create \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -F "text=Secret message" \\
  -F "password=mypassword" \\        # optional
  -F "retention=1d" \\               # optional (default: 1d)
  -F "autodestroy=false" \\          # optional (default: false)
  -F "file=@/path/to/file1.pdf" \\
  -F "file=@/path/to/file2.zip"</code></pre>
          </div>
          <div class="form-hint mt-1">The <code>X-API-Key</code> header is only required when Cryptex is in private mode. Either <code>text</code> or <code>file</code> is required. <code>password</code>, <code>retention</code>, and <code>autodestroy</code> are optional. Use <code>retention</code> with formats like <code>30m</code>, <code>24h</code>, <code>7d</code>.</div>
          <div class="api-label">Response</div>
          <div class="api-code-block">
            <pre><code>{
  "message": "Cryptex created successfully",
  "id": "abc-defg-hij",
  "expiration": "1d",
  "has_password": true,
  "autodestroy": false,
  "files": 2,
  "total_size": 1253376
}</code></pre>
          </div>
        </div>

        <!-- Open -->
        <h5 class="api-section-title">Open</h5>
        <div class="api-usage-section">
          <div class="api-section-header">
            <span class="api-method">POST</span>
            <span class="api-endpoint">/api/open</span>
          </div>
          <p class="api-desc">Open and read a Cryptex.</p>
          <div class="api-label">Request</div>
          <div class="api-code-block">
            <button class="btn btn-sm api-copy-btn" title="Copy"><i class="bi bi-clipboard"></i></button>
            <pre><code>curl -X POST <span class="api-url-placeholder">URL</span>/api/open \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{"id": "abc-defg-hij", "password": "mypassword"}'</code></pre>
          </div>
          <div class="form-hint mt-1">The <code>X-API-Key</code> header is only required when Cryptex is in private mode.</div>
          <div class="api-label">Response</div>
          <div class="api-code-block">
            <pre><code>{
  "text": "Secret message",
  "expiration": "23h 45m",
  "files": [
    { "filename": "file1.pdf", "size": 204800 },
    { "filename": "file2.zip", "size": 1048576 }
  ],
  "autodestroy": false,
  "views": 1
}</code></pre>
          </div>
          <div class="form-hint mt-1">To download files, use the <code>/api/download</code> endpoint to generate a presigned URL for each file.</div>
        </div>

        <!-- Download -->
        <h5 class="api-section-title">Download</h5>
        <div class="api-usage-section">
          <div class="api-section-header">
            <span class="api-method">POST</span>
            <span class="api-endpoint">/api/download</span>
          </div>
          <p class="api-desc">Generate a short-lived presigned URL for file download, similar to AWS S3 presigned URLs. Requires the cryptex password.</p>
          <div class="api-label">Request</div>
          <div class="api-code-block">
            <button class="btn btn-sm api-copy-btn" title="Copy"><i class="bi bi-clipboard"></i></button>
            <pre><code>curl -X POST <span class="api-url-placeholder">URL</span>/api/download \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{"cryptex_id": "abc-defg-hij", "filename": "file1.pdf", "password": "mypassword"}'</code></pre>
          </div>
          <div class="form-hint mt-1">The token is single-use and expires after 60 seconds. For autodestroy cryptexes, each file can only be downloaded once.</div>
          <div class="api-label">Response</div>
          <div class="api-code-block">
            <pre><code>{
  "message": "Download URL generated",
  "token": "x7Kp2mNvQwRtY9sLdFgHjBcXzA4E6uI1oP3aS5fVkW8nMqJrTyUeZiOlCbDhGx",
  "url": "<span class="api-url-placeholder">URL</span>/api/download/x7Kp2mNvQwRtY9sLdFgHjBcXzA4E6uI1oP3aS5fVkW8nMqJrTyUeZiOlCbDhGx",
  "filename": "file1.pdf",
  "size": 204800,
  "expires_in": 60
}</code></pre>
          </div>
          <div class="api-label">Download file</div>
          <div class="api-code-block">
            <button class="btn btn-sm api-copy-btn" title="Copy"><i class="bi bi-clipboard"></i></button>
            <pre><code>curl -L <span class="api-url-placeholder">URL</span>/api/download/x7Kp2mNvQwRtY9sLdFgHjBcXzA4E6uI1oP3aS5fVkW8nMqJrTyUeZiOlCbDhGx \\
  -o file1.pdf</code></pre>
          </div>
        </div>

        <!-- Destroy -->
        <h5 class="api-section-title">Destroy</h5>
        <div class="api-usage-section" style="border-bottom: none; margin-bottom: 0; padding-bottom: 0;">
          <div class="api-section-header">
            <span class="api-method">POST</span>
            <span class="api-endpoint">/api/destroy</span>
          </div>
          <p class="api-desc">Permanently destroy a Cryptex. Requires the cryptex password if one was set.</p>
          <div class="api-label">Request</div>
          <div class="api-code-block">
            <button class="btn btn-sm api-copy-btn" title="Copy"><i class="bi bi-clipboard"></i></button>
            <pre><code>curl -X POST <span class="api-url-placeholder">URL</span>/api/destroy \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{"id": "abc-defg-hij", "password": "mypassword"}'</code></pre>
          </div>
          <div class="form-hint mt-1">The <code>X-API-Key</code> header is only required when Cryptex is in private mode. The <code>password</code> field is only required if the cryptex is password-protected.</div>
          <div class="api-label">Response</div>
          <div class="api-code-block">
            <pre><code>{
  "message": "Cryptex destroyed successfully",
  "id": "abc-defg-hij"
}</code></pre>
          </div>
        </div>

      </div>
      <div class="custom-dialog-footer">
        <button id="apiReferenceDialogCloseBtn" class="btn btn-secondary">Close</button>
      </div>
    </div>
  </div>`;

  // Inject dialog into the page
  document.body.insertAdjacentHTML('beforeend', dialogHTML);

  const dialog = document.getElementById('apiReferenceDialog');
  const closeBtn = document.getElementById('apiReferenceDialogCloseBtn');
  const toggleBtn = document.getElementById('apiReferenceToggle');

  function openApiRef() {
    const baseUrl = window.location.origin;
    dialog.querySelectorAll('.api-url-placeholder').forEach(function (el) {
      el.textContent = baseUrl;
    });
    dialog.style.display = '';
  }

  function closeApiRef() {
    dialog.style.display = 'none';
  }

  if (toggleBtn) {
    toggleBtn.addEventListener('click', openApiRef);
  }
  closeBtn.addEventListener('click', closeApiRef);
  dialog.querySelector('.custom-dialog-backdrop').addEventListener('click', closeApiRef);

  // Escape key to close
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.style.display !== 'none') {
      closeApiRef();
    }
  });

  // Copy buttons
  dialog.querySelectorAll('.api-copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var code = btn.closest('.api-code-block').querySelector('code');
      navigator.clipboard.writeText(code.textContent).then(function () {
        btn.innerHTML = '<i class="bi bi-check"></i>';
        setTimeout(function () {
          btn.innerHTML = '<i class="bi bi-clipboard"></i>';
        }, 1500);
      });
    });
  });
})();
