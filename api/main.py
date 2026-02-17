import os
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import utils
from . import database as db
from .routes.cryptex import CryptexRouter
from .routes.auth import router as auth_router
from .routes.monitor import router as monitor_router
from .routes.settings import router as admin_router
from .routes.links import router as links_router
from .routes.security import router as security_router
from .cleanup import cleanup_expired

# Configuration from environment variables
VERSION = "2.2.0"
MAX_RETRIES = 5
MAX_MESSAGE_LENGTH = int(os.getenv("MAX_MESSAGE_LENGTH", "1000"))
MAX_FILE_COUNT = int(os.getenv("MAX_FILE_COUNT", "3"))
MAX_FILE_SIZE = utils.parse_file_size(os.getenv("MAX_FILE_SIZE", "100mb"))
MAX_EXPIRATION = utils.parse_time(os.getenv("MAX_EXPIRATION", "1d"))
FILES_DIR = db.FILES_DIR
CLEANUP_INTERVAL = 300  # 5 minutes

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialise the SQLite database
    await db.init_db()
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    
    # Start background cleanup task
    cleanup_task = asyncio.create_task(cleanup_expired(FILES_DIR, CLEANUP_INTERVAL))
    
    yield
    
    # Cancel cleanup task on shutdown
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass

app = FastAPI(title="Cryptex API", version=VERSION, lifespan=lifespan, root_path="/api")
app.add_middleware(CORSMiddleware, allow_origins=[], allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# Initialize router with configuration
cryptex_router = CryptexRouter(
    version=VERSION,
    max_retries=MAX_RETRIES,
    max_message_length=MAX_MESSAGE_LENGTH,
    max_file_count=MAX_FILE_COUNT,
    max_file_size=MAX_FILE_SIZE,
    max_expiration=MAX_EXPIRATION,
    files_dir=FILES_DIR
)

# Include routers
app.include_router(cryptex_router.router)
app.include_router(auth_router)
app.include_router(monitor_router)
app.include_router(admin_router)
app.include_router(links_router)
app.include_router(security_router)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": VERSION}
