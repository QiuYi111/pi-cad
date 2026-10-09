"""Identity commands: bind declarations to a STEP, and list/resolve/verify names."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from ..common import emit, sha256_file, write_json
from .envelope import elapsed_ms, fail, hash_or_empty


def cmd_bind_identity(args: argparse.Namespace) -> int:
    from ..identity import IdentityError
    from ..identity.bind import bind_identity

    started = time.monotonic()
    artifact = Path(args.artifact)
    declarations = Path(args.declarations)
    input_hashes = {
        "artifact": hash_or_empty(artifact),
        "declarations": hash_or_empty(declarations),
    }
    try:
        payload = bind_identity(artifact, declarations)
        manifest = Path(payload["identityManifest"])
        emit(
            "cad_bind_identity",
            payload,
            input_hashes=input_hashes,
            artifacts=[{"path": str(manifest), "kind": "identity", "sha256": sha256_file(manifest)}],
            duration_ms=elapsed_ms(started),
        )
    except (IdentityError, OSError, ValueError) as exc:
        failed = exc.details.get("path") if isinstance(exc, IdentityError) else None
        fail(
            "cad_bind_identity",
            exc.message if isinstance(exc, IdentityError) else str(exc),
            started=started,
            input_hashes=input_hashes,
            detail={"code": "IDENTITY_BIND_FAILED", "paths": [failed] if failed else []},
        )
    return 0


def cmd_identity(args: argparse.Namespace) -> int:
    from ..identity import IdentityError, IdentityIndex

    started = time.monotonic()
    artifact = Path(args.artifact)
    tool = f"cad_identity_{args.stage}"
    try:
        index = IdentityIndex(artifact)
        if args.stage == "verify":
            payload = index.verify()
        elif args.stage == "list":
            payload = {
                "source": index.source,
                "artifactHash": index.artifact_hash,
                "verification": index.verify(),
                "entities": [
                    resolution.as_payload()
                    for resolution in index.entities(kind=args.kind, owner=args.owner)
                ],
            }
        else:
            expect = args.expect
            if isinstance(expect, str) and expect.lstrip("-").isdigit():
                expect = int(expect)
            payload = index.resolve(
                args.target,
                kind=args.kind,
                owner=args.owner,
                expect=expect,
            ).as_payload()
        artifacts: list[dict[str, str]] = []
        if args.output:
            write_json(args.output, payload)
            artifacts.append({"path": args.output, "kind": "identity", "sha256": sha256_file(args.output)})
        emit(
            tool,
            payload,
            input_hashes={"artifact": sha256_file(artifact)},
            artifacts=artifacts,
            duration_ms=elapsed_ms(started),
        )
        return 0
    except IdentityError as exc:
        return fail(tool, exc.message, started=started, input_hashes={"artifact": hash_or_empty(artifact)})
    except Exception as exc:
        return fail(tool, str(exc), started=started, input_hashes={"artifact": hash_or_empty(artifact)})
