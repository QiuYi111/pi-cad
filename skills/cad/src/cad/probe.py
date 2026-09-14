from __future__ import annotations

import ast
import inspect
import json
import textwrap
from dataclasses import dataclass
from typing import Any, Callable

from .client import request
from .refs import ArtifactRef, ProbeResult
from ._attachments import display_inline_image
from .client import CadApiError


def _captured_source(function: Callable[..., Any]) -> str:
    try:
        source = textwrap.dedent(inspect.getsource(function))
    except (OSError, TypeError) as error:
        raise TypeError("cad.probe could not capture function source; define it in a source file or use await cad.probe.run(..., code=...)") from error
    tree = ast.parse(source)
    definitions = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    if len(definitions) != 1 or isinstance(definitions[0], ast.AsyncFunctionDef):
        raise TypeError("cad.probe requires one synchronous function definition")
    definition = definitions[0]
    definition.decorator_list = []
    return ast.unparse(definition)


@dataclass(frozen=True, repr=False)
class ProbeProgram:
    function: Callable[..., Any]
    subject: str | ArtifactRef
    purpose: str
    source: str

    def __repr__(self) -> str:
        return f"ProbeProgram(name={self.function.__name__!r}, subject={self.subject!r})"

    async def result(self, **arguments: Any) -> ProbeResult:
        if self.function.__code__.co_freevars:
            raise TypeError(f"cad.probe does not capture closures: {', '.join(self.function.__code__.co_freevars)}; pass values explicitly")
        signature = inspect.signature(self.function)
        preloaded = {"shape", "bd", "np", "math", "statistics"}
        callable_parameters = [name for name in signature.parameters if name not in preloaded]
        missing = [name for name in callable_parameters if name not in arguments and signature.parameters[name].default is inspect.Parameter.empty]
        extra = [name for name in arguments if name not in callable_parameters]
        if missing or extra:
            raise TypeError(f"probe arguments mismatch; missing={missing}, extra={extra}")
        call_items = []
        for name in signature.parameters:
            if name in preloaded:
                call_items.append(f"{name}={name}")
            elif name in arguments:
                try:
                    encoded = json.dumps(arguments[name], ensure_ascii=False, allow_nan=False)
                except (TypeError, ValueError) as error:
                    raise TypeError(f"probe argument {name!r} must be JSON-serializable") from error
                call_items.append(f"{name}={encoded}")
        code = f"{self.source}\nresult = {self.function.__name__}({', '.join(call_items)})"
        subject = self.subject.__cad_snapshot__() if isinstance(self.subject, ArtifactRef) else self.subject
        payload = await request("probe", subject=subject, purpose=self.purpose, code=code)
        return ProbeResult(payload["value"], payload.get("artifactHash"), payload.get("scriptHash"), payload.get("observationId"))

    async def __call__(self, **arguments: Any) -> Any:
        return (await self.result(**arguments)).value


def probe(*, subject: str | ArtifactRef = "current", purpose: str = "") -> Callable[[Callable[..., Any]], ProbeProgram]:
    if not isinstance(subject, ArtifactRef) and subject not in {"current", "baseline"}:
        raise ValueError("cad.probe subject must be 'current', 'baseline', or an ArtifactRef")

    def decorate(function: Callable[..., Any]) -> ProbeProgram:
        return ProbeProgram(function, subject, purpose or function.__name__.replace("_", " "), _captured_source(function))

    return decorate


async def run(
    *,
    subject: str | ArtifactRef | None = "current",
    preset: str = "python",
    purpose: str = "",
    code: str | None = None,
    args: dict[str, Any] | None = None,
) -> ProbeResult:
    """Run a registered read-only preset or an explicit fenced probe program."""
    if not isinstance(subject, ArtifactRef) and subject not in {"current", "baseline", None}:
        raise ValueError("cad.probe.run subject must be 'current', 'baseline', or an ArtifactRef")
    if not isinstance(preset, str) or not preset.strip():
        raise ValueError("cad.probe.run preset must be non-empty")
    selected = preset.strip()
    if selected == "python":
        if not isinstance(purpose, str) or not purpose.strip():
            raise ValueError("cad.probe.run purpose must be non-empty for preset='python'")
        if not isinstance(code, str) or not code.strip():
            raise ValueError("cad.probe.run code must be non-empty for preset='python'")
        if args is not None:
            raise ValueError("cad.probe.run args are not used by preset='python'")
    else:
        if code is not None:
            raise ValueError("cad.probe.run code is only valid for preset='python'")
        if args is not None and not isinstance(args, dict):
            raise TypeError("cad.probe.run args must be a dict")
    wire_subject = subject.__cad_snapshot__() if isinstance(subject, ArtifactRef) else subject
    kwargs: dict[str, Any] = {"preset": selected, "purpose": purpose.strip(), "args": args or {}}
    if wire_subject is not None:
        kwargs["subject"] = wire_subject
    if code is not None:
        kwargs["code"] = code
    payload = await request("probe", **kwargs)
    images = payload.get("images") or []
    if images:
        await _attach_images(images)
    return ProbeResult(payload["value"], payload.get("artifactHash"), payload.get("scriptHash"), payload.get("observationId"))


async def _attach_images(images: list[dict[str, Any]]) -> None:
    if not images:
        raise CadApiError("visual probe produced no images")
    for image in images:
        view = str(image.get("name") or "view").upper()
        display_inline_image(image, label=f"Pi-CAD reviewer visual probe · {view}")


# Preserve @cad.probe while making cad.probe.run the canonical live-IPython API.
probe.run = run  # type: ignore[attr-defined]
