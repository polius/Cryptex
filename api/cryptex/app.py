"""The FastAPI application: routers under /api/v1, the error model, logging, jobs."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import sys
import time
from collections import Counter
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import VERSION, db, jobs, ratelimit, security, state, storage
from .config import Env, load_env
from .deps import caller
from .errors import ApiError, NotFound

REQUEST_COUNTS: Counter[tuple[str, int]] = Counter()
log = logging.getLogger("cryptex")

CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; "
       "font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
       "form-action 'self'; object-src 'none'")
# On every response: pages, files, API answers and errors. A response that sets its own (the logo's CSP) keeps it.
HEADERS = {"Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
           "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
           "Cross-Origin-Opener-Policy": "same-origin"}
MAX_BODY = 1024 * 1024  # any request body; encrypted chunks (5 MiB + 16) are capped by their route (read_body)
CHUNK_UPLOAD = re.compile(r"^/api/v1/secrets/[^/]+/chunks/")
ICONS = {"favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "og-image.png"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
                               "level": record.levelname.lower(), "msg": record.getMessage()}
        for k in ("route", "status", "ms", "request_id", "method", "ip", "event", "event_id", "secret_id", "actor", "user_id", "detail"):
            if hasattr(record, k):
                out[k] = getattr(record, k)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False)


def friendly(err: dict[str, Any]) -> str:
    """Pydantic's messages are for developers; people see these."""
    kind = err.get("type", "")
    ctx = err.get("ctx") or {}
    if err.get("loc") and err["loc"][-1] == "username" and kind != "missing":
        return "Use 2 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number."
    if kind == "missing":
        return "This is required."
    if kind == "string_too_short":
        return f"Use at least {ctx.get('min_length', 1)} characters."
    if kind == "string_too_long":
        return f"Use at most {ctx.get('max_length')} characters."
    if kind in ("greater_than_equal", "greater_than"):
        return f"Use {ctx.get('ge', ctx.get('gt'))} or more."
    if kind in ("less_than_equal", "less_than"):
        return f"Use {ctx.get('le', ctx.get('lt'))} or less."
    if kind == "string_pattern_mismatch":
        return "That doesn’t look right. Check the format."
    return "Check this value."


def setup_logging(env: Env) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter() if env.log_format == "json" else logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger("cryptex")
    root.handlers[:] = [h]
    root.setLevel(env.log_level.upper())
    root.propagate = False


def create_app(env: Env | None = None, run_jobs: bool = True) -> FastAPI:
    if env is None:
        try:
            env = load_env()
        except ValueError as err:  # a setting or the key: say what, without a traceback
            sys.exit(f"cryptex: {err}")
    setup_logging(env)
    state.init(env)
    db.configure(env.data_dir / "cryptex.db")
    security.check_canary()  # refuses to start with another enc.key than the one the database was set up with
    storage.init(storage.LocalStorage(env.data_dir / "chunks"))
    os.makedirs(env.data_dir / "brand", exist_ok=True)
    if state.owner_exists():
        state.forget_setup_code()
    elif state.setup_needed():
        log.warning("Setup needed. Open the server in a browser and enter this setup code: %s (show it again with: cryptex setup-code)",
                    state.setup_code())

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(jobs.loop()) if run_jobs else None
        yield
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        db.close_all()  # checkpoint the WAL into cryptex.db and close, so a stopped server leaves one file

    app = FastAPI(title="Cryptex", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    from .routes import auth, config, receipts, requests, server, setup, vault
    from .routes import secrets as secrets_routes
    for r in (config.router, secrets_routes.router, receipts.router, requests.router, auth.router, setup.router,
              server.router, vault.router):
        app.include_router(r, prefix="/api/v1", dependencies=[Depends(caller)])  # auth errors before body validation

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError) -> Response:
        return e.response()

    @app.exception_handler(RequestValidationError)
    async def validation(_: Request, e: RequestValidationError) -> Response:
        err = e.errors()[0] if e.errors() else {}
        loc = ".".join(str(x) for x in err.get("loc", ())[1:]) or "body"
        return ApiError("invalid", friendly(err), field=loc).response()

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, e: StarletteHTTPException) -> Response:
        if e.status_code == 413:
            return ApiError("too_large", limit=MAX_BODY).response()
        if e.status_code in (404, 405):
            if env.static_dir and not request.url.path.startswith("/api/") and request.method in ("GET", "HEAD"):
                return _spa(env.static_dir, request.url.path)
            return NotFound().response()
        return ApiError("invalid", str(e.detail), status=e.status_code).response()

    @app.exception_handler(Exception)
    async def crash(_: Request, e: Exception) -> Response:
        log.exception("unhandled error")
        return ApiError("internal").response()

    app.add_middleware(BodyLimit)  # inside observe (added after it), so a 413 gets the headers too

    @app.middleware("http")
    async def observe(request: Request, call_next: Any) -> Response:
        rid = request.headers.get("x-request-id") or secrets.token_hex(8)
        t0 = time.perf_counter()
        try:
            response: Response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"request_id": rid})
            response = ApiError("internal").response()
        route = getattr(request.scope.get("route"), "path", None) or ("/api/*" if request.url.path.startswith("/api/") else "static")
        ms = round((time.perf_counter() - t0) * 1000, 1)
        REQUEST_COUNTS[(route, response.status_code)] += 1
        response.headers["X-Request-Id"] = rid
        for k, v in HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if request.url.scheme == "https":  # the scheme uvicorn took from a trusted proxy
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        if env.demo:
            response.headers["X-Robots-Tag"] = "noindex, nofollow"
        extra = {"route": route, "status": response.status_code, "ms": ms, "request_id": rid, "method": request.method}
        if env.log_ips:
            extra["ip"] = ratelimit.client_ip(request)
        log.info("request", extra=extra)
        return response

    if env.static_dir:
        static = env.static_dir

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> Response:
            return _spa(static, "/" + path)

    return app


class BodyLimit:
    """Request bodies over MAX_BODY end in a 413, whether or not they declare their length (chunked uploads)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or CHUNK_UPLOAD.match(scope["path"]):
            return await self.app(scope, receive, send)
        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            seen += len(message.get("body", b""))
            if seen > MAX_BODY:
                raise StarletteHTTPException(413)  # becomes too_large (http_error)
            return message
        await self.app(scope, counted, send)


def _spa(static: Path, path: str) -> Response:
    """Serve built front-end files, falling back to index.html for app routes. Dotfiles (Vite's .vite/) are never
    served, and a missing asset is a 404, not the app. A "." or ".." segment (an encoded /s/..%2Fx) is only ever answered
    with the app, which shows its own not-found page: the file check below keeps it inside the static folder."""
    rel = path.lstrip("/")
    target = (static / rel).resolve()
    if any(part.startswith(".") and part not in (".", "..") for part in rel.split("/")):
        return NotFound().response()
    if rel and target.is_file() and static.resolve() in target.parents:
        cache = ("public, max-age=31536000, immutable" if rel.startswith("assets/")  # content-hashed
                 else "public, max-age=86400" if rel in ICONS else "no-cache")  # index.html, theme.js, the manifest
        return FileResponse(target, headers={"Cache-Control": cache})
    if rel.startswith(("api/", "assets/")):
        return NotFound().response()
    return FileResponse(static / "index.html", headers={"Cache-Control": "no-cache"}, media_type="text/html")
