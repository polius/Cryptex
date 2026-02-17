from pydantic import BaseModel


class AppSettings(BaseModel):
    """Application settings model."""
    mode: str  # "public" or "private"
    max_message_length: int
    max_file_count: int
    max_file_size: str
    max_expiration: str
