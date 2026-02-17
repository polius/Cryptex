from pydantic import BaseModel


class LoginRequest(BaseModel):
    """Request model for admin login."""
    password: str
    totp_code: str | None = None  # Optional 2FA code
