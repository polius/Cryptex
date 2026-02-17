from pathlib import Path
import json
import hashlib
import secrets
import time

from fastapi import APIRouter, Depends, Request, HTTPException
import bcrypt
import pyotp
import qrcode
import io
import base64

from ..models import SecuritySettings, TwoFactorVerify
from .. import database as db
from . import auth
from .auth import check_auth, two_factor_settings

router = APIRouter(prefix="/admin", tags=["Security"])

# Persistent file for 2FA settings
SECURITY_FILE = Path("/cryptex/data/security.json")

def _load_persisted_2fa():
    """Load persisted 2FA settings from disk on startup."""
    if SECURITY_FILE.exists():
        try:
            data = json.loads(SECURITY_FILE.read_text())
            two_factor_settings["enabled"] = data.get("enabled", False)
            two_factor_settings["secret"] = data.get("secret")
        except (json.JSONDecodeError, OSError):
            pass

def _persist_2fa():
    """Persist current 2FA settings to disk."""
    SECURITY_FILE.parent.mkdir(parents=True, exist_ok=True)
    SECURITY_FILE.write_text(json.dumps({
        "enabled": two_factor_settings["enabled"],
        "secret": two_factor_settings["secret"],
    }))

_load_persisted_2fa()

@router.get("/security")
async def get_security_settings(
    user = Depends(check_auth)
):
    """Get current security settings"""
    return {
        "two_factor_enabled": two_factor_settings["enabled"]
    }

@router.post("/security/2fa/setup")
async def setup_2fa(
    user = Depends(check_auth)
):
    """Generate a new 2FA secret and QR code"""
    # Generate new secret
    secret = pyotp.random_base32()
    
    # Create TOTP URI
    totp = pyotp.TOTP(secret)
    provisioning_uri = totp.provisioning_uri(
        name="admin",
        issuer_name="Cryptex"
    )
    
    # Generate QR code
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(provisioning_uri)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    
    # Convert to base64
    buffer = io.BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)
    qr_base64 = base64.b64encode(buffer.getvalue()).decode()
    
    # Store secret temporarily (will be confirmed on verify)
    two_factor_settings["pending_secret"] = secret
    
    return {
        "secret": secret,
        "qr_code": f"data:image/png;base64,{qr_base64}",
        "provisioning_uri": provisioning_uri
    }

@router.post("/security/2fa/verify")
async def verify_2fa_setup(
    data: TwoFactorVerify,
    user = Depends(check_auth)
):
    """Verify 2FA setup with a code"""
    if "pending_secret" not in two_factor_settings:
        raise HTTPException(400, "No pending 2FA setup")
    
    secret = two_factor_settings["pending_secret"]
    totp = pyotp.TOTP(secret)
    
    if not totp.verify(data.totp_code, valid_window=1):
        raise HTTPException(400, "Invalid verification code")
    
    # Activate 2FA
    two_factor_settings["secret"] = secret
    two_factor_settings["enabled"] = True
    del two_factor_settings["pending_secret"]
    _persist_2fa()
    
    return {"message": "2FA enabled successfully"}

@router.post("/security/2fa/disable")
async def disable_2fa(
    user = Depends(check_auth)
):
    """Disable 2FA"""
    two_factor_settings["enabled"] = False
    two_factor_settings["secret"] = None
    if "pending_secret" in two_factor_settings:
        del two_factor_settings["pending_secret"]
    _persist_2fa()
    
    return {"message": "2FA disabled successfully"}

@router.post("/security/password")
async def change_password(
    data: SecuritySettings,
    user = Depends(check_auth)
):
    """Change admin password"""
    if not data.new_password:
        raise HTTPException(400, "New password is required")
    
    # Hash the new password with bcrypt
    hashed = bcrypt.hashpw(data.new_password.encode('utf-8'), bcrypt.gensalt()).decode()
    
    # Update the password in the auth module
    auth.ADMIN_PASSWORD = hashed
    
    # Persist to disk (single source of truth)
    password_file = Path("/cryptex/data/password.conf")
    password_file.parent.mkdir(parents=True, exist_ok=True)
    password_file.write_text(hashed)
    
    return {"message": "Password changed successfully"}


# ---------------------------------------------------------------------------
# API Key Management
# ---------------------------------------------------------------------------

@router.get("/security/api-keys")
async def list_api_keys(
    user = Depends(check_auth)
):
    """List all API keys (without revealing the key values)."""
    keys = await db.get_all_api_keys()
    return {"keys": keys}


@router.post("/security/api-keys")
async def create_api_key_endpoint(
    request: Request,
    user = Depends(check_auth)
):
    """Generate a new API key. Returns the raw key only once."""
    body = await request.json()
    name = body.get("name", "").strip()
    description = body.get("description", "").strip()
    if not name:
        raise HTTPException(400, "API key name is required")
    if len(name) > 64:
        raise HTTPException(400, "API key name must be 64 characters or less")
    if len(description) > 256:
        raise HTTPException(400, "Description must be 256 characters or less")

    # Generate a secure random key
    raw_key = f"cx_{secrets.token_urlsafe(32)}"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    key_id = secrets.token_urlsafe(8)
    now = int(time.time())

    record = await db.create_api_key(key_id, name, description, key_hash, now)
    # Return the raw key only this once — it won't be stored or shown again
    record["key"] = raw_key
    return record


@router.delete("/security/api-keys/{key_id}")
async def revoke_api_key(
    key_id: str,
    user = Depends(check_auth)
):
    """Revoke (delete) an API key."""
    deleted = await db.delete_api_key(key_id)
    if not deleted:
        raise HTTPException(404, "API key not found")
    return {"message": "API key revoked successfully"}


@router.delete("/security/api-keys")
async def delete_all_api_keys(
    user = Depends(check_auth)
):
    """Delete all API keys."""
    count = await db.delete_all_api_keys()
    return {"message": f"{count} API key(s) deleted"}
