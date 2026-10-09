import json
import os
import tempfile
import unittest

import _path  # noqa: F401
import jobroot
import jobs
import plan
import workers

INFO = {"version": "0.1.0", "app": "Fusion test"}


class OkExecutor(object):
    def run(self, p, out, native, check_step, log, deadline, progress):
        progress["feature"] = "plate/base"
        for nm in [native] + ([check_step] if check_step else []):
            with open(os.path.join(out, nm), "w") as fh:
                fh.write("x")
        return {"features_built": 4, "feature_volumes": [{"name": "plate/base", "volume_mm3": 1.0}]}


class FailExecutor(object):
    def run(self, p, out, native, check_step, log, deadline, progress):
        progress["feature"] = "plate/holes"
        raise jobs.ExecError("boom", step="extrude")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fdir = jobroot.fusion_dir(self.tmp.name)
        jobroot.ensure_dirs(self.fdir)

    def tearDown(self):
        self.tmp.cleanup()

    def put(self, job_id="j1", **over):
        job = {"schema": jobs.JOB_SCHEMA, "jobId": job_id, "target": "fusion", "features": _path.sample(),
               "output": {"native": "part.f3d", "check_step": "check.step"}, "check": True, "timeoutS": 60}
        job.update(over)
        path = os.path.join(jobroot.inbox_dir(self.fdir), job_id + ".json")
        jobs.atomic_write_json(path, job)
        return path

    def result(self, job_id="j1"):
        with open(os.path.join(jobroot.outbox_dir(self.fdir, job_id), "result.json")) as fh:
            return json.load(fh)


class ClaimTests(Base):
    def test_claim_moves_file_once(self):
        src = self.put()
        dst = jobs.claim_job(self.fdir, "j1")
        self.assertTrue(os.path.isfile(dst))
        self.assertFalse(os.path.exists(src))
        self.assertIsNone(jobs.claim_job(self.fdir, "j1"))

    def test_bad_ids_and_duplicates(self):
        self.assertIsNone(jobs.claim_job(self.fdir, "../x"))
        self.put()
        jobs.claim_job(self.fdir, "j1")
        src = self.put()  # same id again
        self.assertIsNone(jobs.claim_job(self.fdir, "j1"))
        self.assertTrue(os.path.exists(src + ".rejected"))
        self.assertEqual(jobs.list_pending(jobroot.inbox_dir(self.fdir)), [])

    def test_list_pending_ignores_tmp(self):
        self.put("a")
        open(os.path.join(jobroot.inbox_dir(self.fdir), "b.json.tmp"), "w").close()
        self.assertEqual(jobs.list_pending(jobroot.inbox_dir(self.fdir)), ["a"])


