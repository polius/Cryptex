from pydantic import BaseModel, Field


class FileMetadata(BaseModel):
    """File metadata model."""
    filename: str
    size: int


class FileDownload(BaseModel):
    """Request model for downloading a file."""
    cryptex_id: str = Field(..., description="Cryptex ID")
    filename: str = Field(..., description="Original filename")
    password: str | None = Field(None, max_length=128, description="Password in plain text. None for passwordless mode.")
