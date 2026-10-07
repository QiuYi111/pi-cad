"""ReifyExport: Autodesk Fusion add-in that executes Reify cad.transfer jobs.

Threading model (Fusion API is not thread safe):
  - watcher thread: lists <jobRoot>/fusion/inbox and only calls app.fireCustomEvent(JOB_EVENT, jobId)
  - heartbeat thread: writes heartbeat.json from a cached snapshot (never calls adsk)
  - custom event handler (MAIN thread): claims the job and runs ALL Fusion API calls
"""
import os
import sys
import traceback

__version__ = "0.1.0"

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import adsk.core
    import adsk.fusion
except ImportError:  # imported by tests outside Fusion
    adsk = None

import jobroot
import jobs
import workers

JOB_EVENT = "ReifyExportJobEvent"
TICK_EVENT = "ReifyExportTickEvent"

_state = {"handlers": [], "watcher": None, "beat": None, "fdir": None, "busy": False, "executor": None}


def _app():
    return adsk.core.Application.get()


def _snapshot():
    """Main-thread only: gather app facts for the heartbeat."""
    app = _app()
    signed_in = None
    try:
        user = app.currentUser
        signed_in = bool(user and user.userId) and not app.isOffline
    except Exception:  # noqa: BLE001 UNVERIFIED: currentUser/isOffline availability
        pass
    return {"version": __version__, "app": "Fusion " + str(app.version), "signedIn": signed_in}


def _log_ui(msg):
    try:
        _app().log("ReifyExport: " + msg)
    except Exception:  # noqa: BLE001
        pass


def _run_job(job_id):
    import fusion_exec
    if _state["executor"] is None:
        _state["executor"] = fusion_exec.FusionExecutor(_app())
    ex = _state["executor"]
    info = {"version": __version__, "app": ex.app_version()}
    busy = _state["busy"]
    _state["busy"] = True
    try:
        res = jobs.process_job(_state["fdir"], job_id, ex, info, busy=busy)
    finally:
        _state["busy"] = busy
    if res is not None:
        _log_ui("job %s %s" % (job_id, "ok" if res["ok"] else "failed: " + str(res["error"])))
    _state["beat_state"].update(**_snapshot())


if adsk:
    class _JobHandler(adsk.core.CustomEventHandler):
        def notify(self, args):
            try:
                _run_job(args.additionalInfo)
            except Exception:  # noqa: BLE001
                _log_ui("handler error:\n" + traceback.format_exc())

    class _TickHandler(adsk.core.CustomEventHandler):
        def notify(self, args):
            try:
                _state["beat_state"].update(**_snapshot())
            except Exception:  # noqa: BLE001
                pass


def run(context):
    try:
        app = _app()
        fdir = jobroot.fusion_dir()
        jobroot.ensure_dirs(fdir)
        _state["fdir"] = fdir
        _state["beat_state"] = workers.HeartbeatState(**_snapshot())

        for ev, handler in ((JOB_EVENT, _JobHandler()), (TICK_EVENT, _TickHandler())):
            try:
                app.unregisterCustomEvent(ev)  # leftover from a crashed run
            except Exception:  # noqa: BLE001
                pass
            custom = app.registerCustomEvent(ev)
            custom.add(handler)
            _state["handlers"].append((ev, custom, handler))  # keep references alive

        _state["beat"] = workers.HeartbeatWriter(fdir, _state["beat_state"], interval=5.0,
                                                on_tick=lambda: _app().fireCustomEvent(TICK_EVENT, ""))
        _state["beat"].start()
        _state["watcher"] = workers.InboxWatcher(fdir, lambda jid: _app().fireCustomEvent(JOB_EVENT, jid))
        _state["watcher"].start()
        _log_ui("started v%s, job root %s" % (__version__, fdir))
    except Exception:  # noqa: BLE001
        _log_ui("run failed:\n" + traceback.format_exc())
        stop(context)


def stop(context):
    try:
        for key in ("watcher", "beat"):
            t = _state.get(key)
            if t is not None:
                t.stop()
                _state[key] = None
        app = _app()
        for ev, custom, handler in _state["handlers"]:
            try:
                custom.remove(handler)
            except Exception:  # noqa: BLE001
                pass
            try:
                app.unregisterCustomEvent(ev)
            except Exception:  # noqa: BLE001
                pass
        _state["handlers"] = []
        _state["executor"] = None
    except Exception:  # noqa: BLE001
        _log_ui("stop failed:\n" + traceback.format_exc())
