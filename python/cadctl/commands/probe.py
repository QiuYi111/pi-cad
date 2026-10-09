"""``cadctl probe``: run user probe code on a disposable STEP copy."""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from ..common import emit, sha256_file
from .envelope import elapsed_ms, fail, hash_or_empty


def _parameters_hash(parameters: Any) -> str:
    return hashlib.sha256(json.dumps(parameters, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def cmd_probe(args: argparse.Namespace) -> int:
    from ..identity.manifest import identity_path
    from ..probe import ProbeError, run_probe

    started = time.monotonic()
    artifact = Path(args.artifact)
    identity_manifest = identity_path(artifact)
    identity_hash = sha256_file(identity_manifest) if identity_manifest.is_file() else "absent"
    try:
        code = Path(args.code_file).read_text(encoding="utf-8")
    except OSError as exc:
        return fail(
            "cad_probe_python",
            f"cannot read probe code: {exc}",
            started=started,
            input_hashes={"artifact": hash_or_empty(artifact)},
            exit_code=1,
        )
    try:
        parameters = json.loads(args.params_json) if args.params_json else {}
        if not isinstance(parameters, dict):
            raise ProbeError("probe params must decode to a JSON object")
        payload = run_probe(artifact, code, params=parameters)
        emit(
            "cad_probe_python",
            payload,
            input_hashes={
                "artifact": sha256_file(artifact),
                "script": sha256_file(Path(args.code_file)),
                "parameters": _parameters_hash(parameters),
                "identityManifest": identity_hash,
            },
            input_artifacts=[
                {"path": str(artifact), "role": "subject"},
                *([{"path": str(identity_manifest), "role": "identity-manifest"}] if identity_manifest.is_file() else []),
            ],
            duration_ms=elapsed_ms(started),
        )
        return 0
    except json.JSONDecodeError as exc:
        return fail(
            "cad_probe_python",
            f"probe params are invalid JSON: {exc}",
            started=started,
            input_hashes={"artifact": hash_or_empty(artifact), "script": sha256_file(Path(args.code_file)), "identityManifest": identity_hash},
            exit_code=1,
        )
    except ProbeError as exc:
        return fail(
            "cad_probe_python",
            str(exc),
            started=started,
            input_hashes={
                "artifact": hash_or_empty(artifact),
                "script": sha256_file(Path(args.code_file)),
                "parameters": _parameters_hash(parameters),
                "identityManifest": identity_hash,
            },
            exit_code=1,
        )
