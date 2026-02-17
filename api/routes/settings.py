from fastapi import APIRouter, Depends, HTTPException
from pathlib import Path
import os
import json

from ..models import AppSettings
from .auth import check_auth

router = APIRouter(prefix="/admin", tags=["Settings"])

# Settings file path
SETTINGS_FILE = Path("/cryptex/data/settings.json")

# Built-in defaults (used to detect if env vars were explicitly changed)
_BUILTIN_DEFAULTS = {
    "mode": "public",
    "max_message_length": "1000",
    "max_file_count": "3",
    "max_file_size": "100mb",
    "max_expiration": "1d",
}

def _get_env_overrides() -> dict:
    """Return a dict of settings where the env var differs from its built-in default.
    These should always win over persisted settings."""
    overrides = {}
    mapping = {
        "MODE": ("mode", str),
        "MAX_MESSAGE_LENGTH": ("max_message_length", int),
        "MAX_FILE_COUNT": ("max_file_count", int),
        "MAX_FILE_SIZE": ("max_file_size", str),
        "MAX_EXPIRATION": ("max_expiration", str),
    }
    for env_key, (setting_key, cast) in mapping.items():
        raw = os.getenv(env_key)
        if raw is not None and raw != _BUILTIN_DEFAULTS.get(setting_key):
            overrides[setting_key] = cast(raw)
    return overrides

def load_settings() -> dict:
    """Load settings from file, then apply any explicit env-var overrides."""
    # Start with defaults
    defaults = {
        "mode": os.getenv("MODE", "public"),
        "max_message_length": int(os.getenv("MAX_MESSAGE_LENGTH", "1000")),
        "max_file_count": int(os.getenv("MAX_FILE_COUNT", "3")),
        "max_file_size": os.getenv("MAX_FILE_SIZE", "100mb"),
        "max_expiration": os.getenv("MAX_EXPIRATION", "1d"),
    }

    # Load persisted settings (overwrites defaults)
    if SETTINGS_FILE.exists():
        try:
            persisted = json.loads(SETTINGS_FILE.read_text())
            defaults.update(persisted)
        except (json.JSONDecodeError, OSError):
            pass

    # Env-var overrides always win if the user explicitly changed them
    defaults.update(_get_env_overrides())
    return defaults

def save_settings(settings: dict):
    """Save settings to file"""
    SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2))

@router.get("/settings")
async def get_settings(
    user = Depends(check_auth)
):
    """Get current application settings"""
    return load_settings()

@router.post("/settings")
async def update_settings(
    settings: AppSettings,
    user = Depends(check_auth)
):
    """Update application settings"""
    
    # Validate mode
    if settings.mode not in ["public", "private"]:
        raise HTTPException(status_code=400, detail="Mode must be 'public' or 'private'")
    
    # Validate positive integers
    if settings.max_message_length <= 0:
        raise HTTPException(status_code=400, detail="Max message length must be positive")
    if settings.max_file_count <= 0:
        raise HTTPException(status_code=400, detail="Max file count must be positive")
    
    # Save settings
    settings_dict = settings.model_dump()
    save_settings(settings_dict)
    
    return {
        "status": "success",
        "message": "Settings updated successfully",
        "settings": settings_dict
    }

@router.get("/mode")
async def get_mode():
    """Get current app mode (public or private) - no auth required"""
    settings = load_settings()
    return {"mode": settings.get("mode", "public")}
