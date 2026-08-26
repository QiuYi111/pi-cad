from __future__ import annotations

"""Private Prime autonomous gate backed by the authority sidecar."""

import asyncio
import json

from .client import CadApiError, request


async def _main() -> int:
    try:
        result = await request("completion-gate")
    except CadApiError as error:
        print(json.dumps({"complete": False, "reason": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("complete") is True else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
