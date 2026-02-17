from pydantic import BaseModel


class LinkCreate(BaseModel):
    """Request model for creating a link."""
    label: str = ""
    expires_in: int = 604800  # 7 days default


class LinkUpdate(BaseModel):
    """Request model for updating a link."""
    label: str
