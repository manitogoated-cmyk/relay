"""Upload validation. The client's filename and Content-Type are hints only: the type is decided from
the bytes, and the extension has to agree with it."""

from __future__ import annotations

import os
import re
import struct
import unicodedata
from dataclasses import dataclass


class UploadRejected(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class FileType:
    content_type: str
    extensions: tuple[str, ...]
    is_image: bool = False


PNG = FileType("image/png", (".png",), True)
JPEG = FileType("image/jpeg", (".jpg", ".jpeg"), True)
GIF = FileType("image/gif", (".gif",), True)
WEBP = FileType("image/webp", (".webp",), True)
PDF = FileType("application/pdf", (".pdf",))
ZIP = FileType("application/zip", (".zip",))
DOCX = FileType("application/vnd.openxmlformats-officedocument.wordprocessingml.document", (".docx",))
XLSX = FileType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", (".xlsx",))
PPTX = FileType("application/vnd.openxmlformats-officedocument.presentationml.presentation", (".pptx",))
GZIP = FileType("application/gzip", (".gz", ".tgz"))
TEXT_TYPES = {
    ".txt": "text/plain",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".json": "application/json",
    ".ndjson": "application/x-ndjson",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
}

# Rejected by name with a clear message. Anything not in the allow-list is rejected anyway.
DANGEROUS_EXTENSIONS = {
    ".exe",
    ".dll",
    ".com",
    ".bat",
    ".cmd",
    ".msi",
    ".msp",
    ".scr",
    ".pif",
    ".cpl",
    ".ps1",
    ".psm1",
    ".vbs",
    ".vbe",
    ".js",
    ".mjs",
    ".jse",
    ".wsf",
    ".wsh",
    ".hta",
    ".jar",
    ".sh",
    ".bash",
    ".app",
    ".html",
    ".htm",
    ".xhtml",
    ".svg",
    ".svgz",
    ".xml",
    ".php",
    ".asp",
    ".aspx",
    ".jsp",
    ".py",
    ".lnk",
    ".reg",
    ".iso",
    ".dmg",
    ".apk",
    ".deb",
    ".rpm",
}

_UNSAFE_CHARS = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')


def sanitize_filename(raw: str | None, max_len: int = 120) -> str:
    name = unicodedata.normalize("NFC", raw or "")
    # Keep only the last path component, whichever separator the client used.
    name = re.split(r"[\\/]", name)[-1]
    name = _UNSAFE_CHARS.sub("_", name)
    name = name.strip().lstrip(".").strip()
    name = re.sub(r"\s+", " ", name)
    if not name or set(name) <= {"_", " ", "."}:
        name = "file"
    stem, ext = os.path.splitext(name)
    if len(name) > max_len:
        ext = ext[:16]
        name = stem[: max_len - len(ext)] + ext
    return name


def _sniff_binary(head: bytes) -> FileType | None:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if head.startswith(b"\xff\xd8\xff"):
        return JPEG
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return GIF
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return WEBP
    if head.startswith(b"%PDF-"):
        return PDF
    if head.startswith(b"PK\x03\x04"):
        return ZIP
    if head.startswith(b"\x1f\x8b"):
        return GZIP
    return None


def _looks_like_text(data: bytes) -> bool:
    if b"\x00" in data:
        return False
    try:
        data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return False
    return True


def image_size(ft: FileType, data: bytes) -> tuple[int | None, int | None]:
    """Best-effort pixel dimensions from the header, so the feed can reserve space before loading."""
    try:
        if ft is PNG and len(data) >= 24:
            w, h = struct.unpack(">II", data[16:24])
            return w, h
        if ft is GIF and len(data) >= 10:
            w, h = struct.unpack("<HH", data[6:10])
            return w, h
        if ft is WEBP and len(data) >= 30:
            chunk = data[12:16]
            if chunk == b"VP8X":
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
                return w, h
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if chunk == b"VP8L":
                b = data[21:25]
                w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                return w, h
        if ft is JPEG:
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                    return w, h
                seg_len = struct.unpack(">H", data[i + 2 : i + 4])[0]
                i += 2 + seg_len
    except (struct.error, IndexError):
        pass
    return None, None


@dataclass
class ValidatedFile:
    filename: str
    content_type: str
    is_image: bool
    width: int | None
    height: int | None


def validate_upload(raw_filename: str | None, data: bytes, max_bytes: int) -> ValidatedFile:
    if not data:
        raise UploadRejected("empty_file", "Uploaded file is empty.")
    if len(data) > max_bytes:
        raise UploadRejected("file_too_large", f"Each file must be at most {max_bytes // (1024 * 1024)} MB.")

    filename = sanitize_filename(raw_filename)
    stem, ext = os.path.splitext(filename)
    ext = ext.lower()
    if ext in DANGEROUS_EXTENSIONS:
        raise UploadRejected("file_type_blocked", f"Files of type {ext} are not accepted.")

    sniffed = _sniff_binary(data[:32])
    if sniffed is ZIP and ext in (".docx", ".xlsx", ".pptx"):
        sniffed = {".docx": DOCX, ".xlsx": XLSX, ".pptx": PPTX}[ext]

    if sniffed is not None:
        if not ext:
            filename, ext = filename + sniffed.extensions[0], sniffed.extensions[0]
        if ext not in sniffed.extensions:
            raise UploadRejected(
                "file_type_mismatch", f"The file's contents are {sniffed.content_type}, which doesn't match {ext}."
            )
        w, h = image_size(sniffed, data) if sniffed.is_image else (None, None)
        return ValidatedFile(filename, sniffed.content_type, sniffed.is_image, w, h)

    if ext in TEXT_TYPES or not ext:
        if not _looks_like_text(data):
            raise UploadRejected("file_type_unsupported", "Unrecognised binary file type.")
        if not ext:
            filename, ext = filename + ".txt", ".txt"
        return ValidatedFile(filename, TEXT_TYPES[ext], False, None, None)

    raise UploadRejected(
        "file_type_unsupported",
        "Supported files: PNG, JPEG, GIF, WebP, PDF, ZIP, GZIP, DOCX, XLSX, PPTX and UTF-8 text "
        "(.txt .log .md .csv .tsv .json .ndjson .yaml).",
    )
