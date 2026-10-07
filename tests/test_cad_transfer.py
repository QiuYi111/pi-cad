from __future__ import annotations

import asyncio
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import cad

WIRE_RESULT = {
    "target": "fusion", "file": "exports/bracket.f3d", "checkStep": "build/transfer/j1/check.step",
    "check": "passed", "features": 7, "log": "build/transfer/j1/log.txt", "detail": None,
}


class CadTransferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transfer_module = importlib.import_module("cad.transfer")
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        env = patch.dict(os.environ, {"PI_CAD_PROJECT_CWD": self.directory.name})
        env.start()
        self.addCleanup(env.stop)

    def _patch_request(self, response=None, error=None) -> AsyncMock:
        mocked = AsyncMock(return_value=response, side_effect=error)
        patcher = patch.object(self.transfer_module, "request", mocked)
        patcher.start()
        self.addCleanup(patcher.stop)
        return mocked

    def test_the_module_is_exported(self) -> None:
        self.assertIs(cad.transfer, self.transfer_module)
        self.assertIn("transfer", cad.__all__)

    def test_status_returns_a_short_repr(self) -> None:
        request = self._patch_request({"fusion": "ready", "solidworks": "not_installed", "detail": {"fusion": {"addin": "0.1.0"}}})
        result = asyncio.run(cad.transfer.status())
        request.assert_awaited_once_with("transfer-status")
        self.assertEqual(repr(result), "TransferStatus(fusion='ready', solidworks='not_installed')")
        self.assertEqual(result.detail["fusion"]["addin"], "0.1.0")

    def test_features_accepts_a_path_or_a_part_document(self) -> None:
        wire = {"part": "bracket", "features": 7, "path": "build/transfer/bracket.features.json", "data": {"schema": "reify.features/1"}}
        request = self._patch_request({**wire, "features": 7})
        by_path = asyncio.run(cad.transfer.features("parts/bracket.FCStd"))
        self.assertEqual(by_path.data, {"schema": "reify.features/1"})
        request.assert_awaited_with("transfer-features", doc="parts/bracket.FCStd")
        self.assertEqual(
            repr(by_path), "TransferFeatures(part='bracket', features=7, path='build/transfer/bracket.features.json')"
        )
        handle = cad.part.PartDocument(Path("parts/axle.FCStd"), Path("build/axle.step"))
        asyncio.run(cad.transfer.features(handle))
        request.assert_awaited_with("transfer-features", doc="parts/axle.FCStd")

    def test_features_rejects_other_documents_and_paths_outside_the_project(self) -> None:
        self._patch_request({})
        with self.assertRaises(cad.CadApiError) as raised:
            asyncio.run(cad.transfer.features("parts/bracket.step"))
        self.assertEqual(raised.exception.code, "BAD_REQUEST")
        with self.assertRaisesRegex(cad.CadApiError, "escapes the project root"):
            asyncio.run(cad.transfer.features("../outside.FCStd"))

    def test_unsupported_op_error_carries_the_code_and_the_feature_path(self) -> None:
        error = cad.CadApiError(
            "fillet is not supported", error_type="TransferError", code="TRANSFER_UNSUPPORTED_OP",
            target="bracket/round_edges", detail={"op": "fillet"},
        )
        self._patch_request(error=error)
        with self.assertRaises(cad.CadApiError) as raised:
            asyncio.run(cad.transfer.features("parts/bracket.FCStd"))
        self.assertEqual(raised.exception.code, "TRANSFER_UNSUPPORTED_OP")
        self.assertEqual(raised.exception.target, "bracket/round_edges")

    def test_export_returns_a_job_and_the_result_has_a_short_repr(self) -> None:
        request = self._patch_request(WIRE_RESULT)

        async def scenario() -> cad.transfer.TransferResult:
            job = await cad.transfer.export("parts/bracket.FCStd", target="fusion", output="exports/bracket.f3d")
            self.assertIn("TransferJob(target='fusion'", repr(job))
            return await job.result()

        result = asyncio.run(scenario())
        request.assert_awaited_once_with(
            "transfer-export", doc="parts/bracket.FCStd", target="fusion", output="exports/bracket.f3d", check=True,
        )
        self.assertEqual(
            repr(result), "TransferResult(target='fusion', file='exports/bracket.f3d', check='passed', features=7)"
        )
        self.assertEqual(result.check_step, "build/transfer/j1/check.step")
        self.assertEqual(result.log, "build/transfer/j1/log.txt")

    def test_export_default_output_depends_on_the_target(self) -> None:
        request = self._patch_request({**WIRE_RESULT, "target": "solidworks", "file": "exports/bracket.SLDPRT"})

        async def scenario() -> None:
            await (await cad.transfer.export("parts/bracket.FCStd", target="fusion")).result()
            await (await cad.transfer.export("parts/bracket.FCStd", target="solidworks", check=False)).result()

        asyncio.run(scenario())
        first, second = request.await_args_list
        self.assertEqual(first.kwargs["output"], "exports/bracket.f3d")
        self.assertEqual(second.kwargs["output"], "exports/bracket.SLDPRT")
        self.assertFalse(second.kwargs["check"])

    def test_skipped_check_is_reported(self) -> None:
        self._patch_request({**WIRE_RESULT, "check": "skipped", "checkStep": None})

        async def scenario() -> cad.transfer.TransferResult:
            return await (await cad.transfer.export("parts/bracket.FCStd", target="fusion", check=False)).result()

        result = asyncio.run(scenario())
        self.assertEqual(result.check, "skipped")
        self.assertIsNone(result.check_step)

    def test_export_validates_target_and_output_before_any_request(self) -> None:
        request = self._patch_request(WIRE_RESULT)

        async def run(**kwargs) -> None:
            await cad.transfer.export("parts/bracket.FCStd", **kwargs)

        with self.assertRaisesRegex(cad.CadApiError, "target must be one of"):
            asyncio.run(run(target="catia"))
        with self.assertRaisesRegex(cad.CadApiError, r"must end in \.f3d"):
            asyncio.run(run(target="fusion", output="exports/bracket.SLDPRT"))
        with self.assertRaisesRegex(cad.CadApiError, "escapes the project root"):
            asyncio.run(run(target="fusion", output="../bracket.f3d"))
        request.assert_not_awaited()

    def test_failed_jobs_raise_the_stable_error_codes(self) -> None:
        for code in (
            "TRANSFER_TARGET_NOT_READY", "TRANSFER_EXECUTOR_FAILED", "TRANSFER_CHECK_FAILED",
            "TRANSFER_TIMEOUT", "TRANSFER_UNAVAILABLE",
        ):
            with self.subTest(code=code):
                self._patch_request(error=cad.CadApiError(
                    "failed", error_type="TransferError", code=code, hints=["Settings > CAD exports"],
                    detail={"feature": "bracket/base"},
                ))

                async def scenario() -> None:
                    job = await cad.transfer.export("parts/bracket.FCStd", target="fusion")
                    await job.result()

                with self.assertRaises(cad.CadApiError) as raised:
                    asyncio.run(scenario())
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(raised.exception.detail, {"feature": "bracket/base"})

    def test_result_round_trips_through_a_snapshot(self) -> None:
        result = cad.transfer._result_from_wire({**WIRE_RESULT, "detail": {"feature": "bracket/base"}})
        encoded = cad.snapshot.registry.encode(result)
        self.assertEqual(encoded["codec"], "cad.transfer")
        decoded = cad.snapshot.registry.decode(encoded)
        self.assertEqual(decoded, result)
        self.assertIsInstance(decoded, cad.transfer.TransferResult)

    def test_a_result_can_be_stored_in_a_commit(self) -> None:
        result = cad.transfer._result_from_wire(WIRE_RESULT)
        commit_request = AsyncMock(return_value={
            "id": "c1", "name": "export", "parent": None, "workflowHash": "w", "phase": "p", "createdAt": "now", "artifacts": [],
        })
        with patch("cad.request", commit_request):
            asyncio.run(cad.commit("export", variables={"transfer": result}))
        sent = commit_request.await_args.kwargs["variables"]["transfer"]
        self.assertEqual(sent["codec"], "cad.transfer")


if __name__ == "__main__":
    unittest.main()
