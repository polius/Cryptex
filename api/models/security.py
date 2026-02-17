from pydantic import BaseModel


class SecuritySettings(BaseModel):
    """Security settings update model."""
    new_password: str | None = None


class TwoFactorVerify(BaseModel):
    """2FA verification model."""
    totp_code: str
