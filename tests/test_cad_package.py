from __future__ import annotations

import dataclasses
import ast
import asyncio
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, patch

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

    def test_probe_arguments_cross_as_json_literals(self) -> None:
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
        self.assertIsInstance(keyword.value, ast.Constant)
        self.assertEqual(keyword.value.value, payload)

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
            response = {"build": envelope, "images": [str(Path(directory) / "iso.png")]}
            attach = AsyncMock()
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}), \
                    patch.object(model_module, "request", AsyncMock(return_value=response)), \
                    patch.object(model_module, "_attach_images", attach):
                artifact = asyncio.run(cad.model.build("part.py", "build/part.step"))
            self.assertEqual(artifact.sha256, "b" * 64)
            self.assertEqual(artifact.path, Path("build/part.step"))
            attach.assert_awaited_once_with([str(Path(directory) / "iso.png")])

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

    def test_commit_rejects_artifacts_outside_the_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": directory}):
                with self.assertRaisesRegex(cad.CadApiError, "escapes the project root"):
                    asyncio.run(cad.commit("candidate-build", artifacts=[Path(directory).parent / "outside.py"]))

    def test_workflow_discovery_start_and_advance_use_the_generic_bridge(self) -> None:
        workflow_module = importlib.import_module("cad.workflow")
        mocked = AsyncMock(side_effect=[
            [{"id": "mechanical.one-shot", "description": "Design", "tags": ["cad"], "version": "1.0.0"}],
            {"workflowId": "mechanical.one-shot", "phase": "grill"},
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

    def test_review_submit_is_an_ordinary_rlm_template(self) -> None:
        self.assertFalse(hasattr(cad.review, "current"))
        fake_rlm = ModuleType("rlm")
        handle = SimpleNamespace(rlm_child_id="child-1", name="reviewer")
        fake_rlm.run = AsyncMock(return_value=handle)
        commit_id = "commit-" + "a" * 32
        with patch.dict(sys.modules, {"rlm": fake_rlm}):
            returned = asyncio.run(cad.review.submit(commit_id))
        self.assertIs(returned, handle)
        prompt = fake_rlm.run.await_args.args[0]
        self.assertIn(commit_id, prompt)
        self.assertIn("await cad.load", prompt)
        self.assertIn("agent_message", prompt)
        self.assertNotIn("transcript import", prompt.lower())

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


if __name__ == "__main__":
    unittest.main()
