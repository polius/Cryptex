from pydantic import BaseModel, Field

from .file import FileMetadata


class CryptexCreate(BaseModel):
    """Request model for creating a cryptex."""
    text: str = Field("", description="Text to store")
    password: str | None = Field(None, max_length=128, description="Password in plain text. The server will hash it before storage. None for passwordless mode.")
    retention: int | str = Field(86400, description="Retention time (seconds or format: 30m, 24h, 30d)")


class CryptexResponse(BaseModel):
    """Response model after creating a cryptex."""
    message: str = Field("Cryptex created successfully", description="Status message")
    id: str = Field(..., description="Cryptex ID")
    expiration: str = Field(..., description="Expiration time")
    has_password: bool = Field(False, description="Whether the cryptex is password-protected")
    autodestroy: bool = Field(False, description="Whether the cryptex will self-destruct after reading")
    files: int = Field(0, description="Number of attached files")
    total_size: int = Field(0, description="Total size of all content in bytes")


class CryptexOpen(BaseModel):
    """Request model for opening a cryptex."""
    id: str = Field(..., description="Cryptex ID")
    password: str | None = Field(None, max_length=128, description="Password in plain text. None for passwordless mode.")


class CryptexOpenResponse(BaseModel):
    """Response model after opening a cryptex."""
    text: str = Field(..., description="Stored text")
    expiration: str = Field(..., description="Remaining time")
    files: list[FileMetadata] = Field(default=[], description="Attached files")
    autodestroy: bool = Field(default=False, description="Whether to auto-delete after reading")
    views: int = Field(default=0, description="Number of times this cryptex has been viewed")


class CryptexDestroy(BaseModel):
    """Request model for destroying a cryptex."""
    id: str = Field(..., description="Cryptex ID")
    password: str | None = Field(None, max_length=128, description="Password in plain text. None for passwordless mode.")
