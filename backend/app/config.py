"""Runtime configuration. Every value can be set with a RELAY_* environment variable or in the repo-root .env file."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="RELAY_",
        env_file=REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "production", "test"] = "development"

    # Public origin used to build webhook URLs, e.g. https://relay.example.com.
    # Left empty, the origin of the dashboard request is used (fine for local development only).
    public_base_url: str = ""

    database_url: str = f"sqlite:///{(REPO_ROOT / 'data' / 'relay.db').as_posix()}"

    # Attachment storage: "local" (a private directory outside the web root) or "s3" (any S3-compatible bucket).
    storage_backend: Literal["local", "s3"] = "local"
    storage_dir: Path = REPO_ROOT / "data" / "uploads"
    s3_bucket: str = ""
    s3_prefix: str = "relay/"
    s3_region: str = ""
    s3_endpoint_url: str = ""

    # Request limits for the public webhook endpoint.
    max_json_bytes: int = 256 * 1024
    max_upload_bytes: int = 25 * 1024 * 1024
    max_file_bytes: int = 10 * 1024 * 1024
    max_files: int = 10

    # Rate limits (token buckets): sustained requests per minute plus a burst allowance.
    webhook_rate_per_minute: int = 120
    webhook_burst: int = 30
    ip_rate_per_minute: int = 600
    ip_burst: int = 60
    auth_failures_per_minute: int = 20
    login_attempts_per_5min: int = 10

    # Retention in days; 0 keeps forever. Pinned messages are never purged automatically.
    message_retention_days: int = 90
    delivery_retention_days: int = 30
    audit_retention_days: int = 365
    idempotency_window_hours: int = 24

    # First-run account setup in the browser. Without a token it is only offered to requests from this
    # machine; set a token to allow it remotely (or create the account with `python -m app.cli create-user`).
    setup_token: str = ""

    session_days: int = 14
    cookie_secure: bool | None = None  # None: secure in production, not in development
    require_https: bool | None = None  # None: required in production

    frontend_dist: Path = REPO_ROOT / "frontend" / "dist"

    @field_validator("public_base_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if v and not (v.startswith("http://") or v.startswith("https://")):
            raise ValueError("RELAY_PUBLIC_BASE_URL must start with http:// or https://")
        return v

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def secure_cookies(self) -> bool:
        return self.is_production if self.cookie_secure is None else self.cookie_secure

    @property
    def https_required(self) -> bool:
        return self.is_production if self.require_https is None else self.require_https

    def check_production(self) -> list[str]:
        """Problems that make a production deployment unsafe; startup refuses to run with any of them."""
        problems = []
        if not self.is_production:
            return problems
        if not self.public_base_url.startswith("https://"):
            problems.append("RELAY_PUBLIC_BASE_URL must be set to your https:// origin in production")
        if self.storage_backend == "s3" and not self.s3_bucket:
            problems.append("RELAY_S3_BUCKET is required when RELAY_STORAGE_BACKEND=s3")
        return problems


@lru_cache
def get_settings() -> Settings:
    return Settings()
