from __future__ import annotations

import dataclasses
import ast
import asyncio
import base64
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import cad
from cad.snapshot import SnapshotError


@cad.probe(subject="current", purpose="fixture")
def _module_probe(shape, bd, np, minimum):
    return {"count": len(shape.solids()), "minimum": minimum}


@dataclasses.dataclass
class Example:
    name: str
    count: int


class CadPackageTests(unittest.TestCase):
    def test_configured_sidecar_failure_never_falls_back_to_local_engine(self) -> None:
        client = importlib.import_module("cad.client")
        with (
            patch.dict(os.environ, {"PI_CAD_AUTHOR_SOCKET": "/missing/authority.sock"}),
            patch.object(client.asyncio, "open_unix_connection", AsyncMock(side_effect=FileNotFoundError("missing"))),
            patch.object(client.asyncio, "create_subprocess_exec", AsyncMock()) as local_engine,
        ):
            with self.assertRaisesRegex(client.CadApiError, "failed closed"):
                asyncio.run(client.request("workflow-current"))
        local_engine.assert_not_awaited()

    def test_cad_requests_name_the_session_that_owns_the_kernel(self) -> None:
        client = importlib.import_module("cad.client")
        response = json.dumps({"ok": True, "result": {"runId": "v7-1-abcdefgh"}}).encode()

        def exchange(env: dict[str, str]) -> dict:
            written: list[bytes] = []
            writer = SimpleNamespace(
                write=written.append,
                drain=AsyncMock(),
                write_eof=Mock(),
                close=Mock(),
                wait_closed=AsyncMock(),
            )
            reader = SimpleNamespace(read=AsyncMock(side_effect=[response, b""]))
            with (
                patch.dict(
                    os.environ,
                    {"PI_CAD_AUTHOR_SOCKET": "/run/pi-cad/author/authority.sock", **env},
                    clear=True,
                ),
                patch.object(client.asyncio, "open_unix_connection", AsyncMock(return_value=(reader, writer))),
            ):
                asyncio.run(client.request("workflow-current"))
            return json.loads(b"".join(written).decode())

        # Prime names the kernel's owning session in the kernel environment, so
        # the kernel never has to guess from process-wide state.
        self.assertEqual(
            exchange({"PRIME_AGENT_SESSION_ID": "prime-child-session"})["sessionId"],
            "prime-child-session",
        )
        # An explicit host override still wins.
        self.assertEqual(
            exchange({"PRIME_AGENT_SESSION_ID": "prime-child-session", "PI_CAD_SESSION_ID": "explicit"})["sessionId"],
            "explicit",
        )
        # A host that names no session keeps the older project-scoped request.
        self.assertNotIn("sessionId", exchange({}))
        # A reviewer never claims an author conversation's session.
        self.assertNotIn(
            "sessionId",
            exchange(
                {
                    "PI_CAD_REVIEWER_SOCKET": "/run/pi-cad/reviewer/authority.sock",
                    "PRIME_AGENT_SESSION_ID": "prime-child-session",
                }
            ),
        )

    def test_sidecar_response_is_read_to_eof_before_json_decode(self) -> None:
        client = importlib.import_module("cad.client")
        encoded = json.dumps({"ok": True, "result": {"image": "a" * 100_000}}).encode()

        class FragmentedReader:
            def __init__(self) -> None:
                self._chunks = [encoded[:31], encoded[31:70_000], encoded[70_000:], b""]

            async def read(self, _limit: int) -> bytes:
                return self._chunks.pop(0)

        writer = SimpleNamespace(
            write=Mock(),
            drain=AsyncMock(),
            write_eof=Mock(),
            close=Mock(),
            wait_closed=AsyncMock(),
        )
        with (
            patch.dict(os.environ, {"PI_CAD_AUTHOR_SOCKET": "/run/pi-cad/authority.sock"}),
            patch.object(client.asyncio, "open_unix_connection", AsyncMock(return_value=(FragmentedReader(), writer))),
        ):
            result = asyncio.run(client.request("workflow-current"))
        self.assertEqual(len(result["image"]), 100_000)
        writer.close.assert_called_once()

    def test_json_dataclass_path_and_numpy_codecs_are_explicit(self) -> None:
        self.assertEqual(cad.snapshot.registry.decode(cad.snapshot.registry.encode({"a": [1, 2]})), {"a": [1, 2]})
        encoded = cad.snapshot.registry.encode(Example("part", 2))
        self.assertEqual(encoded["codec"], "dataclass")
        self.assertEqual(cad.snapshot.registry.decode(encoded), {"name": "part", "count": 2})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "spec.md"
            path.write_text("v1")
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}):
                path_snapshot = cad.snapshot.registry.encode(Path("spec.md"))
                self.assertEqual(path_snapshot["codec"], "path")
                self.assertEqual(path_snapshot["value"]["path"], "spec.md")
                self.assertEqual(len(path_snapshot["value"]["contentSha256"]), 64)
                with self.assertRaisesRegex(SnapshotError, "escapes the project root"):
                    cad.snapshot.registry.encode(root.parent / "outside.md")
        import numpy as np
        array = np.asarray([[1, 2], [3, 4]], dtype="int32")
        self.assertTrue((cad.snapshot.registry.decode(cad.snapshot.registry.encode(array)) == array).all())

    def test_no_pickle_fallback_and_registered_codec(self) -> None:
        class Unsupported:
            pass

        with self.assertRaisesRegex(SnapshotError, "pickle is never used"):
            cad.snapshot.registry.encode(Unsupported())

        class Registered:
            def __init__(self, value: int) -> None:
                self.value = value

        cad.snapshot.register(Registered, "test.registered", lambda item: {"value": item.value}, lambda value: Registered(value["value"]))
        restored = cad.snapshot.registry.decode(cad.snapshot.registry.encode(Registered(7)))
        self.assertEqual(restored.value, 7)

    def test_templates_are_extensible_and_non_authoritative(self) -> None:
        names = {item["name"] for item in cad.templates.list()}
        self.assertEqual(names, {"mechanical.work-package", "mechanical.part-work", "mechanical.assembly-work"})
        PartWork = cad.templates.load("mechanical.part-work")
        part = PartWork(name="housing")
        self.assertEqual(part.name, "housing")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            cad.templates.register("mechanical.part-work", dict)

    def test_handles_have_compact_repr(self) -> None:
        artifact = cad.ArtifactRef(Path("build/a.step"), "a" * 64, "candidate")
        self.assertLess(len(repr(artifact)), 160)
        self.assertNotIn("a" * 64, repr(artifact))

    def test_save_and_check_is_the_authorized_commit_then_build_composition(self) -> None:
        saved = cad.Commit("commit-1", "parts", None, "workflow", "parts", {}, (), "now")
        artifact = cad.ArtifactRef(Path("build/bracket.step"), "b" * 64, "candidate")
        with (
            patch.object(cad, "commit", AsyncMock(return_value=saved)) as commit,
            patch.object(cad.model, "build", AsyncMock(return_value=artifact)) as build,
        ):
            result = asyncio.run(cad.save_and_check(
                "parts", "bracket.py", "build/bracket.step",
                variables={"width": 40}, force=True,
            ))
        self.assertIs(result.commit, saved)
        self.assertIs(result.artifact, artifact)
        commit.assert_awaited_once_with("parts", parent=None, variables={"width": 40}, artifacts=None)
        build.assert_awaited_once_with("bracket.py", "build/bracket.step", force=True, validation="auto", parameters=None)

    def test_save_and_check_does_not_build_when_authorized_commit_fails(self) -> None:
        with (
            patch.object(cad, "commit", AsyncMock(side_effect=cad.CadApiError("denied"))),
            patch.object(cad.model, "build", AsyncMock()) as build,
        ):
            with self.assertRaisesRegex(cad.CadApiError, "denied"):
                asyncio.run(cad.save_and_check("parts", "bracket.py"))
        build.assert_not_awaited()

    def test_probe_decorator_captures_plain_source_without_decorator(self) -> None:
        self.assertIn("def _module_probe", _module_probe.source)
        self.assertNotIn("@cad.probe", _module_probe.source)
        self.assertEqual(_module_probe.subject, "current")

        threshold = 2

        @cad.probe(subject="current")
        def closure_probe(shape):
            return {"threshold": threshold, "solids": len(shape.solids())}

        with self.assertRaisesRegex(TypeError, "does not capture closures"):
            import asyncio
            asyncio.run(closure_probe())

    def test_probe_arguments_cross_as_decoded_json_parameters(self) -> None:
        probe_module = importlib.import_module("cad.probe")

        @cad.probe(subject="current")
        def literal_probe(shape, label):
            return {"label": label, "solids": len(shape.solids())}

        payload = '"; __import__("os").system("false") #'
        mocked = AsyncMock(return_value={"value": {"label": payload}})
        with patch.object(probe_module, "request", mocked):
            asyncio.run(literal_probe(label=payload))
        code = mocked.await_args.kwargs["code"]
        assignment = ast.parse(code).body[-1]
        self.assertIsInstance(assignment, ast.Assign)
        keyword = assignment.value.keywords[-1]
        self.assertIsInstance(keyword.value, ast.Subscript)
        self.assertEqual(keyword.value.value.id, "params")
        self.assertEqual(mocked.await_args.kwargs["args"], {"label": payload})

    def test_probe_accepts_artifact_ref_subject(self) -> None:
        probe_module = importlib.import_module("cad.probe")
        artifact = cad.ArtifactRef(Path("build/part.step"), "a" * 64, "candidate")

        @cad.probe(subject=artifact, purpose="detached artifact")
        def artifact_probe(shape):
            return {"solids": len(shape.solids())}

        mocked = AsyncMock(return_value={"value": {"solids": 1}})
        with patch.object(probe_module, "request", mocked):
            self.assertEqual(asyncio.run(artifact_probe()), {"solids": 1})
        self.assertEqual(mocked.await_args.kwargs["subject"], {
            "kind": "artifact", "path": "build/part.step", "sha256": "a" * 64, "role": "candidate",
        })

    def test_probe_run_is_canonical_for_live_ipython_code(self) -> None:
        probe_module = importlib.import_module("cad.probe")
        artifact = cad.ArtifactRef(Path("build/part.step"), "a" * 64, "candidate")
        mocked = AsyncMock(return_value={
            "value": {"solids": 1}, "artifactHash": "a" * 64,
            "scriptHash": "b" * 64, "observationId": "observation-1",
        })
        with patch.object(probe_module, "request", mocked):
            result = asyncio.run(cad.probe.run(
                subject=artifact,
                purpose="count solids",
                code="result = {'solids': len(shape.solids())}",
            ))
        self.assertEqual(result.value, {"solids": 1})
        self.assertEqual(result.artifact_hash, "a" * 64)
        self.assertEqual(mocked.await_args.kwargs["subject"], {
            "kind": "artifact", "path": "build/part.step", "sha256": "a" * 64, "role": "candidate",
        })

    def test_model_build_returns_hashed_artifact_ref(self) -> None:
        model_module = importlib.import_module("cad.model")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "build" / "part.step"
            output.parent.mkdir()
            output.write_bytes(b"STEP")
            envelope = {
                "ok": True,
                "artifacts": [{"path": str(output), "kind": "step", "sha256": "b" * 64}],
                "outputHashes": {str(output): "b" * 64},
            }
            response = {"build": envelope, "images": [{"data": base64.b64encode(b"PNG").decode(), "mimeType": "image/png"}]}
            attach = AsyncMock()
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", AsyncMock(return_value=response)), \
                    patch.object(model_module, "_attach_images", attach):
                artifact = asyncio.run(cad.model.build("part.py", "build/part.step"))
            self.assertEqual(artifact.sha256, "b" * 64)
            self.assertEqual(artifact.path, Path("build/part.step"))
            attach.assert_awaited_once_with(response["images"], artifact)

    def test_model_build_forwards_parameter_definitions(self) -> None:
        model_module = importlib.import_module("cad.model")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "build" / "part.step"
            output.parent.mkdir()
            output.write_bytes(b"STEP")
            response = {
                "build": {"ok": True, "artifacts": [{"kind": "step", "sha256": "b" * 64}]},
                "images": [{"data": base64.b64encode(b"PNG").decode(), "mimeType": "image/png"}],
            }
            request = AsyncMock(return_value=response)
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", request), \
                    patch.object(model_module, "_attach_images", AsyncMock()):
                asyncio.run(cad.model.build(
                    "part.py",
                    "build/part.step",
                    validation="full",
                    parameters={
                        "width": {"default": 40, "min": 20, "max": 80, "step": 1, "unit": "mm"},
                    },
                ))
            request.assert_awaited_once_with(
                "model-build",
                source="part.py",
                output="build/part.step",
                force=False,
                validation="full",
                parameters={
                    "width": {"default": 40, "min": 20, "max": 80, "step": 1, "unit": "mm"},
                },
            )

    def test_model_build_emits_prime_rich_image_output(self) -> None:
        model_module = importlib.import_module("cad.model")
        attach = Mock()
        images = [
            {"data": base64.b64encode(b"first").decode(), "mimeType": "image/png"},
            {"data": base64.b64encode(b"second").decode(), "mimeType": "image/png"},
        ]
        with patch("IPython.display.display", attach):
            artifact = cad.ArtifactRef(Path("build/part.step"), "a" * 64, "candidate")
            asyncio.run(model_module._attach_images(images, artifact))
        self.assertEqual(attach.call_count, 2)
        for call, expected in zip(attach.call_args_list, images, strict=True):
            self.assertTrue(call.kwargs["raw"])
            self.assertEqual(call.args[0]["application/vnd.prime-agent.attachment+json"], {
                "mime_type": "image/png", "data": expected["data"],
            })
        first_label = attach.call_args_list[0].args[0]["text/plain"]
        self.assertIn("Built ArtifactRef", first_label)
        self.assertIn("primary observation", first_label)
        self.assertIn("Reason about what the geometry actually does", first_label)
        self.assertNotIn("bbox", first_label)
        self.assertEqual(attach.call_args_list[1].args[0]["text/plain"], "[VIEW]")

    def test_review_inspect_attaches_canonical_images_without_returning_base64(self) -> None:
        review_module = importlib.import_module("cad.review")
        encoded = base64.b64encode(b"review-view").decode()
        mocked = AsyncMock(return_value={
            "reviewId": "review-" + "a" * 24,
            "records": [{"obligationRef": "spec"}],
            "candidate": {"path": "build/candidate.step", "sha256": "c" * 64, "role": "authoritative-candidate-design"},
            "images": [{"data": encoded, "mimeType": "image/png", "evidenceRef": "visual:" + "b" * 64}],
        })
        attach = Mock()
        with patch.object(review_module, "request", mocked), patch("IPython.display.display", attach):
            context = asyncio.run(review_module.inspect())
        mocked.assert_awaited_once_with("review-evidence")
        self.assertEqual(context["images"], [{"mimeType": "image/png", "evidenceRef": "visual:" + "b" * 64}])
        self.assertIsInstance(context["candidate"], cad.ArtifactRef)
        self.assertEqual(context["candidate"].path, Path("build/candidate.step"))
        self.assertEqual(context["candidate"].sha256, "c" * 64)
        self.assertEqual(attach.call_count, 1)
        self.assertTrue(attach.call_args.kwargs["raw"])

    def test_probe_visual_preset_uses_the_generic_interface_and_attaches_results(self) -> None:
        probe_module = importlib.import_module("cad.probe")
        artifact = cad.ArtifactRef(Path("build/candidate.step"), "c" * 64, "candidate")
        response = {
            "value": {"viewCount": 1},
            "observationId": "observation-1",
            "artifactHash": "c" * 64,
            "images": [{"name": "right", "mimeType": "image/png", "data": base64.b64encode(b"view").decode()}],
        }
        request = AsyncMock(return_value=response)
        attach = AsyncMock()
        with patch.object(probe_module, "request", request), patch.object(probe_module, "_attach_images", attach):
            result = asyncio.run(cad.probe.run(
                subject=artifact,
                preset="visual",
                args={"views": ["right"], "width": 800, "height": 600, "labels": True},
            ))
        request.assert_awaited_once_with(
            "probe", subject=artifact.__cad_snapshot__(), preset="visual",
            purpose="", args={"views": ["right"], "width": 800, "height": 600, "labels": True},
        )
        attach.assert_awaited_once_with(response["images"])
        self.assertEqual(result.value, {"viewCount": 1})
        self.assertEqual(result.observation_id, "observation-1")
        self.assertFalse(hasattr(cad.probe, "render"))

    def test_probe_registered_preset_needs_no_program(self) -> None:
        probe_module = importlib.import_module("cad.probe")
        artifact = cad.ArtifactRef(Path("build/candidate.step"), "c" * 64, "candidate")
        request = AsyncMock(return_value={"value": {"value": 12.5, "units": "mm"}, "observationId": "observation-2"})
        with patch.object(probe_module, "request", request):
            result = asyncio.run(cad.probe.run(
                subject=artifact,
                preset="measure",
                args={"metric": "distance", "a": "#f0", "b": "#f1"},
            ))
        self.assertEqual(result.value["value"], 12.5)
        request.assert_awaited_once_with(
            "probe", subject=artifact.__cad_snapshot__(), preset="measure", purpose="",
            args={"metric": "distance", "a": "#f0", "b": "#f1"},
        )

    def test_model_build_fails_on_inner_backend_error(self) -> None:
        model_module = importlib.import_module("cad.model")
        envelope = {"ok": False, "artifacts": [], "payload": {"error": "No module named cadquery"}}
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", AsyncMock(return_value={"build": envelope, "images": []})):
                with self.assertRaisesRegex(cad.CadApiError, "No module named cadquery"):
                    asyncio.run(cad.model.build("part.py", "build/part.step"))

    def test_model_build_rejects_paths_outside_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}):
                with self.assertRaisesRegex(cad.CadApiError, "escapes the project root"):
                    asyncio.run(cad.model.build(Path(directory).parent / "part.py"))

    def test_model_build_requires_prime_image_injection(self) -> None:
        model_module = importlib.import_module("cad.model")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "build" / "part.step"
            output.parent.mkdir()
            output.write_bytes(b"STEP")
            response = {"build": {"ok": True, "artifacts": [{"kind": "step", "sha256": "b" * 64}]}, "images": []}
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", AsyncMock(return_value=response)):
                with self.assertRaisesRegex(cad.CadApiError, "no mandatory visual observations"):
                    asyncio.run(cad.model.build("part.py", "build/part.step"))

    def test_commit_accepts_explicit_parent_handle(self) -> None:
        cad_module = importlib.import_module("cad")
        parent = cad.Commit("commit-" + "a" * 32, "task", None, "b" * 64, "design", {}, (), "now")
        mocked = AsyncMock(return_value={
            "id": "commit-" + "c" * 32, "name": "delivery", "parent": parent.id,
            "workflowHash": "b" * 64, "phase": "design", "variables": {}, "artifacts": [], "createdAt": "now",
        })
        with patch.object(cad_module, "request", mocked):
            asyncio.run(cad.commit("delivery", parent=parent))
        self.assertEqual(mocked.await_args.kwargs["parent"], parent.id)

    def test_commit_normalizes_safe_project_paths_before_the_wire_boundary(self) -> None:
        cad_module = importlib.import_module("cad")
        mocked = AsyncMock(return_value={
            "id": "commit-" + "c" * 32, "name": "candidate-build", "parent": None,
            "workflowHash": "b" * 64, "phase": "build", "variables": {}, "artifacts": [], "createdAt": "now",
        })
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "table.py"
            source.write_text("result = None")
            artifact = root / "build" / "table.step"
            artifact.parent.mkdir()
            artifact.write_bytes(b"STEP")
            ref = cad.ArtifactRef(Path("build/table.step"), "a" * 64, "candidate")
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), patch.object(cad_module, "request", mocked):
                asyncio.run(cad.commit("candidate-build", artifacts=[ref, source]))
        self.assertEqual(mocked.await_args.kwargs["artifacts"], [
            {"path": "build/table.step", "role": "candidate"},
            {"path": "table.py", "role": "workspace-commit-artifact"},
        ])
        self.assertNotIn("parent", mocked.await_args.kwargs)

    def test_commit_rejects_artifacts_outside_the_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}):
                with self.assertRaisesRegex(cad.CadApiError, "escapes the project root"):
                    asyncio.run(cad.commit("candidate-build", artifacts=[Path(directory).parent / "outside.py"]))

    def test_workflow_discovery_start_and_advance_use_the_generic_bridge(self) -> None:
        workflow_module = importlib.import_module("cad.workflow")
        mocked = AsyncMock(side_effect=[
            [{"id": "mechanical.one-shot", "description": "Design", "tags": ["cad"], "version": "1.0.0"}],
            {"workflowId": "mechanical.one-shot", "phase": "grilling"},
            {"phase": "spec"},
        ])
        with patch.object(workflow_module, "request", mocked):
            packages = asyncio.run(cad.workflow.list())
            started = asyncio.run(cad.workflow.start("mechanical.one-shot"))
            advanced = asyncio.run(cad.workflow.advance("clarified"))
        self.assertEqual(packages[0]["id"], "mechanical.one-shot")
        self.assertEqual(started["workflowId"], "mechanical.one-shot")
        self.assertEqual(advanced["phase"], "spec")
        self.assertEqual(mocked.await_args_list[0].args, ("workflow-list",))
        self.assertEqual(mocked.await_args_list[1].kwargs["id"], "mechanical.one-shot")
        self.assertFalse(hasattr(cad.workflow, "route"))

    def test_workflow_start_rejects_an_empty_package_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "workflow_id is required"):
            asyncio.run(cad.workflow.start("  "))

    def test_review_submit_and_current_use_event_driven_sidecar_api(self) -> None:
        review_module = importlib.import_module("cad.review")
        commit_id = "commit-" + "a" * 32
        handle = {"reviewId": "review-" + "b" * 24, "subjectCommit": commit_id, "status": "running"}
        result = {"verdict": "pass", "target": "release", "summary": "accepted", "findings": []}
        mocked = AsyncMock(side_effect=[handle, {**handle, "status": "pass", "result": result}])
        with patch.object(review_module, "request", mocked):
            returned = asyncio.run(cad.review.submit(commit_id))
            current = asyncio.run(cad.review.current(returned))
        self.assertEqual(returned, handle)
        self.assertEqual(current["status"], "pass")
        self.assertEqual(current["result"], result)
        self.assertEqual(mocked.await_args_list[0].args, ("review-submit",))
        self.assertEqual(mocked.await_args_list[0].kwargs["subjectCommit"], commit_id)
        self.assertEqual(mocked.await_args_list[1].kwargs["reviewId"], handle["reviewId"])

    def test_living_plan_resolves_latest_version_and_updates_in_place(self) -> None:
        plan_module = importlib.import_module("cad.plan")
        first = cad.Commit("commit-" + "a" * 32, "plan", None, "w", "plan", {}, (), "1")
        other = cad.Commit("commit-" + "b" * 32, "candidate", first.id, "w", "cook", {}, (), "2")
        latest = cad.Commit("commit-" + "c" * 32, "plan", other.id, "w", "cook", {}, (), "3")
        loaded = cad.Commit(latest.id, latest.name, latest.parent, latest.workflow_hash, latest.phase, {"requirements": ["current"]}, (), latest.created_at)
        with patch.object(cad, "history", AsyncMock(return_value=[first, other, latest])), patch.object(cad, "load", AsyncMock(return_value=loaded)):
            self.assertEqual(asyncio.run(cad.plan.current()), loaded)
        with patch.object(cad, "commit", AsyncMock(return_value=latest)) as commit:
            self.assertEqual(asyncio.run(cad.plan.update(variables={"requirements": ["current"]})), latest)
            commit.assert_awaited_once_with("plan", variables={"requirements": ["current"]}, artifacts=None)

    def test_advisory_review_brief_uses_latest_plan_without_a_verdict(self) -> None:
        review_module = importlib.import_module("cad.review")
        candidate = cad.Commit("commit-" + "d" * 32, "candidate", None, "w", "cook", {}, (), "1")
        current_plan = cad.Commit("commit-" + "e" * 32, "plan", None, "w", "cook", {}, (), "2")
        with patch.object(cad.plan, "current", AsyncMock(return_value=current_plan)):
            brief = asyncio.run(cad.review.prepare(candidate))
        self.assertEqual(brief["candidateCommitId"], candidate.id)
        self.assertEqual(brief["currentPlanCommitId"], current_plan.id)
        self.assertIn("plan_stale", brief["instructions"])
        self.assertNotIn("verdict", brief)

    def test_review_resolve_submits_authoritative_verdicts_and_rejects_runtime_unresolved(self) -> None:
        review_module = importlib.import_module("cad.review")
        review_id = "review-" + "b" * 24
        mocked = AsyncMock(return_value={"reviewId": review_id, "status": "fail"})
        with patch.object(review_module, "request", mocked):
            asyncio.run(cad.review.resolve(review_id, verdict="fail", target="concept", summary="concept is unsound", findings=[]))
            self.assertEqual(mocked.await_args.kwargs["result"], {
                "verdict": "fail", "target": "concept", "summary": "concept is unsound", "findings": [],
            })
            asyncio.run(cad.review.resolve(review_id, verdict="clarification_required", target="wait_for_user", summary="ask the user", findings=[]))
            self.assertEqual(mocked.await_args.kwargs["result"]["verdict"], "clarification_required")
        with self.assertRaisesRegex(ValueError, "clarification_required"):
            asyncio.run(cad.review.resolve(review_id, verdict="unresolved", target="concept", summary="unsure", findings=[]))

    def test_simulation_run_returns_a_real_pending_job(self) -> None:
        simulation_module = importlib.import_module("cad.simulation")

        async def scenario() -> None:
            release = asyncio.Event()

            async def fake_request(*_args, **_kwargs):
                await release.wait()
                return {"runId": "run-1", "recipeId": "thermal", "computeIdentity": "b" * 64, "observation": {"exports": []}}

            with patch.object(simulation_module, "request", fake_request):
                job = await cad.simulation.run(recipe="thermal.yaml")
                self.assertIn("running", repr(job))
                release.set()
                result = await job.result()
                self.assertEqual(result.run_id, "run-1")

        asyncio.run(scenario())

    # ------------------------------------------------------------ part backend

    def test_part_open_forwards_paths_and_returns_a_snapshotable_handle(self) -> None:
        part_module = importlib.import_module("cad.part")
        response = {"part": {"rev": 0}, "images": [], "changes": None, "artifact": None, "created": True}
        request = AsyncMock(return_value=response)
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                patch.object(part_module, "request", request):
            doc = asyncio.run(cad.part.open("parts/bracket.FCStd", create=True, body="bracket"))
        request.assert_awaited_once_with(
            "part-open", doc="parts/bracket.FCStd", output="build/bracket.step", create=True, validation="auto", body="bracket",
        )
        self.assertEqual(doc.path, Path("parts/bracket.FCStd"))
        encoded = cad.snapshot.registry.encode(doc)
        self.assertEqual(encoded["codec"], "cad.part")
        decoded = cad.snapshot.registry.decode(encoded)
        self.assertEqual((decoded.path, decoded.output, decoded.body), (doc.path, doc.output, "bracket"))

    def test_part_apply_returns_artifact_with_changes_and_attaches_the_views(self) -> None:
        part_module = importlib.import_module("cad.part")
        changes = {
            "schema": 1, "baseline": {"sha256": "c" * 64},
            "volumeMm3": {"before": 100.0, "after": 96.0, "delta": -4.0},
            "bboxMm": {"before": [1, 2, 3], "after": [1, 2, 3], "changed": False},
            "faces": {"before": 8, "after": 9, "new": 3, "removed": 2},
        }
        response = {
            "part": {"rev": 13, "features": {"recomputed": ["bracket/hole"]}, "params": {"changed": {"hole_d": [6, 8]}}, "warnings": [{"code": "SKETCH_UNDER_CONSTRAINED"}]},
            "images": [{"name": "iso", "data": base64.b64encode(b"PNG").decode(), "mimeType": "image/png"}],
            "changes": changes, "highlighted": True, "artifact": {"path": "build/bracket.step", "sha256": "d" * 64},
        }
        request = AsyncMock(return_value=response)
        attach = AsyncMock()
        doc = cad.part.PartDocument(Path("parts/bracket.FCStd"), Path("build/bracket.step"))
        ops = [{"op": "set", "target": "bracket/hole", "prop": "Diameter", "value": 8}]
        with patch.object(part_module, "request", request), patch.object(part_module, "_attach_images", attach):
            result = asyncio.run(doc.apply(ops, message="wider hole", budget_s=45))
        request.assert_awaited_once_with(
            "part-apply", doc="parts/bracket.FCStd", output="build/bracket.step", ops=ops, validation="auto",
            message="wider hole", budgetS=45,
        )
        self.assertEqual(result.rev, 13)
        self.assertEqual(result.artifact.sha256, "d" * 64)
        self.assertEqual(result.artifact.role, "candidate")
        self.assertEqual(result.artifact.changes, changes)
        self.assertEqual(result.params, {"hole_d": [6, 8]})
        text = repr(result)
        self.assertIn("rev=13", text)
        self.assertIn("volume -4 mm³", text)
        self.assertIn("faces +3/-2", text)
        self.assertIn("warnings=1", text)
        args, kwargs = attach.await_args
        self.assertEqual(args[0], response["images"])
        self.assertEqual(kwargs["changes"], changes)
        self.assertTrue(kwargs["highlighted"])
        self.assertIn("rev 13", kwargs["subject"])

    def test_part_try_is_not_applied_and_labels_itself_a_trial(self) -> None:
        part_module = importlib.import_module("cad.part")
        response = {"part": {"rev": 4}, "images": [{"name": "iso", "data": "UE5H", "mimeType": "image/png"}], "changes": None, "highlighted": False}
        attach = AsyncMock()
        doc = cad.part.PartDocument(Path("parts/a.FCStd"), Path("build/a.step"))
        with patch.object(part_module, "request", AsyncMock(return_value=response)), patch.object(part_module, "_attach_images", attach):
            result = asyncio.run(doc.try_([{"op": "param", "name": "w", "value": 1}]))
        self.assertFalse(result.applied)
        self.assertIsNone(result.artifact)
        self.assertIn("not applied", repr(result))
        self.assertIn("trial", attach.await_args.kwargs["subject"])

    def test_part_error_fields_cross_the_client_boundary(self) -> None:
        client = importlib.import_module("cad.client")
        body = {
            "ok": False,
            "error": {
                "type": "PartOpError", "message": "bracket/edge failed to recompute", "code": "FILLET_FAILED",
                "target": "bracket/edge", "detail": {"failedOpIndex": 1, "freecadStatus": "BRep_API: command not done"},
                "hints": ["reduce radius"], "rolledBack": True,
            },
        }
        encoded = json.dumps(body).encode()

        class OneShotReader:
            def __init__(self) -> None:
                self._chunks = [encoded, b""]

            async def read(self, _limit: int) -> bytes:
                return self._chunks.pop(0)

        writer = SimpleNamespace(write=Mock(), drain=AsyncMock(), write_eof=Mock(), close=Mock(), wait_closed=AsyncMock())
        with (
            patch.dict(os.environ, {"PI_CAD_AUTHOR_SOCKET": "/run/pi-cad/authority.sock"}),
            patch.object(client.asyncio, "open_unix_connection", AsyncMock(return_value=(OneShotReader(), writer))),
        ):
            with self.assertRaises(cad.CadApiError) as raised:
                asyncio.run(client.request("part-apply", doc="parts/a.FCStd", ops=[]))
        error = raised.exception
        self.assertEqual(error.code, "FILLET_FAILED")
        self.assertEqual(error.target, "bracket/edge")
        self.assertEqual(error.detail["failedOpIndex"], 1)
        self.assertEqual(error.hints, ["reduce radius"])
        self.assertIs(error.rolled_back, True)
        self.assertEqual(error.error_type, "PartOpError")

    def test_errors_without_part_fields_keep_none_defaults(self) -> None:
        error = cad.CadApiError("plain")
        self.assertEqual((error.code, error.target, error.detail, error.hints, error.rolled_back), (None, None, None, None, None))

    def test_first_image_label_carries_the_change_summary(self) -> None:
        model_module = importlib.import_module("cad.model")
        attach = Mock()
        changes = {
            "schema": 1, "baseline": {"sha256": "c" * 64},
            "volumeMm3": {"before": 12000.0, "after": 11903.7, "delta": -96.3},
            "bboxMm": {"before": [40, 20, 10], "after": [40, 20, 10], "changed": False},
            "faces": {"before": 14, "after": 15, "new": 3, "removed": 2},
            "features": {"recomputed": ["bracket/mount_hole", "bracket/edge_round"]},
            "params": {"changed": {"hole_d": [6, 8]}},
            "intent": [{"path": "bracket/min_wall", "status": "pass", "value": 2.1, "limit": 2.0}],
        }
        images = [{"name": "iso", "data": base64.b64encode(b"a").decode(), "mimeType": "image/png"},
                  {"name": "front", "data": base64.b64encode(b"b").decode(), "mimeType": "image/png"}]
        with patch("IPython.display.display", attach):
            artifact = cad.ArtifactRef(Path("build/part.step"), "a" * 64, "candidate", changes)
            asyncio.run(model_module._attach_images(images, artifact, changes=changes, highlighted=True))
        label = attach.call_args_list[0].args[0]["text/plain"]
        self.assertIn("primary observation", label)
        self.assertIn("Changes since previous build: volume -96.3 mm³; faces +3/-2; bbox unchanged.", label)
        self.assertIn("Recomputed: bracket/mount_hole, bracket/edge_round. Params: hole_d 6→8.", label)
        self.assertIn("Highlighted in orange: faces changed by this build.", label)
        self.assertIn("Intent: bracket/min_wall pass (2.1 vs 2.0).", label)
        self.assertTrue(label.rstrip().endswith("[ISO]"))
        self.assertEqual(attach.call_args_list[1].args[0]["text/plain"], "[FRONT]")

    def test_change_text_is_short_and_handles_first_builds(self) -> None:
        from cad._changes import describe_changes

        self.assertEqual(describe_changes(None), [])
        self.assertEqual(describe_changes({"schema": 1, "baseline": None}), ["First build of this output: there is no previous build to compare."])
        many = {
            "baseline": {"sha256": "x"}, "volumeMm3": {"delta": 0}, "bboxMm": {"changed": True, "before": [1, 2, 3], "after": [1, 2, 4]},
            "faces": {"new": 0, "removed": 0},
            "features": {"recomputed": [f"p/f{i}" for i in range(9)]},
            "params": {"changed": {"a": [1, 2]}},
            "intent": [{"path": f"p/r{i}", "status": "fail"} for i in range(5)],
            "warnings": [{"code": "W", "target": "p/x"}],
        }
        lines = describe_changes(many, True)
        self.assertLessEqual(len(lines), 6)
        self.assertIn("volume unchanged", lines[0])
        self.assertIn("bbox 1×2×3 → 1×2×4 mm", lines[0])
        self.assertIn("…", lines[1])

    def test_artifact_ref_changes_do_not_alter_equality_or_snapshot(self) -> None:
        plain = cad.ArtifactRef(Path("build/a.step"), "a" * 64, "candidate")
        with_changes = cad.ArtifactRef(Path("build/a.step"), "a" * 64, "candidate", {"schema": 1})
        self.assertEqual(plain, with_changes)
        self.assertEqual(plain.__cad_snapshot__(), with_changes.__cad_snapshot__())
        self.assertNotIn("changes", repr(with_changes))

    def test_model_build_fills_changes_on_the_artifact_ref(self) -> None:
        model_module = importlib.import_module("cad.model")
        changes = {"schema": 1, "baseline": None}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "build" / "part.step"
            output.parent.mkdir()
            output.write_bytes(b"STEP")
            response = {
                "build": {"ok": True, "artifacts": [{"kind": "step", "sha256": "b" * 64}]},
                "images": [{"data": base64.b64encode(b"PNG").decode(), "mimeType": "image/png"}],
                "changes": changes, "highlighted": False,
            }
            attach = AsyncMock()
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", AsyncMock(return_value=response)), \
                    patch.object(model_module, "_attach_images", attach):
                artifact = asyncio.run(cad.model.build("part.py", "build/part.step"))
        self.assertEqual(artifact.changes, changes)
        self.assertEqual(attach.await_args.kwargs, {"changes": changes, "highlighted": False})


if __name__ == "__main__":
    unittest.main()
