"""Install the fake `hc` (tests/fakes/hc.py) into a bin dir the test puts first on PATH."""
from __future__ import annotations

import shutil
import stat
import sys
from pathlib import Path

FAKE = Path(__file__).resolve().parent / "hc.py"


def install_fake_hc(bin_dir) -> Path:
    """POSIX: executable script `hc`; win32: `hc.cmd` + `hc.py`. Returns bin_dir (the dir to put first on PATH)."""
    bin_dir = Path(bin_dir)
    bin_dir.mkdir(parents=True, exist_ok=True)
    py = sys.executable
    if sys.platform == "win32":
        shutil.copyfile(FAKE, bin_dir / "hc.py")
        (bin_dir / "hc.cmd").write_bytes(f'@"{py}" "%~dp0hc.py" %*\r\n'.encode("utf-8"))
    else:
        script = bin_dir / "hc"
        script.write_text(f'#!/bin/sh\nexec "{py}" "{FAKE}" "$@"\n', encoding="utf-8")
        script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir
