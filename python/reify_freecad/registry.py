"""Documents shared between sessions: the parts an assembly links to (imports FreeCAD)."""

from __future__ import annotations

from pathlib import Path
from typing import Any


class SessionRegistry:
    """Finds the open session of a part document, or opens it read-only.

    The worker's own sessions (documents the Agent opened) are authoritative: an
    assembly sees a part exactly as its session holds it. Any other part is
    opened here, and reloaded when its file changes on disk.
    """

    def __init__(self, sessions: dict[str, Any]) -> None:
        self.sessions = sessions
        self.sources: dict[str, Any] = {}

    def get(self, path: Path) -> Any:
        from .session import DocumentSession

        key = str(path)
        if key in self.sessions:
            return self.sessions[key]
        if key not in self.sources:
            session = DocumentSession(path, path.with_suffix(".step"), path.parent / ".reify-source-history", None)
            session.registry = self
            session.open(create=False)
            self.sources[key] = session
        return self.sources[key]

    def source(self, path: Path) -> Any:
        """The session for ``path``, reloaded first when the file changed since it was loaded."""
        session = self.get(path)
        session.reload_if_stale()
        return session

    def adopt(self, path: Path) -> None:
        """The Agent opened ``path`` itself: drop the read-only copy so one session owns the document."""
        source = self.sources.pop(str(path), None)
        if source is not None:
            source.close()

    def close(self) -> None:
        for session in self.sources.values():
            session.close()
        self.sources.clear()
