from __future__ import annotations

import pytest
from conftest import PNG_1x1
from pydantic import ValidationError

from app.payloads import WebhookPayload, has_content, normalize
from app.ratelimit import TokenBucketLimiter
from app.security import (
    hash_password,
    new_public_id,
    new_webhook_secret,
    secret_matches,
    sha256_hex,
    verify_password,
)
from app.storage import LocalStorage
from app.uploads import UploadRejected, sanitize_filename, validate_upload


def test_password_hash_roundtrip():
    h = hash_password("a long password")
    assert h.startswith("scrypt$") and "a long password" not in h
    assert verify_password("a long password", h)
    assert not verify_password("a long passworD", h)
    assert not verify_password("x", "garbage")


def test_webhook_secrets_are_high_entropy_and_compared_by_hash():
    secrets = {new_webhook_secret() for _ in range(200)}
    assert len(secrets) == 200
    s = secrets.pop()
    assert s.startswith("rls_") and len(s) >= 46
    assert secret_matches(s, sha256_hex(s))
    assert not secret_matches(s + "x", sha256_hex(s))
    assert not secret_matches(s, None)
    assert new_public_id().isalnum()


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\cmd.exe", "cmd.exe"),
        ("C:\\Users\\me\\report.pdf", "report.pdf"),
        ("  .hidden  ", "hidden"),
        ("we<ir>d:na|me?.txt", "we_ir_d_na_me_.txt"),
        ("", "file"),
        ("....", "file"),
        ("a\x00b.txt", "a_b.txt"),
    ],
)
def test_sanitize_filename(raw, expected):
    assert sanitize_filename(raw) == expected


def test_sanitize_filename_truncates_but_keeps_extension():
    name = sanitize_filename("x" * 500 + ".png")
    assert len(name) == 120 and name.endswith(".png")


def test_validate_upload_accepts_real_image_and_reads_size():
    f = validate_upload("shot.png", PNG_1x1, 1024)
    assert (f.content_type, f.is_image, f.width, f.height) == ("image/png", True, 1, 1)


def test_validate_upload_infers_extension_from_content():
    assert validate_upload("noext", PNG_1x1, 1024).filename == "noext.png"
    assert validate_upload("notes", b"hello", 1024).filename == "notes.txt"


@pytest.mark.parametrize(
    "name,data,code",
    [
        ("evil.exe", b"MZ\x90\x00", "file_type_blocked"),
        ("report.pdf.exe", b"%PDF-1.4", "file_type_blocked"),
        ("page.html", b"<script>alert(1)</script>", "file_type_blocked"),
        ("logo.svg", b"<svg onload=alert(1)>", "file_type_blocked"),
        ("fake.png", b"%PDF-1.7 not a png", "file_type_mismatch"),
        ("photo.jpg", PNG_1x1, "file_type_mismatch"),
        ("blob.bin", b"\x00\x01\x02\x03", "file_type_unsupported"),
        ("data.txt", b"\x00\x01binary", "file_type_unsupported"),
        ("empty.txt", b"", "empty_file"),
        ("big.txt", b"a" * 2048, "file_too_large"),
    ],
)
def test_validate_upload_rejections(name, data, code):
    with pytest.raises(UploadRejected) as exc:
        validate_upload(name, data, 1024)
    assert exc.value.code == code


def test_office_files_need_zip_container():
    assert validate_upload("sheet.xlsx", b"PK\x03\x04rest", 1024).content_type.endswith("spreadsheetml.sheet")
    with pytest.raises(UploadRejected):
        validate_upload("sheet.xlsx", b"not a zip", 1024)


def test_local_storage_rejects_traversal_keys(tmp_path):
    st = LocalStorage(tmp_path)
    for key in ("../../x", "a" * 31, "A" * 32, "..%2f" * 8):
        with pytest.raises(ValueError):
            st.put(key, b"x", "text/plain")
    key = "ab" * 16
    st.put(key, b"hello", "text/plain")
    assert b"".join(st.open(key)) == b"hello"
    st.delete(key)
    assert not st.exists(key)


def test_token_bucket():
    lim = TokenBucketLimiter(rate_per_minute=60, burst=3)
    assert [lim.hit("k")[0] for _ in range(4)] == [True, True, True, False]
    allowed, retry = lim.hit("k")
    assert not allowed and retry >= 1
    assert lim.hit("other")[0]
    assert not lim.peek("k")


def test_payload_relay_format():
    p = WebhookPayload.model_validate(
        {"title": "Agent Update", "message": "The task has completed successfully.", "status": "success"}
    )
    n = normalize(p)
    assert n["kind"] == "rich" and n["status"] == "success" and n["content"] == ""
    e = n["embeds"][0]
    assert e["title"] == "Agent Update" and e["color"] == "#34d399" and e["description"].startswith("The task")
    assert "the task has completed" in n["search_text"]


def test_payload_discord_compat():
    p = WebhookPayload.model_validate(
        {
            "content": "hi",
            "username": "CI",
            "embeds": [
                {
                    "title": "Build",
                    "color": 16711680,
                    "image": {"url": "https://example.com/a.png"},
                    "footer": {"text": "ft"},
                    "fields": [{"name": "n", "value": 5, "inline": True}],
                }
            ],
        }
    )
    n = normalize(p)
    e = n["embeds"][0]
    assert n["content"] == "hi" and n["username"] == "CI"
    assert e["color"] == "#ff0000" and e["image_url"] == "https://example.com/a.png" and e["footer"] == "ft"
    assert e["fields"][0]["value"] == "5"


def test_payload_json_only_and_status_alias():
    n = normalize(WebhookPayload.model_validate({"data": {"a": [1, 2]}, "level": "warn"}))
    assert n["kind"] == "json" and n["status"] == "warning" and n["data"] == {"a": [1, 2]}


@pytest.mark.parametrize(
    "payload",
    [
        {"message": "x", "url": "javascript:alert(1)"},
        {"message": "x", "image_url": "data:image/png;base64,AAAA"},
        {"message": "x", "color": "red"},
        {"message": "x", "status": "exploded"},
        {"message": "x" * 4001},
        {"message": "x", "fields": [{"name": "n"}] * 26},
        {"message": "x", "timestamp": "yesterday"},
        {"embeds": [{"title": "t"}] * 11},
    ],
)
def test_payload_rejects_bad_fields(payload):
    with pytest.raises(ValidationError):
        WebhookPayload.model_validate(payload)


def test_has_content():
    assert not has_content(WebhookPayload.model_validate({}))
    assert not has_content(WebhookPayload.model_validate({"username": "x", "status": "info"}))
    assert has_content(WebhookPayload.model_validate({"title": "t"}))
    assert has_content(WebhookPayload.model_validate({"data": 0}))
