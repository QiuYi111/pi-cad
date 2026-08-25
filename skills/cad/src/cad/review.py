from __future__ import annotations

import re
from typing import Any

from .client import request


def _commit_id(commit: Any) -> str:
    value = getattr(commit, "id", commit)
    if not isinstance(value, str) or not re.fullmatch(r"commit-[a-f0-9]{32}", value):
        raise TypeError("cad.review.submit requires a Commit or commit ID")
    return value


def _review_id(handle: Any) -> str:
    value = handle.get("reviewId") if isinstance(handle, dict) else handle
    if not isinstance(value, str) or not re.fullmatch(r"review-[a-f0-9]{24}", value):
        raise TypeError("cad.review.current requires a review handle or review ID")
    return value


async def submit(final_commit: Any) -> dict[str, Any]:
    """Admit one idempotent Fresh Reviewer and return immediately."""
    return await request("review-submit", subjectCommit=_commit_id(final_commit))


async def current(handle: Any) -> dict[str, Any] | None:
    return await request("review-current", reviewId=_review_id(handle))


async def resolve(review_id: str, *, verdict: str, summary: str, findings: list[dict[str, Any]]) -> dict[str, Any]:
    """Reviewer-scoped terminal result submission; authors are rejected."""
    if verdict not in {"pass", "fail", "unresolved"}:
        raise ValueError("verdict must be pass, fail, or unresolved")
    return await request("review-complete", reviewId=_review_id(review_id), result={
        "verdict": verdict, "summary": summary, "findings": findings,
    })
