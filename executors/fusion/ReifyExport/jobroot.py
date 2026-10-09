"""Job root resolution (pure Python, no adsk).

protocol.md section 2: Windows %LOCALAPPDATA%\\Reify\\transfer,
macOS ~/Library/Application Support/Reify/transfer.
REIFY_TRANSFER_ROOT overrides (used by tests and by the desktop app in dev).
"""
import os
import sys

ENV_OVERRIDE = "REIFY_TRANSFER_ROOT"


class JobRootError(Exception):
    pass


def job_root(env=None, platform=None, home=None):
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    override = env.get(ENV_OVERRIDE)
    if override:
        return override
    home = home or os.path.expanduser("~")
    if platform.startswith("win"):
        base = env.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        return os.path.join(base, "Reify", "transfer")
    if platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "Reify", "transfer")
    raise JobRootError("unsupported platform %r (Fusion add-in supports windows|mac)" % platform)


def fusion_dir(root=None):
    return os.path.join(root or job_root(), "fusion")


def inbox_dir(fdir):
    return os.path.join(fdir, "inbox")


def outbox_dir(fdir, job_id=None):
    base = os.path.join(fdir, "outbox")
    return base if job_id is None else os.path.join(base, job_id)


def heartbeat_path(fdir):
    return os.path.join(fdir, "heartbeat.json")


def ensure_dirs(fdir):
    os.makedirs(inbox_dir(fdir), exist_ok=True)
    os.makedirs(outbox_dir(fdir), exist_ok=True)
