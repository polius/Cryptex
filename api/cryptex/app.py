"""The FastAPI application: routers under /api/v1, the error model, logging, jobs."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
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

from . import VERSION, db, jobs, mailer, state, storage
from .config import Env, load_env
from .deps import caller
from .errors import ApiError, NotFound

REQUEST_COUNTS: Counter[tuple[str, int]] = Counter()
log = logging.getLogger("cryptex")

CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; "
       "font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
       "form-action 'self'; object-src 'none'")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
                               "level": record.levelname.lower(), "msg": record.getMessage()}
        for k in ("route", "status", "ms", "request_id", "method", "ip"):
            if hasattr(record, k):
                out[k] = getattr(record, k)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False)


def setup_logging(env: Env) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(JsonFormatter() if env.log_format == "json" else logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger("cryptex")
    root.handlers[:] = [h]
    root.setLevel(env.log_level.upper())
    root.propagate = False


def create_app(env: Env | None = None, run_jobs: bool = True) -> FastAPI:
    env = env or load_env()
    setup_logging(env)
    state.init(env)
    db.configure(env.data_dir / "cryptex.db")
    storage.init(storage.LocalStorage(env.data_dir / "chunks"))
    os.makedirs(env.data_dir / "brand", exist_ok=True)
    if state.setup_needed():
        log.warning("Setup needed. Open the server in a browser and enter this setup code: %s", env.setup_code)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(jobs.loop()) if run_jobs else None
        yield
        if task:
            task.cancel()
        mailer.flush(5)

    app = FastAPI(title="Cryptex", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    from .routes import auth, config, receipts, requests, server, setup, tokens
    from .routes import secrets as secrets_routes
    for r in (config.router, secrets_routes.router, receipts.router, requests.router, auth.router, setup.router,
              server.router, tokens.router):
        app.include_router(r, prefix="/api/v1", dependencies=[Depends(caller)])  # auth errors before body validation

    @app.exception_handler(ApiError)
    async def api_error(_: Request, e: ApiError) -> Response:
        return e.response()

    @app.exception_handler(RequestValidationError)
    async def validation(_: Request, e: RequestValidationError) -> Response:
        err = e.errors()[0] if e.errors() else {}
        loc = ".".join(str(x) for x in err.get("loc", ())[1:]) or "body"
        return ApiError("invalid", f"{loc}: {err.get('msg', 'invalid')}", field=loc).response()

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, e: StarletteHTTPException) -> Response:
        if e.status_code in (404, 405):
            if env.static_dir and not request.url.path.startswith("/api/") and request.method == "GET":
                return _spa(env.static_dir, request.url.path)
            return NotFound().response()
        return ApiError("invalid", str(e.detail), status=e.status_code).response()

    @app.exception_handler(Exception)
    async def crash(_: Request, e: Exception) -> Response:
        log.exception("unhandled error")
        return ApiError("internal").response()

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
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        if env.demo:
            response.headers["X-Robots-Tag"] = "noindex, nofollow"
        extra = {"route": route, "status": response.status_code, "ms": ms, "request_id": rid, "method": request.method}
        if env.log_ips and request.client:
            extra["ip"] = request.client.host
        log.info("request", extra=extra)
        return response

    if env.static_dir:
        static = env.static_dir

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str) -> Response:
            return _spa(static, "/" + path)

    return app


def _spa(static: Path, path: str) -> Response:
    """Serve built front-end files, falling back to index.html for app routes."""
    rel = path.lstrip("/")
    target = (static / rel).resolve()
    headers = {"Content-Security-Policy": CSP, "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
               "Permissions-Policy": "camera=(), microphone=(), geolocation=()"}
    if rel and target.is_file() and static.resolve() in target.parents:
        if rel.startswith("assets/"):
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return FileResponse(target, headers=headers)
    if rel.startswith("api/"):
        return NotFound().response()
    headers["Cache-Control"] = "no-cache"
    return FileResponse(static / "index.html", headers=headers, media_type="text/html")
