from __future__ import annotations

import ast
import re
from collections import Counter
from typing import Any


_FILE_READ = {"read_text", "read_bytes", "read", "readlines"}
_FILE_WRITE = {"write_text", "write_bytes", "write", "writelines", "savefig"}
_FILE_MUTATE = {"mkdir", "unlink", "rename", "replace", "copy", "copy2", "copytree", "move", "rmtree", "remove"}
_SHELL_CALLS = {"system", "popen", "run", "call", "check_call", "check_output", "Popen"}
_NETWORK_ROOTS = {"requests", "httpx", "aiohttp", "urllib", "socket"}
_DATA_ROOTS = {"numpy", "np", "pandas", "pd", "scipy", "sympy", "sklearn", "polars"}
_CAD_ROOTS = {"cadquery", "cq", "build123d", "trimesh", "freecad", "FreeCAD", "ezdxf", "open3d", "OCP", "bpy"}
_IMAGE_ROOTS = {"PIL", "Image", "cv2", "matplotlib", "plt", "plotly"}


def _code_from_arguments(arguments: Any) -> str:
    if isinstance(arguments, str):
        return arguments
    if isinstance(arguments, dict):
        for key in ("code", "input", "cell", "source"):
            value = arguments.get(key)
            if isinstance(value, str):
                return value
    return ""


def _call_name(node: ast.AST) -> str:
    parts: list[str] = []
    cur = node
    while isinstance(cur, ast.Attribute):
        parts.append(cur.attr)
        cur = cur.value
    if isinstance(cur, ast.Name):
        parts.append(cur.id)
    return ".".join(reversed(parts))


def _literal_text(node: ast.AST | None) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)):
        value = node.value.decode(errors="replace") if isinstance(node.value, bytes) else node.value
        return value
    if isinstance(node, ast.JoinedStr):
        chunks = [x.value for x in node.values if isinstance(x, ast.Constant) and isinstance(x.value, str)]
        return "{…}".join(chunks) if chunks else None
    return None


