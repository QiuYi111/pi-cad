"""Background threads (pure Python). They never touch the Fusion API.

The watcher only reports job ids through `fire(job_id)` (the add-in passes
app.fireCustomEvent); the heartbeat writer uses a cached snapshot that the main thread refreshes.
"""
import os
import threading
import time

import jobs
import jobroot


class HeartbeatState(object):
    def __init__(self, **kw):
        self._lock = threading.Lock()
        self._d = dict(kw)

    def update(self, **kw):
        with self._lock:
            self._d.update(kw)

    def get(self):
        with self._lock:
            return dict(self._d)


class HeartbeatWriter(threading.Thread):
    def __init__(self, fdir, state, interval=5.0, pid=None, on_tick=None):
        threading.Thread.__init__(self, name="ReifyHeartbeat", daemon=True)
        self.fdir, self.state, self.interval = fdir, state, interval
        self.pid = pid or os.getpid()
        self.on_tick = on_tick  # e.g. fires a custom event so the main thread refreshes the snapshot
        self._stop_evt = threading.Event()

    def write_once(self):
        s = self.state.get()
        jobs.atomic_write_json(jobroot.heartbeat_path(self.fdir), jobs.heartbeat_payload(
            self.pid, s.get("version"), s.get("app"), s.get("signedIn")))

    def run(self):
        while not self._stop_evt.is_set():
            try:
                self.write_once()
                if self.on_tick:
                    self.on_tick()
            except Exception:  # noqa: BLE001 - keep beating
                pass
            self._stop_evt.wait(self.interval)

    def stop(self):
        self._stop_evt.set()
        self.join(timeout=2.0)
        try:
            os.remove(jobroot.heartbeat_path(self.fdir))
        except OSError:
            pass


class InboxWatcher(threading.Thread):
    def __init__(self, fdir, fire, interval=1.0, refire_after=20.0):
        threading.Thread.__init__(self, name="ReifyInboxWatcher", daemon=True)
        self.inbox = jobroot.inbox_dir(fdir)
        self.fire, self.interval, self.refire_after = fire, interval, refire_after
        self._fired = {}
        self._stop_evt = threading.Event()

    def poll_once(self, now=None):
        now = time.time() if now is None else now
        pending = jobs.list_pending(self.inbox)
        for gone in [k for k in self._fired if k not in pending]:
            del self._fired[gone]
        for job_id in pending:
            if now - self._fired.get(job_id, -1e9) >= self.refire_after:
                self._fired[job_id] = now
                self.fire(job_id)

    def run(self):
        while not self._stop_evt.is_set():
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001
                pass
            self._stop_evt.wait(self.interval)

    def stop(self):
        self._stop_evt.set()
        self.join(timeout=2.0)
