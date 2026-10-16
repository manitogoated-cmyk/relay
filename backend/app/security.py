"""Credential primitives: password hashing, session tokens, webhook secrets."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

SECRET_PREFIX = "rls_"  # noqa: S105 - a public prefix, not a secret
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, digest_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        salt, expected = base64.b64decode(salt_b64), base64.b64decode(digest_b64)
        digest = hashlib.scrypt(password.encode(), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


# A fixed hash checked when a username doesn't exist, so a failed login costs the same either way.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(16))


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def new_public_id() -> str:
    # 128 bits, URL-safe. Unguessable, though the secret is what actually authenticates.
    return secrets.token_urlsafe(16).replace("-", "x").replace("_", "y")


def new_webhook_secret() -> str:
    # 256 bits of entropy. A plain SHA-256 is enough to store it: it can't be brute-forced.
    return SECRET_PREFIX + secrets.token_urlsafe(32)


def secret_matches(presented: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        # Still do the work so a revoked or unknown webhook answers in the same time.
        hmac.compare_digest(sha256_hex(presented), "0" * 64)
        return False
    return hmac.compare_digest(sha256_hex(presented), stored_hash)


def new_attachment_id() -> str:
    return secrets.token_hex(16)


def new_request_id() -> str:
    return "req_" + secrets.token_hex(10)
