#!/usr/bin/env python3
"""One owned Linux Codex terminal refresh, without terminal input or Herdr resize.

TIOCGWINSZ followed by TIOCSWINSZ is a compare-then-set, not an atomic
kernel CAS. Rechecking all ownership guards immediately before each set
reduces that unavoidable interval; it cannot exclude a concurrent resize.
The same slave descriptor remains open until all conditional cleanup ends.
"""

import fcntl
import json
import os
import select
import signal
import socket
import stat
import struct
import sys
import termios
import time


MAX_LINE = 1024 * 1024
REQUEST_ID = "swift-terminal-refresh"
_stop_reason = None


class Refused(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def emit(kind, **fields):
    # A dead parent must not prevent conditional restoration in finally.
    try:
        sys.stdout.write(json.dumps(dict(type=kind, **fields), separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        global _stop_reason
        _stop_reason = _stop_reason or "PARENT_OUTPUT_CLOSED"
        # Avoid another flush of the broken pipe during interpreter shutdown.
        try:
            replacement = os.open(os.devnull, os.O_WRONLY)
            try:
                os.dup2(replacement, sys.stdout.fileno())
            finally:
                os.close(replacement)
        except OSError:
            pass


def stop(signum, _frame):
    global _stop_reason
    _stop_reason = "SIGNAL_" + signal.Signals(signum).name


class InputLines:
    def __init__(self, fd):
        self.fd = fd
        self.buffer = bytearray()
        self.eof = False
        os.set_blocking(fd, False)

    def read(self, deadline):
        while True:
            if _stop_reason:
                raise Refused(_stop_reason)
            end = self.buffer.find(b"\n")
            if end >= 0:
                if end > MAX_LINE:
                    raise Refused("INPUT_TOO_LARGE")
                line = bytes(self.buffer[:end])
                del self.buffer[:end + 1]
                try:
                    return json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeError):
                    raise Refused("INVALID_INPUT") from None
            if len(self.buffer) > MAX_LINE:
                raise Refused("INPUT_TOO_LARGE")
            if self.eof:
                if self.buffer:
                    raise Refused("INCOMPLETE_INPUT")
                raise Refused("PARENT_EOF")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Refused("HELPER_TIMEOUT")
            try:
                ready, _, _ = select.select([self.fd], [], [], min(remaining, 0.1))
                if ready:
                    chunk = os.read(self.fd, 65536)
                    if chunk:
                        self.buffer.extend(chunk)
                    else:
                        self.eof = True
            except InterruptedError:
                continue
            except BlockingIOError:
                continue


def positive_integer(value, code):
    if isinstance(value, bool):
        raise Refused(code)
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdecimal() and int(value) > 0:
        return int(value)
    raise Refused(code)


def parse_config(value):
    if not isinstance(value, dict):
        raise Refused("INVALID_CONFIG")
    config = dict(value)
    config["pid"] = positive_integer(value.get("pid"), "INVALID_PID")
    config["start"] = str(positive_integer(value.get("start"), "INVALID_START"))
    if not isinstance(value.get("tty"), str) or not value["tty"].startswith("/dev/"):
        raise Refused("INVALID_TTY")
    if not isinstance(value.get("socketPath"), str) or not value["socketPath"].startswith("/"):
        raise Refused("INVALID_SOCKET")
    identity = value.get("socketIdentity")
    if not isinstance(identity, dict):
        raise Refused("INVALID_SOCKET_IDENTITY")
    config["socketIdentity"] = {
        key: positive_integer(identity.get(key), "INVALID_SOCKET_IDENTITY")
        for key in ("dev", "ino", "ctimeNs")
    }
    guard = value.get("guard")
    if not isinstance(guard, dict) or not isinstance(guard.get("focus"), dict) or not isinstance(guard.get("pane"), dict):
        raise Refused("INVALID_GUARD")
    pane = guard["pane"]
    if not all(isinstance(pane.get(key), str) and pane[key] for key in ("pane_id", "terminal_id", "tab_id", "workspace_id")):
        raise Refused("INVALID_GUARD")
    if set(guard["focus"]) != {"focused_pane_id", "focused_workspace_id", "focused_tab_id"}:
        raise Refused("INVALID_GUARD")
    if guard["focus"]["focused_pane_id"] != pane["pane_id"]:
        raise Refused("TARGET_NOT_FOCUSED")
    if guard["focus"]["focused_workspace_id"] != pane["workspace_id"] or guard["focus"]["focused_tab_id"] != pane["tab_id"]:
        raise Refused("INVALID_GUARD")
    if guard.get("paneAgent") is not None and not isinstance(guard["paneAgent"], dict):
        raise Refused("INVALID_GUARD")
    if not isinstance(guard.get("layout"), dict) or guard["layout"].get("tab_id") != pane["tab_id"]:
        raise Refused("INVALID_GUARD")
    timeout = value.get("timeoutMs", 8000)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 100 <= timeout <= 15000:
        raise Refused("INVALID_TIMEOUT")
    config["timeoutMs"] = timeout
    return config


def process_state(pid):
    try:
        with open("/proc/%d/stat" % pid, "r", encoding="utf-8") as source:
            raw = source.read(65536)
        close = raw.rfind(")")
        opening = raw.find("(")
        fields = raw[close + 2:].split()
        if opening < 0 or close <= opening or len(fields) < 20:
            raise Refused("PROCESS_CHANGED")
        comm = raw[opening + 1:close]
        return {"comm": comm, "pgrp": int(fields[2]), "tty": int(fields[4]), "tpgid": int(fields[5]), "start": fields[19]}
    except (OSError, ValueError, IndexError):
        raise Refused("PROCESS_CHANGED") from None


def fd_identity(value):
    return (value.st_dev, value.st_ino, value.st_rdev)


def encoded_tty_device(rdev):
    major, minor = os.major(rdev), os.minor(rdev)
    if major > 0xfff or minor > 0xfffff:
        raise Refused("TTY_DEVICE_UNSUPPORTED")
    return (major << 8) | (minor & 0xff) | ((minor & 0xfff00) << 12)


def winsize(fd):
    try:
        return tuple(struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8)))
    except OSError:
        raise Refused("TTY_UNAVAILABLE") from None


