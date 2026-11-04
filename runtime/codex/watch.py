#!/usr/bin/env python3
"""Container-compatible scheduler; every iteration uses the current Swift manager."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time
root = Path(sys.argv[1]).resolve()
with (root / 'watch.lock').open('a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(0)
    (root / 'watch.pid').write_text(str(os.getpid()) + '\n')
    while not (root / 'watch.disabled').exists():
        with (root / 'scheduler.log').open('ab') as log:
            subprocess.run([sys.executable, root / 'tools/manager.py', 'update', '--root', root],
                           stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        time.sleep(120)
