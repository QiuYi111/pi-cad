"""Tie a cadctl kernel to the process that owns it.

A kernel is started by an authority process or by the resident runtime and is
only useful while that owner is alive. An owner can die in ways that run no
cleanup at all: ``SIGKILL`` runs no handler, and a process that dies from a
signal never reaches its exit hooks. The kernel therefore has to watch the
owner itself.

Ownership is explicit. The spawner passes its own pid -- and the start time
that pid had -- in the environment, and only a process that was handed that
identity is watched. A kernel a person started by hand gets no identity and
keeps its old behaviour. When the owner is gone the kernel kills the process
tree it started and exits; it never looks for, or touches, another run's
processes.
"""

from __future__ import annotations

import ctypes
import errno
import os
import signal
import threading
import time
from pathlib import Path
from typing import Mapping, NamedTuple

OWNER_PID_ENV = "PI_CAD_OWNER_PID"
OWNER_START_ENV = "PI_CAD_OWNER_START"
DEFAULT_POLL_MS = 100

# `prctl(PR_SET_PDEATHSIG, ...)`: the kernel signals the caller when its
# parent dies, which is the one thing a SIGKILLed parent cannot do itself.
_PR_SET_PDEATHSIG = 1
_PR_SET_PDEATHSIG_ARG = signal.SIGKILL


class OwnerIdentity(NamedTuple):
    pid: int
    start_time: str | None


class ProcessFacts(NamedTuple):
    state: str
    ppid: int
    start_time: str


def parse_proc_stat(raw: bytes) -> ProcessFacts | None:
    """Read the fields Reify needs out of one `/proc/<pid>/stat` line.

    `comm` can hold spaces and parentheses, so every field is read from the
    last `)` onwards: there `state` is the first token and `starttime` -- which
    tells a live owner apart from a recycled pid -- is the twentieth.
    """
    end = raw.rfind(b")")
    if end < 0:
        return None
    fields = raw[end + 2 :].split()
    if len(fields) < 20:
        return None
    try:
        return ProcessFacts(
            state=fields[0].decode("ascii"),
            ppid=int(fields[1]),
            start_time=fields[19].decode("ascii"),
        )
    except (UnicodeDecodeError, ValueError):
        return None


def read_proc_stat(pid: int) -> ProcessFacts | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_bytes()
    except OSError:
        return None
    return parse_proc_stat(raw)


def owner_identity(env: Mapping[str, str] | None = None) -> OwnerIdentity | None:
    source = os.environ if env is None else env
    raw = (source.get(OWNER_PID_ENV) or "").strip()
    if not raw:
        return None
    try:
        pid = int(raw)
    except ValueError:
        return None
    if pid <= 0 or pid == os.getpid():
        return None
    started = (source.get(OWNER_START_ENV) or "").strip() or None
    return OwnerIdentity(pid, started)


def owner_alive(owner: OwnerIdentity) -> bool:
    facts = read_proc_stat(owner.pid)
    if facts is None:
        # No stat line: either the pid is gone, or this kernel may not read it.
        # A pid we can signal but not read belongs to someone else and lives.
        try:
            os.kill(owner.pid, 0)
        except OSError as error:
            return error.errno == errno.EPERM
        return True
    if facts.state == "Z":
        # A zombie has already exited; its children were reparented at exit.
        return False
    if owner.start_time is not None and facts.start_time != owner.start_time:
        # The pid was recycled by an unrelated process.
        return False
    return True


def owned_processes(root: int | None = None) -> list[int]:
    """Every live process under `root`, deepest first, read straight from /proc."""
    here = os.getpid() if root is None else root
    children: dict[int, list[int]] = {}
    try:
        entries = os.listdir("/proc")
    except OSError:
        return []
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        facts = read_proc_stat(pid)
        if facts is None or facts.state == "Z":
            continue
        children.setdefault(facts.ppid, []).append(pid)
    ordered: list[int] = []

    def walk(pid: int) -> None:
        for child in children.get(pid, []):
            walk(child)
        if pid != here:
            ordered.append(pid)

    walk(here)
    return ordered


