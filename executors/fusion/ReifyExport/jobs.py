"""Job claiming, validation and results (pure, no adsk). protocol.md section 2."""
import datetime
import json
import os
import re
import time

import jobroot
import plan as planmod

JOB_SCHEMA = "reify.transfer.job/1"
RESULT_SCHEMA = "reify.transfer.result/1"
HEARTBEAT_SCHEMA = "reify.transfer.heartbeat/1"
EXECUTOR_NAME = "ReifyExport"
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class JobError(Exception):
    def __init__(self, message, code="EXECUTOR_FAILED", feature=None, step="job"):
        Exception.__init__(self, message)
        self.message, self.code, self.feature, self.step = message, code, feature, step


class ExecError(Exception):
    """Raised by the executor layer; carries the semantic feature name and step."""

    def __init__(self, message, feature=None, step="exec", code="EXECUTOR_FAILED"):
        Exception.__init__(self, message)
        self.message, self.code, self.feature, self.step = message, code, feature, step


def utc_now_iso(ts=None):
    d = datetime.datetime.fromtimestamp(time.time() if ts is None else ts, datetime.timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def atomic_write_json(path, obj):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=2)
        fh.flush()
        try:
            os.fsync(fh.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def valid_job_id(job_id):
    return bool(_ID_RE.match(job_id or "")) and ".." not in job_id


def list_pending(inbox):
    """Job ids waiting in the inbox (ignores *.tmp and anything else)."""
    try:
        names = os.listdir(inbox)
    except OSError:
        return []
    return sorted(n[:-5] for n in names if n.endswith(".json") and not n.endswith(".tmp"))


def claim_job(fdir, job_id):
    """Atomically move inbox/<id>.json -> outbox/<id>/job.json. Returns the new path or None.

    None means somebody else claimed it, or it is a duplicate id (the file is parked as
    <id>.json.rejected so it is not retried forever).
    """
    if not valid_job_id(job_id):
        return None
    src = os.path.join(jobroot.inbox_dir(fdir), job_id + ".json")
    out = jobroot.outbox_dir(fdir, job_id)
    dst = os.path.join(out, "job.json")
    if not os.path.exists(src):
        return None
    if os.path.exists(dst):
        try:
            os.replace(src, src + ".rejected")
        except OSError:
            pass
        return None
    os.makedirs(out, exist_ok=True)
    try:
        os.rename(src, dst)  # rename, not replace: fails on Windows if dst appeared meanwhile
    except OSError:
        return None
    return dst


def load_job(path, job_id):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except (OSError, ValueError) as e:
        raise JobError("cannot read job.json: %s" % e)
    if not isinstance(job, dict) or job.get("schema") != JOB_SCHEMA:
        raise JobError("job schema must be %s" % JOB_SCHEMA)
    if job.get("jobId") != job_id:
        raise JobError("jobId %r does not match file name %r" % (job.get("jobId"), job_id))
    if job.get("target") != "fusion":
        raise JobError("target must be 'fusion', got %r" % job.get("target"))
    kind = job.get("kind", "part")
    if kind not in ("part", "assembly"):
        raise JobError("job.kind must be 'part' or 'assembly', got %r" % kind)
    if kind == "assembly":
        if not isinstance(job.get("assembly"), dict):
            raise JobError("job.assembly missing")
    elif not isinstance(job.get("features"), dict):
        raise JobError("job.features missing")
    out = job.get("output") or {}
    native = out.get("native", "part.f3d")
    check_step = out.get("check_step", "check.step")
    for nm in (native, check_step):
        if not _FILE_RE.match(nm or "") or nm in ("result.json", "log.txt", "job.json"):
            raise JobError("bad output file name %r" % nm)
    if not native.lower().endswith(".f3d"):
        raise JobError("output.native must end in .f3d")
    timeout = job.get("timeoutS", 300)
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise JobError("timeoutS must be a positive number")
    return {"job": job, "kind": kind, "native": native, "check_step": check_step,
            "check": bool(job.get("check", True)), "timeout": float(timeout)}


def error_from_exception(exc, current_feature=None):
    """Map any exception to the result.json error shape {code,message,feature,step}."""
    if isinstance(exc, planmod.PlanError):
        return {"code": exc.code, "message": exc.message, "feature": exc.feature, "step": exc.step}
    if isinstance(exc, (JobError, ExecError)):
        return {"code": exc.code, "message": exc.message, "feature": exc.feature or current_feature, "step": exc.step}
    return {"code": "EXECUTOR_FAILED", "message": "%s: %s" % (type(exc).__name__, exc),
            "feature": current_feature, "step": "exec"}


class JobLog(object):
    def __init__(self, path):
        self._fh = open(path, "a", encoding="utf-8")

    def __call__(self, msg):
        self._fh.write("%s %s\n" % (utc_now_iso(), msg))
        self._fh.flush()

    def close(self):
        try:
            self._fh.close()
        except OSError:
            pass


def build_result(job_id, ok, info, files=None, built=0, volumes=None, error=None, warnings=None):
    return {"schema": RESULT_SCHEMA, "jobId": job_id, "ok": ok, "target": "fusion",
            "executor": {"name": EXECUTOR_NAME, "version": info["version"], "app": info["app"]},
            "files": files or {"native": None, "check_step": None, "log": "log.txt"},
            "features_built": built, "feature_volumes": volumes or [], "warnings": warnings or [], "error": error}


def process_job(fdir, job_id, executor, info, busy=False):
    """Claim and run one job. Always ends by writing result.json (atomically).

    executor.run(plan, outbox_dir, native, check_step_or_None, log, deadline) must return
    {"features_built": int, "feature_volumes": [...]} or raise ExecError.
    Returns the result dict, or None if the job could not be claimed.
    """
    dst = claim_job(fdir, job_id)
    if dst is None:
        return None
    out = os.path.dirname(dst)
    log = JobLog(os.path.join(out, "log.txt"))
    result_path = os.path.join(out, "result.json")
    progress = {"feature": None}
    try:
        log("claimed job %s" % job_id)
        if busy:
            raise JobError("add-in is busy with another job", code="BUSY")
        spec = load_job(dst, job_id)
        if spec["kind"] == "assembly":
            built_plan = planmod.build_assembly_plan(spec["job"]["assembly"])
            log("plan: assembly with %d occurrences" % len(built_plan["occurrences"]))
        else:
            built_plan = planmod.build_plan(spec["job"]["features"])
            log("plan: %d steps" % len(built_plan["steps"]))
        deadline = time.time() + spec["timeout"]
        res = executor.run(built_plan, out, spec["native"], spec["check_step"] if spec["check"] else None,
                           log, deadline, progress)
        files = {"native": spec["native"], "check_step": spec["check_step"] if spec["check"] else None, "log": "log.txt"}
        warnings = list(built_plan.get("warnings", [])) + list(res.get("warnings", []))
        result = build_result(job_id, True, info, files, res["features_built"], res["feature_volumes"], warnings=warnings)
        log("done ok")
    except Exception as e:  # noqa: BLE001 - every failure must become a result.json
        err = error_from_exception(e, progress["feature"])
        log("FAILED %s" % json.dumps(err))
        result = build_result(job_id, False, info, error=err)
    finally:
        log.close()
    atomic_write_json(result_path, result)
    return result


def heartbeat_payload(pid, version, app, signed_in, ts=None):
    return {"schema": HEARTBEAT_SCHEMA, "pid": pid, "version": version, "app": app,
            "updatedAt": utc_now_iso(ts), "signedIn": signed_in}
