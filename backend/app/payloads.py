"""The webhook payload format and its normalisation into a stored message.

Relay's own fields (message/title/status/fields...) are accepted alongside Discord-style
`content` + `embeds`, so scripts that already post to Discord work by changing only the URL and header.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

STATUSES = ("info", "success", "warning", "error")
_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")
MAX_DATA_JSON = 64 * 1024


def _url(v: Any) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, dict):  # Discord style {"url": ...}
        v = v.get("url")
        if v is None:
            return None
    if not isinstance(v, str) or len(v) > 2048:
        raise ValueError("must be a URL string of at most 2048 characters")
    v = v.strip()
    if not re.match(r"^https?://[^\s/$.?#][^\s]*$", v, re.IGNORECASE):
        raise ValueError("must be an http:// or https:// URL")
    return v


def _color(v: Any) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        raise ValueError("must be a #rrggbb string or an integer")
    if isinstance(v, int):
        if not 0 <= v <= 0xFFFFFF:
            raise ValueError("integer colour must be between 0 and 16777215")
        return f"#{v:06x}"
    if isinstance(v, str) and (m := _HEX.match(v.strip())):
        return "#" + m.group(1).lower()
    raise ValueError("must be a #rrggbb string or an integer")


def _timestamp(v: Any) -> str | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        seconds = v / 1000 if v > 1e11 else v
        return datetime.fromtimestamp(seconds, UTC).isoformat().replace("+00:00", "Z")
    if isinstance(v, str):
        try:
            dt = datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("must be an ISO 8601 timestamp or a Unix time") from exc
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")
    raise ValueError("must be an ISO 8601 timestamp or a Unix time")


Str80 = Annotated[str, Field(max_length=80)]


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)


class EmbedField(_Model):
    name: Annotated[str, Field(min_length=1, max_length=256)]
    value: Annotated[str, Field(max_length=1024)] = ""
    inline: bool = False

    @field_validator("value", mode="before")
    @classmethod
    def _stringify(cls, v: Any) -> Any:
        if isinstance(v, (int, float, bool)):
            return json.dumps(v)
        return "" if v is None else v


class EmbedAuthor(_Model):
    name: Annotated[str, Field(max_length=256)] = ""
    url: str | None = None
    icon_url: str | None = None

    @field_validator("url", "icon_url", mode="before")
    @classmethod
    def check_urls(cls, v: Any) -> str | None:
        return _url(v)


class Embed(_Model):
    title: Annotated[str, Field(max_length=256)] = ""
    description: Annotated[str, Field(max_length=4096)] = ""
    url: str | None = None
    color: str | None = None
    timestamp: str | None = None
    fields: Annotated[list[EmbedField], Field(max_length=25)] = []
    image_url: str | None = None
    thumbnail_url: str | None = None
    footer: Annotated[str, Field(max_length=2048)] = ""
    author: EmbedAuthor | None = None

    @model_validator(mode="before")
    @classmethod
    def _discord_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            data = dict(data)
            for src, dst in (("image", "image_url"), ("thumbnail", "thumbnail_url")):
                if src in data and dst not in data:
                    data[dst] = data.pop(src)
            if isinstance(data.get("footer"), dict):
                data["footer"] = data["footer"].get("text", "")
            if isinstance(data.get("author"), str):
                data["author"] = {"name": data["author"]}
        return data

    @field_validator("url", "image_url", "thumbnail_url", mode="before")
    @classmethod
    def check_urls(cls, v: Any) -> str | None:
        return _url(v)

    @field_validator("color", mode="before")
    @classmethod
    def check_color(cls, v: Any) -> str | None:
        return _color(v)

    @field_validator("timestamp", mode="before")
    @classmethod
    def check_timestamp(cls, v: Any) -> str | None:
        return _timestamp(v)

    def is_empty(self) -> bool:
        return not (self.title or self.description or self.fields or self.image_url or self.thumbnail_url)


class WebhookPayload(_Model):
    message: Annotated[str, Field(max_length=4000)] = ""
    title: Annotated[str, Field(max_length=256)] = ""
    description: Annotated[str, Field(max_length=4096)] = ""
    status: Literal["info", "success", "warning", "error"] | None = None
    url: str | None = None
    color: str | None = None
    timestamp: str | None = None
    fields: Annotated[list[EmbedField], Field(max_length=25)] = []
    image_url: str | None = None
    thumbnail_url: str | None = None
    footer: Annotated[str, Field(max_length=2048)] = ""
    username: Str80 = ""
    avatar_url: str | None = None
    embeds: Annotated[list[Embed], Field(max_length=10)] = []
    data: Any = None
    tags: Annotated[list[Annotated[str, Field(min_length=1, max_length=32)]], Field(max_length=10)] = []

    @model_validator(mode="before")
    @classmethod
    def _aliases(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            raise ValueError("payload must be a JSON object")
        data = dict(data)
        for alias in ("content", "text"):
            if alias in data and "message" not in data:
                data["message"] = data.pop(alias)
        if "json" in data and "data" not in data:
            data["data"] = data.pop("json")
        if "level" in data and "status" not in data:
            data["status"] = data.pop("level")
        if isinstance(data.get("status"), str):
            s = data["status"].strip().lower()
            data["status"] = {
                "ok": "success",
                "warn": "warning",
                "err": "error",
                "fail": "error",
                "failed": "error",
                "failure": "error",
                "critical": "error",
                "debug": "info",
                "notice": "info",
            }.get(s, s)
        for src, dst in (("image", "image_url"), ("thumbnail", "thumbnail_url")):
            if src in data and dst not in data:
                data[dst] = data.pop(src)
        if isinstance(data.get("footer"), dict):
            data["footer"] = data["footer"].get("text", "")
        return data

    @field_validator("url", "image_url", "thumbnail_url", "avatar_url", mode="before")
    @classmethod
    def check_urls(cls, v: Any) -> str | None:
        return _url(v)

    @field_validator("color", mode="before")
    @classmethod
    def check_color(cls, v: Any) -> str | None:
        return _color(v)

    @field_validator("timestamp", mode="before")
    @classmethod
    def check_timestamp(cls, v: Any) -> str | None:
        return _timestamp(v)

    @field_validator("data")
    @classmethod
    def _data_size(cls, v: Any) -> Any:
        if v is not None and len(json.dumps(v, ensure_ascii=False)) > MAX_DATA_JSON:
            raise ValueError(f"must serialise to at most {MAX_DATA_JSON // 1024} KB of JSON")
        return v


STATUS_COLORS = {"info": "#60a5fa", "success": "#34d399", "warning": "#fbbf24", "error": "#f87171"}


def normalize(p: WebhookPayload) -> dict[str, Any]:
    """Turn a validated payload into the stored message fields."""
    embeds = [e for e in p.embeds if not e.is_empty()]
    content = p.message
    description = p.description
    # The short form {"title", "message"} reads best as one card: the message becomes its body.
    if p.title and not description and content and len(content) <= 4096:
        description, content = content, ""
    top_level = Embed(
        title=p.title,
        description=description,
        url=p.url,
        color=p.color,
        timestamp=p.timestamp,
        fields=p.fields,
        image_url=p.image_url,
        thumbnail_url=p.thumbnail_url,
        footer=p.footer,
    )
    if not top_level.is_empty():
        embeds.insert(0, top_level)
    elif top_level.footer and embeds:
        embeds[0].footer = embeds[0].footer or top_level.footer

    stored = []
    for e in embeds[:10]:
        d = e.model_dump(exclude_none=True)
        if not d.get("color") and p.status:
            d["color"] = STATUS_COLORS[p.status]
        stored.append(d)

    if stored:
        kind = "rich"
    elif p.data is not None and not content:
        kind = "json"
    else:
        kind = "text"

    parts = [content, *p.tags]
    for e in stored:
        parts += [e.get("title", ""), e.get("description", ""), e.get("footer", "")]
        parts += [f"{f['name']} {f['value']}" for f in e.get("fields", [])]
    if p.data is not None:
        parts.append(json.dumps(p.data, ensure_ascii=False)[:4000])

    return {
        "kind": kind,
        "status": p.status,
        "content": content,
        "embeds": stored,
        "data": p.data,
        "tags": p.tags,
        "username": p.username,
        "avatar_url": p.avatar_url,
        "search_text": "\n".join(x for x in parts if x).lower()[:20000],
    }


def has_content(p: WebhookPayload) -> bool:
    return (
        bool(p.message or p.data is not None or any(not e.is_empty() for e in p.embeds))
        or not Embed(
            title=p.title,
            description=p.description,
            fields=p.fields,
            image_url=p.image_url,
            thumbnail_url=p.thumbnail_url,
        ).is_empty()
    )


def format_validation_errors(exc) -> list[dict[str, str]]:
    out = []
    for err in exc.errors()[:20]:
        loc = ".".join(str(x) for x in err.get("loc", ()) if x != "__root__")
        msg = err.get("msg", "invalid").removeprefix("Value error, ")
        out.append({"field": loc or "body", "message": msg})
    return out