class ProcessTests(Base):
    def test_success_result_shape(self):
        self.put()
        res = jobs.process_job(self.fdir, "j1", OkExecutor(), INFO)
        on_disk = self.result()
        self.assertEqual(res, on_disk)
        self.assertEqual(on_disk["schema"], "reify.transfer.result/1")
        self.assertTrue(on_disk["ok"])
        self.assertEqual(on_disk["files"], {"native": "part.f3d", "check_step": "check.step", "log": "log.txt"})
        self.assertEqual(on_disk["executor"], {"name": "ReifyExport", "version": "0.1.0", "app": "Fusion test"})
        self.assertEqual(on_disk["features_built"], 4)
        self.assertIsNone(on_disk["error"])
        out = jobroot.outbox_dir(self.fdir, "j1")
        self.assertTrue(os.path.isfile(os.path.join(out, "log.txt")))
        self.assertFalse(os.path.exists(os.path.join(out, "result.json.tmp")))

    def test_check_false_skips_step(self):
        self.put(check=False)
        res = jobs.process_job(self.fdir, "j1", OkExecutor(), INFO)
        self.assertIsNone(res["files"]["check_step"])

    def test_executor_failure_mapping(self):
        self.put()
        res = jobs.process_job(self.fdir, "j1", FailExecutor(), INFO)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], {"code": "EXECUTOR_FAILED", "message": "boom", "feature": "plate/holes", "step": "extrude"})

    def test_unsupported_op_mapping(self):
        f = _path.sample()
        f["bodies"][0]["features"].append({"name": "plate/chamfer", "type": "shell"})
        self.put(features=f)
        res = jobs.process_job(self.fdir, "j1", OkExecutor(), INFO)
        self.assertEqual((res["error"]["code"], res["error"]["feature"], res["error"]["step"]), ("UNSUPPORTED_OP", "plate/chamfer", "plan"))

    def test_generic_exception_keeps_current_feature(self):
        class Boom(object):
            def run(self, p, out, native, check_step, log, deadline, progress):
                progress["feature"] = "plate/base"
                raise KeyError("x")
        self.put()
        res = jobs.process_job(self.fdir, "j1", Boom(), INFO)
        self.assertEqual(res["error"]["code"], "EXECUTOR_FAILED")
        self.assertEqual(res["error"]["feature"], "plate/base")

    def test_validation_failures(self):
        for over in ({"schema": "nope"}, {"target": "solidworks"}, {"jobId": "other"},
                     {"output": {"native": "../x.f3d"}}, {"output": {"native": "part.step"}}, {"timeoutS": 0}):
            self.put(**over)
            res = jobs.process_job(self.fdir, "j1", OkExecutor(), INFO)
            self.assertFalse(res["ok"], over)
            self.assertEqual(res["error"]["code"], "EXECUTOR_FAILED")
            os.remove(os.path.join(jobroot.outbox_dir(self.fdir, "j1"), "job.json"))
            os.remove(os.path.join(jobroot.outbox_dir(self.fdir, "j1"), "result.json"))

    def test_invalid_json_still_gets_result(self):
        with open(os.path.join(jobroot.inbox_dir(self.fdir), "j2.json"), "w") as fh:
            fh.write("{not json")
        res = jobs.process_job(self.fdir, "j2", OkExecutor(), INFO)
        self.assertFalse(res["ok"])
        self.assertEqual(self.result("j2")["jobId"], "j2")

    def test_busy(self):
        self.put()
        res = jobs.process_job(self.fdir, "j1", OkExecutor(), INFO, busy=True)
        self.assertEqual(res["error"]["code"], "BUSY")

    def test_unclaimable_returns_none(self):
        self.assertIsNone(jobs.process_job(self.fdir, "nope", OkExecutor(), INFO))

    def test_atomic_write_leaves_no_tmp(self):
        p = os.path.join(self.tmp.name, "x", "y.json")
        jobs.atomic_write_json(p, {"a": 1})
        jobs.atomic_write_json(p, {"a": 2})
        self.assertEqual(sorted(os.listdir(os.path.dirname(p))), ["y.json"])
        self.assertEqual(json.load(open(p)), {"a": 2})


class WorkerTests(Base):
    def test_heartbeat_shape_and_removal(self):
        st = workers.HeartbeatState(version="0.1.0", app="Fusion 2.0", signedIn=True)
        hb = workers.HeartbeatWriter(self.fdir, st, interval=0.05)
        hb.write_once()
        with open(jobroot.heartbeat_path(self.fdir)) as fh:
            d = json.load(fh)
        self.assertEqual((d["schema"], d["pid"], d["version"], d["app"], d["signedIn"]),
                         ("reify.transfer.heartbeat/1", os.getpid(), "0.1.0", "Fusion 2.0", True))
        self.assertRegex(d["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        hb.start()
        hb.stop()
        self.assertFalse(os.path.exists(jobroot.heartbeat_path(self.fdir)))

    def test_watcher_fires_once_then_refires(self):
        fired = []
        w = workers.InboxWatcher(self.fdir, fired.append, refire_after=10)
        self.put("a")
        w.poll_once(now=100.0)
        w.poll_once(now=101.0)
        self.assertEqual(fired, ["a"])
        w.poll_once(now=111.0)
        self.assertEqual(fired, ["a", "a"])
        jobs.claim_job(self.fdir, "a")
        w.poll_once(now=200.0)
        self.assertEqual(fired, ["a", "a"])


class JobRootTests(unittest.TestCase):
    def test_roots(self):
        self.assertEqual(jobroot.job_root(env={"REIFY_TRANSFER_ROOT": "/t"}, platform="linux"), "/t")
        self.assertEqual(jobroot.job_root(env={"LOCALAPPDATA": "C:\\L"}, platform="win32"), os.path.join("C:\\L", "Reify", "transfer"))
        self.assertEqual(jobroot.job_root(env={}, platform="darwin", home="/Users/a"),
                         os.path.join("/Users/a", "Library", "Application Support", "Reify", "transfer"))
        with self.assertRaises(jobroot.JobRootError):
            jobroot.job_root(env={}, platform="linux")


if __name__ == "__main__":
    unittest.main()