def socket_identity(config):
    try:
        current = os.stat(config["socketPath"], follow_symlinks=False)
    except OSError:
        raise Refused("SOCKET_CHANGED") from None
    expected = config["socketIdentity"]
    if not stat.S_ISSOCK(current.st_mode) or (current.st_dev, current.st_ino, current.st_ctime_ns) != (expected["dev"], expected["ino"], expected["ctimeNs"]):
        raise Refused("SOCKET_CHANGED")


def snapshot(config):
    socket_identity(config)
    deadline = time.monotonic() + 1.0
    request = json.dumps({"id": REQUEST_ID, "method": "session.snapshot", "params": {}}, separators=(",", ":")).encode("utf-8") + b"\n"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(max(0.001, deadline - time.monotonic()))
            client.connect(config["socketPath"])
            socket_identity(config)
            client.settimeout(max(0.001, deadline - time.monotonic()))
            client.sendall(request)
            buffer = bytearray()
            while b"\n" not in buffer:
                if len(buffer) > MAX_LINE:
                    raise Refused("SNAPSHOT_TOO_LARGE")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise Refused("SNAPSHOT_TIMEOUT")
                client.settimeout(remaining)
                chunk = client.recv(min(65536, MAX_LINE + 1 - len(buffer)))
                if not chunk:
                    raise Refused("SNAPSHOT_EOF")
                buffer.extend(chunk)
            line = bytes(buffer).split(b"\n", 1)[0]
            if len(line) > MAX_LINE:
                raise Refused("SNAPSHOT_TOO_LARGE")
            response = json.loads(line.decode("utf-8"))
    except Refused:
        raise
    except (socket.timeout, TimeoutError):
        raise Refused("SNAPSHOT_TIMEOUT") from None
    except (OSError, ValueError, UnicodeError):
        raise Refused("SNAPSHOT_UNAVAILABLE") from None
    socket_identity(config)
    if not isinstance(response, dict) or response.get("id") != REQUEST_ID or response.get("error") is not None:
        raise Refused("SNAPSHOT_INVALID")
    result = response.get("result")
    if not isinstance(result, dict):
        raise Refused("SNAPSHOT_INVALID")
    result = result.get("snapshot", result)
    if not isinstance(result, dict):
        raise Refused("SNAPSHOT_INVALID")
    return result