def terminate_owned_processes(root: int | None = None) -> int:
    """SIGKILL everything this process started, children before their parents."""
    killed = 0
    for pid in owned_processes(root):
        # A forked build child calls `setsid()`, so the group is where its own
        # subprocesses live. The direct signal covers the window before that.
        for send in (
            lambda target=pid: os.killpg(target, signal.SIGKILL),
            lambda target=pid: os.kill(target, signal.SIGKILL),
        ):
            try:
                send()
                killed += 1
                break
            except OSError:
                continue
    return killed


def detach_from_parent() -> None:
    """Make this process die with its parent even if the parent is SIGKILLed.

    `PR_SET_PDEATHSIG` is the kernel's own answer to an owner that cannot run
    cleanup. The classic race -- the parent dying before the signal is armed --
    is closed by re-reading the parent pid right after arming it.
    """
    parent = os.getppid()
    if not set_parent_death_signal():
        return
    if os.getppid() != parent:
        os._exit(1)


def set_parent_death_signal(signum: int = signal.SIGKILL) -> bool:
    """Ask the kernel to kill this process when its parent dies.

    This is the only owner-death signal that still lands while the process is
    stopped: `SIGSTOP` freezes every thread, so no Python code runs, but the
    kernel delivers the signal regardless. Best effort, Linux-only; callers
    keep their own fallback.
    """
    try:
        libc = ctypes.CDLL(None, use_errno=True)
    except Exception:  # noqa: BLE001 - best effort, and Linux-only
        return False
    try:
        return libc.prctl(_PR_SET_PDEATHSIG, signum, 0, 0, 0) == 0
    except Exception:  # noqa: BLE001 - best effort, and Linux-only
        return False


def arm_owner_death_signal(
    identity: OwnerIdentity | None = None,
    parent_pid: int | None = None,
) -> bool:
    """Make the kernel kill this process when the process that owns it dies.

    The warm kernel watches its owner in a thread, but a stopped process runs
    no threads: a kernel that was `SIGSTOP`ped outlives an owner that was
    killed and only leaves once it is resumed. `PR_SET_PDEATHSIG` closes that
    hole because the kernel, not the process, watches the parent.

    The kernel only watches the parent, so this is armed when the spawner
    really is the parent -- which is how the runtime starts the warm kernel. A
    launcher in between (`uv run … python -m cadctl.worker`) owns that slot
    instead; there the watchdog stays the only owner-death signal, and the
    spawner that inserts one is the spawner that has to drop it. A worker that
    was never handed an owner identity (a hand-started one) is never armed.
    """
    owner = identity if identity is not None else owner_identity()
    if owner is None:
        return False
    parent = os.getppid() if parent_pid is None else parent_pid
    if parent != owner.pid:
        return False
    if not set_parent_death_signal(_PR_SET_PDEATHSIG_ARG):
        return False
    # The owner can die between reading the parent above and arming the
    # signal; re-reading the parent proves the armed signal has a live target.
    return os.getppid() == parent


def release_from_owner() -> None:
    """The owner is gone: leave nothing of this kernel running."""
    terminate_owned_processes()
    os._exit(1)


def watch_signals() -> None:
    """A real stop must take the forked build children with it.

    The build child leaves the worker's process group, so a signal sent to the
    group only reaches the worker. Stopping the worker is therefore also the
    moment to stop what the worker started.
    """

    def handler(signum: int, _frame: object) -> None:
        terminate_owned_processes()
        os._exit(128 + signum)

    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(signum, handler)
        except (ValueError, OSError):
            continue


def start_watchdog(
    identity: OwnerIdentity | None = None,
    poll_ms: int | None = None,
) -> bool:
    """Watch the owner in a daemon thread; returns False when nothing owns us."""
    owner = identity if identity is not None else owner_identity()
    if owner is None:
        return False
    configured = poll_ms if poll_ms is not None else _configured_poll_ms()
    interval = max(0.02, configured / 1000.0)
    threading.Thread(
        target=_watch,
        args=(owner, interval),
        name="pi-cad-owner-watch",
        daemon=True,
    ).start()
    return True


def _configured_poll_ms() -> int:
    raw = (os.environ.get("PI_CAD_OWNER_POLL_MS") or "").strip()
    try:
        return int(raw)
    except ValueError:
        return DEFAULT_POLL_MS


def _watch(owner: OwnerIdentity, interval: float) -> None:
    while True:
        time.sleep(interval)
        if owner_alive(owner):
            continue
        release_from_owner()
        return
