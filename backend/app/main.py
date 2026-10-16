from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .broker import broker
from .config import get_settings
from .db import run_migrations, session_factory
from .deps import ApiError, app_state, current_user, public_base, request_id
from .middleware import BodyTooLarge, RelayMiddleware
from .models import User
from .routers import auth, channels, hooks, ingest, messages, stream
from .services import purge_expired

log = logging.getLogger("relay")
VERSION = "1.0.0"


async def _retention_loop() -> None:
    while True:
        try:
            db = session_factory()()
            try:
                removed = await asyncio.to_thread(purge_expired, db, app_state().storage)
            finally:
                db.close()
            if any(removed.values()):
                log.info("retention purge: %s", removed)
        except Exception:
            log.exception("retention purge failed")
        await asyncio.sleep(3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    problems = s.check_production()
    if problems:
        raise RuntimeError("Refusing to start: " + "; ".join(problems))
    if os.environ.get("RELAY_SKIP_MIGRATIONS") != "1":
        await asyncio.to_thread(run_migrations)
    app_state().storage.check()
    broker.bind(asyncio.get_running_loop())
    task = asyncio.create_task(_retention_loop())
    try:
        yield
    finally:
        task.cancel()
        broker.close_all()


def _error(request: Request, status: int, code: str, message: str, details=None, headers=None) -> JSONResponse:
    body = {"ok": False, "error": {"code": code, "message": message}, "request_id": request_id(request)}
    if details is not None:
        body["error"]["details"] = details
    return JSONResponse(body, status_code=status, headers=headers)


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="Relay",
        version=VERSION,
        lifespan=lifespan,
        docs_url=None if s.is_production else "/api/docs",
        redoc_url=None,
        openapi_url=None if s.is_production else "/api/openapi.json",
    )
    app.add_middleware(RelayMiddleware)

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError):
        return _error(request, exc.status, exc.code, exc.message, exc.details, exc.headers)

    @app.exception_handler(BodyTooLarge)
    async def _too_large(request: Request, exc: BodyTooLarge):
        return _error(request, 413, "payload_too_large", str(exc))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        details = [
            {"field": ".".join(str(p) for p in e.get("loc", ())[1:]) or "body", "message": e.get("msg", "invalid")}
            for e in exc.errors()[:20]
        ]
        return _error(request, 422, "validation_failed", "Some fields are invalid.", details)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _error(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.exception("unhandled error on %s %s (request %s)", request.method, request.url.path, request_id(request))
        return _error(request, 500, "internal_error", "Something went wrong. Quote the request id if you report it.")

    app.include_router(ingest.router)
    app.include_router(auth.router)
    app.include_router(channels.router)
    app.include_router(hooks.router)
    app.include_router(messages.router)
    app.include_router(stream.router)

    @app.get("/api/health", tags=["meta"])
    def health():
        return {"ok": True, "version": VERSION}

    @app.get("/api/app/config", tags=["meta"])
    def config(request: Request, user: User = Depends(current_user)):
        base = public_base(request)
        return {
            "version": VERSION,
            "base_url": base,
            "base_url_configured": bool(s.public_base_url),
            "https": base.startswith("https://"),
            "environment": s.environment,
            "storage": s.storage_backend,
            "limits": {
                "max_json_bytes": s.max_json_bytes,
                "max_upload_bytes": s.max_upload_bytes,
                "max_file_bytes": s.max_file_bytes,
                "max_files": s.max_files,
                "webhook_rate_per_minute": s.webhook_rate_per_minute,
                "webhook_burst": s.webhook_burst,
            },
            "retention": {
                "message_days": s.message_retention_days,
                "delivery_days": s.delivery_retention_days,
                "audit_days": s.audit_retention_days,
                "idempotency_hours": s.idempotency_window_hours,
            },
        }

    dist: Path = s.frontend_dist
    if dist.is_dir():
        index = dist / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            if path.startswith("api/"):
                raise ApiError(404, "not_found", "No such endpoint.")
            candidate = (dist / path).resolve()
            if path and candidate.is_file() and dist.resolve() in candidate.parents:
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                return FileResponse(candidate, headers={"Cache-Control": cache})
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
