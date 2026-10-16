"""Attachment storage. Keys are server-generated hex ids, never client filenames."""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path
from typing import Protocol

from .config import Settings

_KEY_RE = re.compile(r"^[0-9a-f]{32}$")


def _check_key(key: str) -> str:
    if not _KEY_RE.fullmatch(key):
        raise ValueError("invalid storage key")
    return key


class Storage(Protocol):
    name: str

    def put(self, key: str, data: bytes, content_type: str) -> None: ...
    def open(self, key: str) -> Iterator[bytes]: ...
    def delete(self, key: str) -> None: ...
    def check(self) -> None: ...


class LocalStorage:
    name = "local"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def _path(self, key: str) -> Path:
        _check_key(key)
        path = (self.root / key[:2] / key).resolve()
        if self.root not in path.parents:
            raise ValueError("storage path escapes root")
        return path

    def put(self, key: str, data: bytes, content_type: str) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(path)

    def open(self, key: str) -> Iterator[bytes]:
        path = self._path(key)
        with path.open("rb") as fh:
            while chunk := fh.read(64 * 1024):
                yield chunk

    def exists(self, key: str) -> bool:
        return self._path(key).exists()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def check(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        probe = self.root / ".write-test"
        probe.write_bytes(b"ok")
        probe.unlink()


class S3Storage:
    """Any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO). Objects stay private;
    the dashboard streams them through the authenticated attachment endpoint."""

    name = "s3"

    def __init__(self, settings: Settings) -> None:
        try:
            import boto3  # noqa: PLC0415
        except ImportError as exc:  # pragma: no cover - depends on optional install
            raise RuntimeError(
                "RELAY_STORAGE_BACKEND=s3 needs boto3: pip install -r backend/requirements-s3.txt"
            ) from exc
        kwargs = {}
        if settings.s3_region:
            kwargs["region_name"] = settings.s3_region
        if settings.s3_endpoint_url:
            kwargs["endpoint_url"] = settings.s3_endpoint_url
        self.client = boto3.client("s3", **kwargs)
        self.bucket = settings.s3_bucket
        self.prefix = settings.s3_prefix

    def _key(self, key: str) -> str:
        return f"{self.prefix}{_check_key(key)}"

    def put(self, key: str, data: bytes, content_type: str) -> None:
        self.client.put_object(
            Bucket=self.bucket, Key=self._key(key), Body=data, ContentType="application/octet-stream"
        )

    def open(self, key: str) -> Iterator[bytes]:
        body = self.client.get_object(Bucket=self.bucket, Key=self._key(key))["Body"]
        yield from body.iter_chunks(64 * 1024)

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._key(key))

    def check(self) -> None:
        self.client.head_bucket(Bucket=self.bucket)


def build_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "s3":
        return S3Storage(settings)
    return LocalStorage(settings.storage_dir)
