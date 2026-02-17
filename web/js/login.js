// Password visibility toggle
const pwdToggle = document.getElementById('pwdToggle');
const pwdToggleIcon = document.getElementById('pwdToggleIcon');
const passwordInput = document.getElementById('password');

if (pwdToggle) {
  pwdToggle.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    pwdToggleIcon.classList.toggle('bi-eye-fill', !isPassword);
    pwdToggleIcon.classList.toggle('bi-eye-slash-fill', isPassword);
    passwordInput.focus();
  });
}

async function login(event) {
  event.preventDefault();

  // Disable the submit button
  const submitButton = document.getElementById("submit");
  const submitLoading = document.getElementById("loading");
  submitButton.setAttribute("disabled", "");
  submitLoading.style.display = 'inline-flex';

  // Get form data
  const formData = new FormData(event.target);
  const data = {
    password: formData.get('password')
  };
  
  // Add TOTP code if provided
  const totpCode = formData.get('totpCode');
  if (totpCode && totpCode.trim()) {
    data.totp_code = totpCode.trim();
  }

  // Perform login
  try {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      let errorMessage = 'An error occurred';
      let show2FA = false;
      try {
        const json = await response.json();
        errorMessage = json.detail || errorMessage;
        
        // If 2FA is required, show the TOTP input field silently
        if (errorMessage === '2FA code required') {
          document.getElementById('totpContainer').style.display = 'block';
          document.getElementById('totpCode').focus();
          show2FA = true;
        }
      } catch (e) {
        // Response is not JSON, use status-based message
        if (response.status === 401) errorMessage = 'Invalid credentials';
      }
      
      // Don't throw error if we're just showing the 2FA field
      if (show2FA) {
        submitButton.removeAttribute("disabled");
        submitLoading.style.display = 'none';
        return;
      }
      
      throw new Error(errorMessage);
    }
    
    // Success - redirect to the requested page (or home)
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect') || '/';
    // Prevent open redirect — only allow relative paths
    if (redirect.startsWith('/') && !redirect.startsWith('//')) {
      window.location.href = redirect;
    } else {
      window.location.href = '/';
    }
  }
  catch (error) {
    // Show error message
    showToast(error.message, 'error');

    // Clear password field and focus it (unless 2FA field is shown)
    const totpContainer = document.getElementById('totpContainer');
    if (totpContainer.style.display === 'none') {
      const passwordInput = document.getElementById('password');
      if (passwordInput) {
        passwordInput.value = '';
        passwordInput.focus();
        passwordInput.select();
      }
    }

    // Enable login button
    submitButton.removeAttribute("disabled");
    submitLoading.style.display = 'none';
  }
}

// Check if already logged in
async function checkLogin() {
  try {
    const response = await fetch(`${API_URL}/auth/check`, {
      method: 'GET',
      credentials: 'include',
    });
    if (response.ok) {
      // Already logged in, redirect to requested page
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get('redirect') || '/';
    }
  } catch (error) {
    // Not logged in, stay on login page
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await checkLogin();

  const loader = document.getElementById('initialLoader');
  if (loader) loader.remove();
  const pageContent = document.getElementById('pageContent');
  if (pageContent) pageContent.style.display = '';
});
