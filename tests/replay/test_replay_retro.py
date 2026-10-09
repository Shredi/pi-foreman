"""Replay: ledger hints, compaction digest and retro files (D8) on the fake provider.

The foreman writes a ledger, marks item 1 (hint), launches a reviewer citing item 2 (launch hint),
whose PASS (no per-item lines, so the harness marks nothing) adds a verdict hint. The notice turn reports a context near the window, so the price-tier
compaction runs with the Retro instructions; the fake summary then ends with `## Retro`. After it:
`.workflow/retro/<session>.md` holds the counters and that section, V has a `retro written` hint and
the next request's pi-foreman section carries the digest naming the ledger. `/retro --model` sent as
an RPC prompt runs the extension command, and the foreman's one reply is appended to the state file.
Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import re
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

HINT = r"\n  > \d{4}-\d{2}-\d{2} "


def wait_for(fn, timeout=60.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        v = fn()
        if v:
            return v
        time.sleep(0.25)
    return fn()


def read(p):
    try:
        return p.read_text("utf-8")
    except OSError:
        return ""


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRetro(ReplayCase):
    def test_hints_digest_and_retro_files(self):
        rig = self.rig("retro", load_fixture("retro"), settings={"compaction": {"keepRecentTokens": 1}})
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        reqs = rig.root / "requests.log"
        pi = rig.start(env={"FOREMAN_FAKE_REQUESTS": str(reqs)})
        sid = pi.session_id()
        pi.prompt("[[replay:rt1]] build it", timeout=60)
        pi.wait_child_notify(timeout=180)

        retro_dir = rig.project / ".workflow" / "retro"
        files = wait_for(lambda: list(retro_dir.glob("*.md")) if retro_dir.is_dir() else [])
        self.assertEqual(len(files), 1, files)
        text = read(files[0])
        self.assertIn("compaction (manual)", text)
        self.assertRegex(text, r"counters: denies=\d+ rereviews=\d+ budget_hits=\d+ rung_up=\d+")
        self.assertIn("- fake: missing an allow rule\n- fake: enhance the brief", text)

        ledger = rig.project / ".workflow" / "LEDGER-rt.md"
        led = wait_for(lambda: (lambda t: t if "retro written" in t else "")(read(ledger)))
        self.assertRegex(led, r"- \[x\] 1\. a" + HINT + r"ledger mark\n")
        self.assertRegex(led, r"- \[ \] 2\. b" + HINT + r"reviewer launched \(run \S+\)" + HINT + r"review PASS \(run \S+\)\n")
        self.assertRegex(led, r"- \[ \] V\. fresh-eyes verification passed" + HINT + r"retro written\n")

        before = len(read(reqs).splitlines())
        pi.prompt("[[replay:rt3]] next", timeout=60)
        last = read(reqs).splitlines()[before:]
        self.assertTrue(last, "the rt3 request reached the provider")
        req = last[0]
        self.assertIn("## Compaction digest", req)
        self.assertIn("LEDGER-rt.md is the source of truth", req)
        self.assertIn("Closed since the last compaction: 1", req)

        pi.prompt("/retro --model", timeout=30)
        state = rig.state_dir / "retro" / ("retro-%s.md" % re.sub(r"[^A-Za-z0-9._-]", "_", sid))
        out = wait_for(lambda: (lambda t: t if "### Model retro" in t else "")(read(state)))
        pi.close()
        self.assertIn("/retro", out)
        self.assertIn("friction: rereviews=", out)
        self.assertIn("### Model retro\n\n- fake model retro: missing a test fixture", out)


if __name__ == "__main__":
    unittest.main()
