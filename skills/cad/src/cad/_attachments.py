from __future__ import annotations

"""Prime kernel attachment helpers shared by managed CAD operations."""

import base64
from typing import Any


_ATTACHMENT_DISPLAY_MIME = "application/vnd.prime-agent.attachment+json"


def display_inline_image(image: dict[str, Any], *, label: str) -> None:
    """Emit an inline image through Prime's attachment channel, not generic rich display."""
    mime_type = image.get("mimeType") or image.get("mime_type")
    data = image.get("data")
    if mime_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"} or not isinstance(data, str) or not data:
        raise ValueError("managed image is not a supported inline image")
    base64.b64decode(data, validate=True)
    from IPython.display import display

    payload = {"mime_type": mime_type, "data": data}
    if isinstance(image.get("path"), str):
        payload["path"] = image["path"]
    display({_ATTACHMENT_DISPLAY_MIME: payload, "text/plain": label}, raw=True)