def _short(value: str, limit: int = 120) -> str:
    value = " ".join(value.split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _add(evidence: dict[str, list[str]], activity: str, detail: str) -> None:
    if detail and detail not in evidence[activity]:
        evidence[activity].append(detail)


def analyze_ipython(arguments: Any) -> dict[str, Any]:
    """Classify observable cell behavior without pretending to recover inner timings."""
    code = _code_from_arguments(arguments)
    evidence: dict[str, list[str]] = {k: [] for k in (
        "cad_workflow", "cad_commit", "cad_build", "cad_probe", "cad_other",
        "subagent_tool", "image_tool", "shell", "package", "file_inspect",
        "file_read", "file_write", "file_mutation", "network", "data_compute",
        "cad_geometry", "image_render", "python",
    )}
    imports: list[str] = []
    calls: list[str] = []
    paths: list[str] = []
    commands: list[str] = []
    parse_error: str | None = None
    known_tool_calls: list[str] = []

    # IPython syntax is not valid Python, so collect it first and replace it with pass.
    python_lines: list[str] = []
    in_cell_shell = False
    for raw in code.splitlines():
        stripped = raw.strip()
        if stripped.startswith("%%"):
            in_cell_shell = stripped.split(None, 1)[0].lower() in {"%%bash", "%%sh", "%%script"}
            _add(evidence, "shell", _short(stripped))
            python_lines.append("pass")
            continue
        if in_cell_shell:
            if stripped:
                commands.append(_short(stripped))
                _add(evidence, "shell", _short(stripped))
                if re.match(r"^(pip|uv|conda|poetry)\b", stripped, re.I):
                    _add(evidence, "package", _short(stripped))
            python_lines.append("pass")
            continue
        if stripped.startswith("!"):
            command = stripped[1:].strip()
            commands.append(_short(command))
            _add(evidence, "shell", _short(command))
            if re.match(r"^(pip|uv|conda|poetry)\b", command, re.I):
                _add(evidence, "package", _short(command))
            python_lines.append(raw[: len(raw) - len(raw.lstrip())] + "pass")
            continue
        if stripped.startswith("%"):
            _add(evidence, "python", _short(stripped))
            python_lines.append(raw[: len(raw) - len(raw.lstrip())] + "pass")
            continue
        python_lines.append(raw)

    try:
        tree = ast.parse("\n".join(python_lines))
    except SyntaxError as exc:
        tree = None
        parse_error = f"{exc.msg} at line {exc.lineno}"

    statement_count = len(tree.body) if isinstance(tree, ast.Module) else 0
    if tree:
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = [a.name for a in node.names]
                root = node.module or "" if isinstance(node, ast.ImportFrom) else ""
                imports.extend(([root] if root else []) + names)
            if not isinstance(node, ast.Call):
                continue
            name = _call_name(node.func)
            if name:
                calls.append(name)
            root = name.split(".", 1)[0]
            leaf = name.rsplit(".", 1)[-1]
            first = _literal_text(node.args[0]) if node.args else None
            if name.startswith("cad."):
                if name.startswith("cad.workflow."):
                    cad_activity = "cad_workflow"
                elif name == "cad.commit":
                    cad_activity = "cad_commit"
                elif name.startswith("cad.model.build"):
                    cad_activity = "cad_build"
                elif name.startswith("cad.probe."):
                    cad_activity = "cad_probe"
                else:
                    cad_activity = "cad_other"
                _add(evidence, cad_activity, name)
                known_tool_calls.append(name)
            elif name.startswith(("rlm.", "agent_message.")) or name == "rlm":
                _add(evidence, "subagent_tool", name)
                known_tool_calls.append(name)
            elif name.startswith(("attach_image", "attach_image_pkg.")):
                _add(evidence, "image_tool", name)
                known_tool_calls.append(name)
            if leaf in {"rglob", "glob", "iglob", "stat", "is_file", "is_dir", "exists", "iterdir"}:
                _add(evidence, "file_inspect", f"{name}({repr(_short(first)) if first else '…'})")
            if first and (leaf in _FILE_READ | _FILE_WRITE | _FILE_MUTATE | {"open"} or "Path" in name):
                paths.append(_short(first))
            if leaf in _FILE_READ:
                _add(evidence, "file_read", f"{name}({repr(_short(first)) if first else '…'})")
            if leaf in _FILE_WRITE:
                _add(evidence, "file_write", f"{name}({repr(_short(first)) if first else '…'})")
            if leaf in _FILE_MUTATE:
                _add(evidence, "file_mutation", f"{name}({repr(_short(first)) if first else '…'})")
            if leaf == "open" or name.endswith(".open"):
                mode = _literal_text(node.args[1]) if len(node.args) > 1 else None
                for kw in node.keywords:
                    if kw.arg == "mode":
                        mode = _literal_text(kw.value)
                activity = "file_write" if mode and any(x in mode for x in "wax+") else "file_read"
                _add(evidence, activity, f"{name}({repr(_short(first)) if first else '…'}, mode={mode or 'r'})")
            if (root in {"subprocess", "os"} and leaf in _SHELL_CALLS) or name.endswith("get_ipython.system"):
                command = _short(first) if first else name
                commands.append(command)
                _add(evidence, "shell", command)
                if first and re.match(r"^(pip|uv|conda|poetry)\b", first, re.I):
                    _add(evidence, "package", command)
            if root in _NETWORK_ROOTS or any(x in name.lower() for x in ("urlopen", "urlretrieve")):
                _add(evidence, "network", f"{name}({repr(_short(first)) if first else '…'})")
            if root in _DATA_ROOTS:
                _add(evidence, "data_compute", name)
            if root in _CAD_ROOTS:
                _add(evidence, "cad_geometry", name)
            if root in _IMAGE_ROOTS:
                _add(evidence, "image_render", name)
            if leaf in {"display", "show"} or name.endswith((".save", ".thumbnail")):
                _add(evidence, "image_render", name)

    activities = [k for k, values in evidence.items() if values and k != "python"]
    if not activities:
        activities = ["python"]
        _add(evidence, "python", "No high-confidence external/file/domain operation detected")
    evidence = {k: v[:8] for k, v in evidence.items() if v}
    known_tools = list(dict.fromkeys(known_tool_calls))
    if known_tool_calls and (len(activities) > 1 or statement_count > 4):
        style = "hybrid"
    elif known_tools:
        style = "tool-wrapper"
    elif len(activities) > 1 or statement_count > 4:
        style = "composed-python"
    elif activities == ["python"]:
        style = "python-only"
    else:
        style = "focused-python"
    confidence = "high" if tree is not None and any(a in activities for a in ("shell", "file_read", "file_write", "file_mutation", "network", "package")) else "medium"
    if tree is None:
        confidence = "low"

    activity_label = " + ".join(a.replace("_", " ") for a in activities[:3])
    if len(activities) > 3:
        activity_label += f" +{len(activities) - 3}"
    evidence_details = [detail for activity in activities for detail in evidence.get(activity, [])]
    notable = commands[:2] or evidence_details[:2] or paths[:2] or calls[:2]
    summary = activity_label
    if notable:
        summary += ": " + "; ".join(_short(x, 90) for x in notable)

    return {
        "code": code,
        "code_chars": len(code),
        "code_lines": len(code.splitlines()),
        "statement_count": statement_count,
        "activities": activities,
        "primary_activity": activities[0],
        "style": style,
        "confidence": confidence,
        "summary": summary,
        "evidence": evidence,
        "imports": list(dict.fromkeys(imports))[:30],
        "calls": list(dict.fromkeys(calls))[:50],
        "paths": list(dict.fromkeys(paths))[:20],
        "commands": list(dict.fromkeys(commands))[:20],
        "known_tools": known_tools[:30],
        "known_tool_calls": known_tool_calls[:100],
        "parse_error": parse_error,
    }


def activity_counts(cells: list[dict[str, Any]]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for cell in cells:
        counts.update(cell.get("activities") or ["python"])
    return counts
