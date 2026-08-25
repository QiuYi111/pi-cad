from __future__ import annotations

import re
from typing import Any


def _commit_id(commit: Any) -> str:
    value = getattr(commit, "id", commit)
    if not isinstance(value, str) or not re.fullmatch(r"commit-[a-f0-9]{32}", value):
        raise TypeError("cad.review.submit requires a Commit or commit ID")
    return value


def _review_prompt(commit_id: str) -> str:
    return f"""You are the Fresh Reviewer for Pi-CAD Plan C.

Review exactly the immutable handoff commit {commit_id}. Start with:

    import cad
    subject = await cad.load({commit_id!r})

Treat the commit variables, artifact hashes, workflow snapshot, and referenced
evidence as the review package. Do not request or rely on the author Agent's
transcript, hidden Python variables, or conclusions. Use task-specific Python
checks and the controlled @cad.probe(subject=subject.artifacts[...]) primitive
when geometry inspection is needed; there is no cad.verify.

Return a verdict of pass, fail, or unresolved with concise findings and exact
evidence/artifact references. Freeze the independent result with cad.commit,
including subject_commit={commit_id!r}, verdict, summary, and findings, then
send the resulting review commit ID to the parent with agent_message. A PASS
requires affirmative evidence; missing evidence is unresolved.
"""


async def submit(commit: Any) -> Any:
    """Spawn the normal Prime RLM Fresh Reviewer template.

    Prime owns the child session and lifecycle. The returned value is Prime's
    ordinary admission handle; review delivery happens by commit ID/message.
    """
    commit_id = _commit_id(commit)
    try:
        from rlm import run
    except ImportError as error:
        raise RuntimeError("cad.review.submit is available inside a Prime Agent kernel") from error
    return await run(_review_prompt(commit_id))