def unique_item(items, field, expected, missing_code):
    if not isinstance(items, list):
        raise Refused(missing_code)
    matches = [item for item in items if isinstance(item, dict) and item.get(field) == expected]
    if len(matches) != 1:
        raise Refused(missing_code)
    return matches[0]


def same_subset(current, expected):
    return isinstance(current, dict) and json_equal({key: current.get(key) for key in expected}, expected)


def json_equal(left, right):
    # JSON booleans are not numbers (Python's built-in True == 1 is too lax).
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return set(left) == set(right) and all(json_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return type(left) is type(right) and left == right


def validate_snapshot(value, guard):
    if not json_equal({key: value.get(key) for key in guard["focus"]}, guard["focus"]):
        raise Refused("FOCUS_CHANGED")
    pane = unique_item(value.get("panes"), "pane_id", guard["pane"]["pane_id"], "PANE_CHANGED")
    if not same_subset(pane, guard["pane"]):
        raise Refused("PANE_CHANGED")
    agents = value.get("agents", [])
    if not isinstance(agents, list):
        raise Refused("AGENT_CHANGED")
    matches = [item for item in agents if isinstance(item, dict) and (item.get("pane_id") or (item.get("terminal", {}).get("pane_id") if isinstance(item.get("terminal"), dict) else None)) == guard["pane"]["pane_id"]]
    expected = guard.get("paneAgent")
    if expected is None:
        if matches:
            raise Refused("AGENT_CHANGED")
    elif len(matches) != 1 or not same_subset(matches[0], expected):
        raise Refused("AGENT_CHANGED")
    layout = unique_item(value.get("layouts"), "tab_id", guard["pane"]["tab_id"], "LAYOUT_CHANGED")
    if not json_equal(layout, guard["layout"]):
        raise Refused("LAYOUT_CHANGED")


class TerminalRefresh:
    def __init__(self, config, deadline=None):
        self.config = config
        self.fd = None
        self.identity = None
        self.foreground = None
        self.original = None
        self.temporary = None
        self.pending_restore = False
        self.narrowed_once = False
        self.deadline = deadline

    def validate_process(self):
        config = self.config
        proc = process_state(config["pid"])
        if proc["start"] != config["start"] or proc["comm"] != "codex":
            raise Refused("PROCESS_CHANGED")
        try:
            link = "/proc/%d/fd/0" % config["pid"]
            if os.readlink(link) != config["tty"] or not os.isatty(self.fd):
                raise Refused("TTY_CHANGED")
            held = os.fstat(self.fd)
            actual = os.stat(link)
            if not stat.S_ISCHR(held.st_mode) or fd_identity(held) != self.identity or fd_identity(actual) != self.identity:
                raise Refused("TTY_CHANGED")
            if (proc["tty"] & 0xffffffff) != encoded_tty_device(held.st_rdev):
                raise Refused("TTY_CHANGED")
            # tcgetpgrp(slave) requires the calling process's controlling tty;
            # this observer must never acquire it. Linux /proc/pid/stat field 8
            # exposes that target controlling tty's foreground process group.
            # Read it again with every other process identity field below.
            foreground = proc["tpgid"]
            if foreground <= 0 or proc["pgrp"] != foreground or (self.foreground is not None and foreground != self.foreground):
                raise Refused("FOREGROUND_CHANGED")
            # Repeat process identity after fd/foreground reads to reject exits
            # or PID reuse during validation. The following ioctl remains non-atomic.
            if process_state(config["pid"]) != proc or os.readlink(link) != config["tty"]:
                raise Refused("PROCESS_CHANGED")
            return foreground
        except Refused:
            raise
        except OSError:
            raise Refused("TTY_CHANGED") from None

    def validate_all(self, expected):
        self.validate_process()
        validate_snapshot(snapshot(self.config), self.config["guard"])
        self.validate_process()
        if winsize(self.fd) != expected:
            raise Refused("WINSIZE_CHANGED")

    def prepare(self):
        proc = process_state(self.config["pid"])
        if proc["start"] != self.config["start"] or proc["comm"] != "codex":
            raise Refused("PROCESS_CHANGED")
        try:
            self.fd = os.open("/proc/%d/fd/0" % self.config["pid"], os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
            self.identity = fd_identity(os.fstat(self.fd))
        except OSError:
            raise Refused("TTY_UNAVAILABLE") from None
        self.foreground = self.validate_process()
        self.original = winsize(self.fd)
        rows, cols, xpixel, ypixel = self.original
        if rows < 2 or cols < 3:
            raise Refused("WINSIZE_UNSUPPORTED")
        self.temporary = (rows, cols - 1, xpixel, ypixel)
        self.validate_all(self.original)
        emit("prepared", original=self.original, temporary=self.temporary,
             ttyIdentity=dict(zip(("dev", "ino", "rdev"), self.identity)), foregroundPgid=self.foreground)

    def set_size(self, expected, desired):
        self.validate_all(expected)
        if desired == self.temporary:
            if _stop_reason:
                raise Refused(_stop_reason)
            if self.deadline is not None and time.monotonic() >= self.deadline:
                raise Refused("HELPER_TIMEOUT")
            # Acquire conditional cleanup ownership only after every preflight
            # succeeds, immediately before our attempted mutating ioctl. An
            # external owner may already have chosen the temporary tuple.
            self.pending_restore = True
        try:
            # Mark restoration ownership before ioctl: interruption after a
            # successful set must still reach the conditional finally path.
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", *desired))
        except OSError:
            raise Refused("TTY_SET_FAILED") from None
        self.validate_process()
        if winsize(self.fd) != desired:
            raise Refused("WINSIZE_CHANGED")

    def narrow(self):
        if self.narrowed_once:
            raise Refused("ALREADY_ATTEMPTED")
        self.narrowed_once = True
        # An ioctl can complete even if an exception follows it. set_size marks
        # cleanup ownership after validation and just before its actual ioctl.
        self.set_size(self.original, self.temporary)
        emit("narrowed", temporary=self.temporary)

    def restore(self):
        if not self.pending_restore:
            raise Refused("NOT_NARROWED")
        try:
            self.set_size(self.temporary, self.original)
        except Refused as error:
            self.pending_restore = False
            emit("abandoned", code=error.code)
            return False
        self.pending_restore = False
        emit("restored", original=self.original)
        return True

    def cleanup(self):
        if self.fd is None:
            return
        try:
            if self.pending_restore:
                self.restore()
        finally:
            os.close(self.fd)
            self.fd = None


def main():
    refresh = None
    try:
        if sys.platform != "linux":
            raise Refused("UNSUPPORTED_PLATFORM")
        for name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(name, stop)
        reader = InputLines(sys.stdin.fileno())
        config = parse_config(reader.read(time.monotonic() + 8.0))
        deadline = time.monotonic() + config["timeoutMs"] / 1000.0
        refresh = TerminalRefresh(config, deadline)
        refresh.prepare()
        while True:
            message = reader.read(deadline)
            command = message.get("command") if isinstance(message, dict) else message
            if command == "narrow":
                refresh.narrow()
            elif command == "restore":
                if not refresh.restore():
                    return 2
                emit("done")
                return 0
            elif command == "abort":
                refresh.cleanup()
                emit("done", code="ABORTED")
                return 0
            else:
                raise Refused("INVALID_COMMAND")
    except Refused as error:
        emit("error", code=error.code)
        return 2
    except Exception:
        # Never serialize paths, private configuration or arbitrary exception data.
        emit("error", code="HELPER_FAILED")
        return 2
    finally:
        if refresh is not None:
            try:
                refresh.cleanup()
            except Exception:
                emit("abandoned", code="CLEANUP_FAILED")


if __name__ == "__main__":
    sys.exit(main())
