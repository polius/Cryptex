import hashlib
import json
import re
import secrets
import shutil
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, File, Form, Request, UploadFile
from fastapi.responses import FileResponse

from .. import database as db
from .. import utils
from ..models import (
    CryptexOpen,
    CryptexOpenResponse,
    CryptexDestroy,
    CryptexCreate,

    CryptexResponse,
    FileDownload,
)
from .auth import check_auth
from .settings import load_settings

# Cryptex ID format: xxx-xxxx-xxx (lowercase letters only)
CRYPTEX_ID_PATTERN = re.compile(r'^[a-z]{3}-[a-z]{4}-[a-z]{3}$')


class CryptexRouter:
    def __init__(self, version: str, max_retries: int, max_message_length: int, max_file_count: int, max_file_size: int, max_expiration: int, files_dir: Path):
        self.VERSION = version
        self.MAX_RETRIES = max_retries
        self.MAX_MESSAGE_LENGTH = max_message_length
        self.MAX_FILE_COUNT = max_file_count
        self.MAX_FILE_SIZE = max_file_size
        self.MAX_EXPIRATION = max_expiration
        self.FILES_DIR = files_dir

        # In-memory store for short-lived download tokens (like S3 presigned URLs)
        # { token: { path, name, size, exp, cryptex_id, single_use } }
        self._download_tokens: dict[str, dict] = {}
        # Track which files have been downloaded for autodestroy cryptexes
        # { cryptex_id: { filename1, filename2, ... } }
        self._autodestroy_downloads: dict[str, set] = {}

        self.router = APIRouter(tags=["Cryptex"])
        self.router.add_api_route("/", self.root, methods=["GET"])
        self.router.add_api_route("/create", self.create, methods=["POST"], response_model=None)
        self.router.add_api_route("/create/file/start", self.start_multipart_upload, methods=["POST"])
        self.router.add_api_route("/create/file/part", self.upload_part, methods=["POST"])
        self.router.add_api_route("/create/file/complete", self.complete_multipart_upload, methods=["POST"])
        self.router.add_api_route("/create/file/abort", self.abort_multipart_upload, methods=["POST"])
        self.router.add_api_route("/open", self.open, methods=["POST"], response_model=CryptexOpenResponse)

        self.router.add_api_route("/download", self.create_download_url, methods=["POST"])
        self.router.add_api_route("/download/{token}", self.download_file, methods=["GET"])
        self.router.add_api_route("/destroy", self.destroy, methods=["POST"])

    def get_current_limits(self):
        """Get current limits from settings file or defaults"""
        settings = load_settings()
        return {
            "max_message_length": settings.get("max_message_length", self.MAX_MESSAGE_LENGTH),
            "max_file_count": settings.get("max_file_count", self.MAX_FILE_COUNT),
            "max_file_size": utils.parse_file_size(settings.get("max_file_size", "100mb")),
            "max_expiration": utils.parse_time(settings.get("max_expiration", "1d"))
        }

    async def root(self):
        settings = load_settings()
        limits = self.get_current_limits()
        return {
            "status": "ok",
            "message": "Cryptex API is running",
            "version": self.VERSION,
            "config": {
                "mode": settings.get("mode", "public"),
                "max_message_length": limits["max_message_length"],
                "max_file_count": limits["max_file_count"],
                "max_file_size": limits["max_file_size"],
                "max_expiration": limits["max_expiration"]
            }
        }

    async def create(
        self,
        request: Request,
        text: str = Form(""),
        password: str = Form(""),
        retention: str = Form("1d"),
        has_pending_files: bool = Form(False),
        autodestroy: bool = Form(False),
        invite: str | None = Form(None),
        file: list[UploadFile] = File(default=[]),
    ):
        # Check and validate link token if provided (regardless of mode)
        valid_link_token = None
        link_password = None
        if invite:
            link = await db.get_link(invite)
            if not link:
                raise HTTPException(404, "Invalid invite link")
            now = int(time.time())
            if link['expires_at'] > 0 and link['expires_at'] <= now:
                raise HTTPException(410, "Invite link has expired")
            if link['uses'] >= link['max_uses'] or link.get('cryptex_id'):
                raise HTTPException(410, "Invite link has already been used")
            valid_link_token = invite
            link_password = link.get('password')
        
        # Check if app is in private mode
        settings = load_settings()
        if settings.get("mode") == "private":
            # If no valid link, require authentication (cookie or API key)
            if not valid_link_token:
                authenticated = False
                # Check cookie-based auth
                try:
                    access_token = request.cookies.get("access_token")
                    check_auth(request, access_token)
                    authenticated = True
                except HTTPException:
                    pass
                # Check API key auth
                if not authenticated:
                    api_key = request.headers.get("X-API-Key")
                    if api_key:
                        key_hash = hashlib.sha256(api_key.encode()).hexdigest()
                        key_record = await db.verify_api_key(key_hash)
                        if key_record:
                            authenticated = True
                if not authenticated:
                    raise HTTPException(401, "Authentication required to create Cryptex items in private mode")
        
        # Parse retention to seconds if it's a string format
        try:
            retention_seconds = utils.parse_time(str(retention))
        except ValueError as e:
            raise HTTPException(400, str(e))
        
        # If using invite token and no password provided, use the link's password
        if valid_link_token and not password and link_password:
            password = link_password

        # Hash password if provided
        hashed_password = None
        if password:
            hashed_password = utils.hash_password(password)
        
        # Get current limits from settings
        limits = self.get_current_limits()
        
        # Validate using model
        try:
            cryptex_data = CryptexCreate(text=text, password=hashed_password, retention=retention_seconds)
        except Exception as e:
            raise HTTPException(400, str(e))
        
        # Additional validation
        if len(cryptex_data.text) > limits["max_message_length"]:
            raise HTTPException(400, f"Text cannot be greater than {limits['max_message_length']} characters")
        if cryptex_data.retention < 60:
            raise HTTPException(400, "Retention must be at least 1 minute")
        if cryptex_data.retention > limits["max_expiration"]:
            raise HTTPException(400, f"Retention cannot exceed {utils.format_time(limits['max_expiration'])}")
        
        # Validate content - require either text, direct form files, or pending multipart files
        if not cryptex_data.text.strip() and len(file) == 0 and not has_pending_files:
            raise HTTPException(400, "Must provide either text or files")

        if len(file) > limits["max_file_count"]:
            raise HTTPException(400, f"Maximum {limits['max_file_count']} files allowed")
        
        # Generate cryptex ID first so we can stream files directly to disk
        cryptex_id = None
        cryptex_dir = None
        for attempt in range(self.MAX_RETRIES):
            candidate_id = utils.generate_random_id()
            candidate_dir = self.FILES_DIR / candidate_id
            if not candidate_dir.exists() and not await db.cryptex_exists(candidate_id):
                cryptex_id = candidate_id
                cryptex_dir = candidate_dir
                break
        
        if cryptex_id is None:
            raise HTTPException(500, f"Failed to generate unique cryptex ID after {self.MAX_RETRIES} attempts. Please try again.")
        
        # Create folder for this cryptex
        cryptex_dir.mkdir(parents=True, exist_ok=True)
        
        try:
            # Store text to disk
            text_file = cryptex_dir / "text.txt"
            text_file.write_text(cryptex_data.text.strip(), encoding='utf-8')
            
            # Direct file uploads (CLI / cURL path)
            CHUNK_SIZE = 1024 * 1024  # 1MB
            stored_files = []
            for uploaded_file in file:
                if not uploaded_file.filename:
                    continue

                filename = Path(uploaded_file.filename).name
                if not filename or filename in ('.', '..'):
                    continue

                file_path = cryptex_dir / filename
                file_size = 0
                with open(file_path, "wb") as out:
                    while True:
                        chunk = await uploaded_file.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        file_size += len(chunk)
                        if file_size > limits["max_file_size"]:
                            out.close()
                            shutil.rmtree(cryptex_dir, ignore_errors=True)
                            raise HTTPException(400, f"File {filename} exceeds maximum size of {limits['max_file_size']} bytes")
                        out.write(chunk)

                stored_files.append({
                    "filename": filename,
                    "size": file_size,
                })
            
            # Calculate total size for the DB record
            text_content = cryptex_data.text.strip()
            total_size = len(text_content.encode('utf-8'))
            total_size += sum(f["size"] for f in stored_files)

            # Store metadata in SQLite
            created = datetime.now(timezone.utc).isoformat()
            await db.store_cryptex(
                cryptex_id=cryptex_id,
                password=cryptex_data.password,
                created=created,
                retention=cryptex_data.retention,
                files=stored_files,
                autodestroy=autodestroy,
                has_text=bool(text_content),
                total_size=total_size,
                pending=has_pending_files,
            )
            
            # If created via link, consume it immediately
            if valid_link_token:
                await db.update_link_cryptex(valid_link_token, cryptex_id, bool(cryptex_data.password))
            
            # If created via invite link, return minimal details
            if valid_link_token:
                return {"message": "Cryptex created successfully", "id": cryptex_id}
            return CryptexResponse(
                id=cryptex_id,
                expiration=utils.format_time(cryptex_data.retention),
                has_password=bool(cryptex_data.password),
                autodestroy=autodestroy,
                files=len(stored_files),
                total_size=total_size,
            )
        except HTTPException:
            raise
        except Exception as e:
            # Clean up directory on unexpected errors
            shutil.rmtree(cryptex_dir, ignore_errors=True)
            raise HTTPException(500, f"Failed to create cryptex: {str(e)}")

    # ---- Multipart Upload (S3-style) ----
    # Each chunk is appended directly to the target file as it
    # arrives — no separate part files, no concatenation step, no extra
    # disk usage.  A small metadata directory tracks the upload state and
    # is cleaned up on completion or abort.

    _UPLOAD_META_FILE = "meta.json"
    _UPLOAD_DIR_PREFIX = "_upload_"
    _UPLOAD_MAX_AGE = 600  # 10-minute inactivity TTL

    async def start_multipart_upload(self, request: Request):
        """Initiate a multipart file upload for an existing cryptex.

        Creates an empty target file and a metadata directory that tracks
        cumulative size and activity.  Returns an ``upload_id`` that the
        client uses for subsequent ``upload_part`` / ``complete`` /
        ``abort`` calls.

        Query params: cryptex_id, filename
        Returns: { upload_id }
        """
        cryptex_id = request.query_params.get("cryptex_id")
        filename = request.query_params.get("filename")

        if not cryptex_id or not filename:
            raise HTTPException(400, "cryptex_id and filename are required")
        if not CRYPTEX_ID_PATTERN.match(cryptex_id):
            raise HTTPException(400, "Invalid cryptex ID format")

        filename = Path(filename).name
        if not filename or filename in ('.', '..'):
            raise HTTPException(400, "Invalid filename")

        # Verify cryptex exists and hasn't been consumed
        cryptex = await db.get_cryptex(cryptex_id)
        if not cryptex:
            raise HTTPException(404, "Cryptex not found")
        if cryptex.get("consumed"):
            raise HTTPException(400, "Cryptex has already been consumed")

        # Check file count limit
        limits = self.get_current_limits()
        existing_files = cryptex.get("files", [])
        if isinstance(existing_files, str):
            existing_files = json.loads(existing_files)
        if len(existing_files) >= limits["max_file_count"]:
            raise HTTPException(400, f"Maximum {limits['max_file_count']} files allowed")

        cryptex_dir = self.FILES_DIR / cryptex_id
        if not cryptex_dir.exists():
            raise HTTPException(404, "Cryptex directory not found")

        upload_id = uuid.uuid4().hex
        upload_dir = cryptex_dir / f"{self._UPLOAD_DIR_PREFIX}{upload_id}"
        upload_dir.mkdir(parents=True, exist_ok=True)

        # Create the target file (empty)
        target_path = cryptex_dir / filename
        target_path.touch()

        now = time.time()
        meta = {
            "filename": filename,
            "created_at": now,
            "last_active": now,
            "total_size": 0,
            "parts": 0,
        }
        (upload_dir / self._UPLOAD_META_FILE).write_text(json.dumps(meta))

        return {"message": "Multipart upload initiated", "upload_id": upload_id, "filename": filename}

    async def upload_part(self, request: Request):
        """Upload a single part of a multipart upload.

        The incoming bytes are appended directly to the target file —
        there are no temporary part files and no concatenation step.

        Query params: cryptex_id, upload_id, part (0-based index)
        Body: raw application/octet-stream bytes
        """
        cryptex_id = request.query_params.get("cryptex_id")
        upload_id = request.query_params.get("upload_id")
        part = request.query_params.get("part")

        if not cryptex_id or not upload_id or part is None:
            raise HTTPException(400, "cryptex_id, upload_id, and part are required")
        if not CRYPTEX_ID_PATTERN.match(cryptex_id):
            raise HTTPException(400, "Invalid cryptex ID format")

        try:
            part_number = int(part)
        except ValueError:
            raise HTTPException(400, "part must be an integer")

        upload_dir = self.FILES_DIR / cryptex_id / f"{self._UPLOAD_DIR_PREFIX}{upload_id}"
        if not upload_dir.exists():
            raise HTTPException(404, "Upload session not found")

        # Read metadata and check inactivity TTL
        meta_path = upload_dir / self._UPLOAD_META_FILE
        if not meta_path.exists():
            raise HTTPException(404, "Upload metadata missing")

        meta = json.loads(meta_path.read_text())
        if time.time() - meta.get("last_active", 0) > self._UPLOAD_MAX_AGE:
            # Stale — clean up target file and metadata directory
            target = self.FILES_DIR / cryptex_id / meta["filename"]
            target.unlink(missing_ok=True)
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise HTTPException(410, "Upload session expired")

        filename = meta["filename"]
        current_size = meta.get("total_size", 0)

        # Size limit for the whole file
        limits = self.get_current_limits()
        max_file_size = limits["max_file_size"]

        # Append streamed bytes directly to target file
        target_path = self.FILES_DIR / cryptex_id / filename
        part_size = 0
        try:
            with open(target_path, "ab") as f:
                async for chunk in request.stream():
                    part_size += len(chunk)
                    if current_size + part_size > max_file_size:
                        raise HTTPException(
                            400,
                            f"File {filename} exceeds maximum size",
                        )
                    f.write(chunk)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, f"Failed to write part: {str(e)}")

        # Update metadata
        meta["total_size"] = current_size + part_size
        meta["parts"] = meta.get("parts", 0) + 1
        meta["last_active"] = time.time()
        meta_path.write_text(json.dumps(meta))

        return {"message": "Part uploaded successfully", "part": part_number, "size": part_size}

    async def complete_multipart_upload(self, request: Request):
        """Finalize a multipart upload.

        Since every part was already appended to the target file, this
        endpoint only needs to validate the final size, register the file
        in the database, and remove the metadata directory.  No data is
        copied or concatenated.

        Query params: cryptex_id, upload_id
        """
        cryptex_id = request.query_params.get("cryptex_id")
        upload_id = request.query_params.get("upload_id")

        if not cryptex_id or not upload_id:
            raise HTTPException(400, "cryptex_id and upload_id are required")
        if not CRYPTEX_ID_PATTERN.match(cryptex_id):
            raise HTTPException(400, "Invalid cryptex ID format")

        upload_dir = self.FILES_DIR / cryptex_id / f"{self._UPLOAD_DIR_PREFIX}{upload_id}"
        if not upload_dir.exists():
            raise HTTPException(404, "Upload session not found")

        meta_path = upload_dir / self._UPLOAD_META_FILE
        if not meta_path.exists():
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise HTTPException(404, "Upload metadata missing")

        meta = json.loads(meta_path.read_text())
        filename = meta["filename"]
        file_size = meta.get("total_size", 0)

        target_path = self.FILES_DIR / cryptex_id / filename

        # Final size validation
        limits = self.get_current_limits()
        if file_size > limits["max_file_size"]:
            target_path.unlink(missing_ok=True)
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise HTTPException(400, f"File {filename} exceeds maximum size")

        if not target_path.exists() or file_size == 0:
            target_path.unlink(missing_ok=True)
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise HTTPException(400, "No data uploaded")

        # Clean up the metadata directory (target file stays)
        shutil.rmtree(upload_dir, ignore_errors=True)

        # Register the file in the database
        await db.add_file_to_cryptex(cryptex_id, filename, file_size)

        # If this is the last file, mark the cryptex as ready
        finalize = request.query_params.get("finalize")
        if finalize == "true":
            await db.mark_cryptex_ready(cryptex_id)

        return {"message": "Upload completed successfully", "filename": filename, "size": file_size}

    async def abort_multipart_upload(self, request: Request):
        """Abort a multipart upload.

        Deletes both the partially-written target file and the metadata
        directory so disk is reclaimed immediately.

        Query params: cryptex_id, upload_id
        """
        cryptex_id = request.query_params.get("cryptex_id")
        upload_id = request.query_params.get("upload_id")

        if not cryptex_id or not upload_id:
            raise HTTPException(400, "cryptex_id and upload_id are required")
        if not CRYPTEX_ID_PATTERN.match(cryptex_id):
            raise HTTPException(400, "Invalid cryptex ID format")

        upload_dir = self.FILES_DIR / cryptex_id / f"{self._UPLOAD_DIR_PREFIX}{upload_id}"
        if upload_dir.exists():
            # Read metadata to find and delete the target file
            meta_path = upload_dir / self._UPLOAD_META_FILE
            if meta_path.exists():
                try:
                    meta = json.loads(meta_path.read_text())
                    target = self.FILES_DIR / cryptex_id / meta["filename"]
                    target.unlink(missing_ok=True)
                except Exception:
                    pass
            shutil.rmtree(upload_dir, ignore_errors=True)

        return {"message": "Upload aborted successfully"}

    async def open(
        self,
        request: CryptexOpen,
    ):
        # Validate cryptex ID format to prevent path traversal
        if not CRYPTEX_ID_PATTERN.match(request.id):
            raise HTTPException(400, "Invalid cryptex ID format")
        
        # Hash password if provided
        password = None
        if request.password:
            password = utils.hash_password(request.password)
        metadata = await db.verify_cryptex(request.id, password)
        
        # Check if autodestroy cryptex was already consumed
        if metadata.get("consumed"):
            raise HTTPException(404, "This cryptex does not exist or has expired.")
        
        # Read text from disk
        cryptex_dir = self.FILES_DIR / request.id
        text_file = cryptex_dir / "text.txt"
        text = text_file.read_text(encoding='utf-8') if text_file.exists() else ""
        
        created_time = datetime.fromisoformat(metadata["created"]).replace(tzinfo=timezone.utc)
        remaining = (created_time + timedelta(seconds=metadata["retention"]) - datetime.now(timezone.utc)).total_seconds()
        
        files = metadata.get("files", [])
        autodestroy = metadata.get("autodestroy", False)
        
        # If autodestroy, mark as consumed so it can't be opened again.
        # Actual deletion happens via the cleanup process when expiration is reached.
        if autodestroy:
            await db.mark_consumed(request.id)
        
        # Increment view count
        views = await db.increment_views(request.id)
        
        return CryptexOpenResponse(
            text=text,
            expiration=utils.format_time(remaining),
            files=[{"filename": f["filename"], "size": f["size"]} for f in files],
            autodestroy=autodestroy,
            views=views
        )

    async def create_download_url(
        self,
        request: FileDownload,
        http_request: Request,
    ):
        """Generate a short-lived presigned download URL (like S3).

        Requires the cryptex password. Returns a single-use presigned
        URL valid for 60 seconds.

        For autodestroy cryptexes, each file can only have one URL
        generated — once used, that file cannot be downloaded again.
        """
        if not CRYPTEX_ID_PATTERN.match(request.cryptex_id):
            raise HTTPException(400, "Invalid cryptex ID format")

        password = None
        if request.password:
            password = utils.hash_password(request.password)
        metadata = await db.verify_cryptex(request.cryptex_id, password)

        is_autodestroy = metadata.get("autodestroy", False)

        # For autodestroy cryptexes, must be consumed (opened) first and
        # each file can only be downloaded once.
        if is_autodestroy:
            if not metadata.get("consumed"):
                raise HTTPException(400, "Cryptex must be opened before downloading files")
            downloaded = self._autodestroy_downloads.get(request.cryptex_id, set())
            if request.filename in downloaded:
                raise HTTPException(410, "File has already been downloaded")

        file_info = next(
            (f for f in metadata.get("files", []) if f["filename"] == request.filename),
            None
        )
        if not file_info:
            raise HTTPException(404, "File not found")

        cryptex_dir = self.FILES_DIR / request.cryptex_id
        file_path = cryptex_dir / file_info["filename"]
        if not file_path.exists():
            raise HTTPException(404, "File not found on disk")

        # Purge expired tokens
        now = time.time()
        self._download_tokens = {
            k: v for k, v in self._download_tokens.items() if v["exp"] > now
        }

        token = secrets.token_urlsafe(48)
        self._download_tokens[token] = {
            "path": str(file_path),
            "name": file_info["filename"],
            "size": file_path.stat().st_size,
            "exp": now + 60,
            "cryptex_id": request.cryptex_id,
            "autodestroy": is_autodestroy,
        }

        # Build full download URL from the incoming request
        base_url = str(http_request.base_url).rstrip("/")
        url = f"{base_url}/api/download/{token}"

        return {"message": "Download URL generated", "token": token, "url": url, "filename": file_info["filename"], "size": file_info["size"], "expires_in": 60}

    async def download_file(self, token: str):
        """Serve a file using a short-lived presigned URL (GET).

        The token is single-use: it is consumed on download. For autodestroy
        cryptexes, the file is also marked as downloaded so it cannot be
        requested again.
        """
        entry = self._download_tokens.pop(token, None)
        if not entry or time.time() > entry["exp"]:
            raise HTTPException(404, "Invalid or expired download token")

        file_path = Path(entry["path"])
        if not file_path.exists():
            raise HTTPException(404, "File not found on disk")

        # For autodestroy cryptexes, track that this file has been downloaded
        if entry.get("autodestroy"):
            cryptex_id = entry["cryptex_id"]
            if cryptex_id not in self._autodestroy_downloads:
                self._autodestroy_downloads[cryptex_id] = set()
            self._autodestroy_downloads[cryptex_id].add(entry["name"])

        return FileResponse(
            path=file_path,
            media_type="application/octet-stream",
            filename=entry["name"],
        )

    async def destroy(
        self,
        request: CryptexDestroy,
    ):
        # Validate cryptex ID format to prevent path traversal
        if not CRYPTEX_ID_PATTERN.match(request.id):
            raise HTTPException(400, "Invalid cryptex ID format")
        
        # Hash password if provided
        password = None
        if request.password:
            password = utils.hash_password(request.password)
        await db.verify_cryptex(request.id, password)
        
        # Delete from database
        await db.delete_cryptex(request.id)
        
        # Delete folder from disk
        cryptex_dir = self.FILES_DIR / request.id
        if cryptex_dir.exists():
            shutil.rmtree(cryptex_dir)
        
        # Clean up autodestroy tracking
        self._autodestroy_downloads.pop(request.id, None)
        
        return {"message": "Cryptex destroyed successfully", "id": request.id}
