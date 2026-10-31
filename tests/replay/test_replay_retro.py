"""Replay: ledger hints, compaction digest and retro files (D8) on the fake provider.

The foreman writes a ledger, marks item 1 (hint), launches a reviewer citing item 2 (launch hint),
whose PASS (no per-item lines, so the harness marks nothing) adds a verdict hint. The notice turn reports 90000 tokens:
above the idle floor (50000) and below Pi's threshold (100000), so only the idle warm compaction runs (docs/cache.md), with
the Retro instructions (docs/retro.md); the fake summary then ends with `## Retro`. After it:
`.workflow/retro/<session>.md` holds the counters and that section, V has a `retro written` hint and
the next request's pi-foreman section carries the digest naming the ledger. `/retro --model` sent as
an RPC prompt runs the extension command, and the foreman's one reply is appended to the state file.
The warm path is set up as in test_replay_idle_cache.py: fake claude-bridge provider with prompt cache, cacheWarming
"idle", keep-alive with warmCompact and compactMinTokens 0, but with a 60 s cache TTL (see WARM_CONFIG). Same prerequisites and skips as test_replay.py.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from driver import load_fixture, wait_until  # noqa: E402
from test_replay_idle_cache import BRIDGE, CONFIG, ENV, SETTINGS  # noqa: E402
from test_replay import REASON, ReplayCase  # noqa: E402

# The ledger flow gets no Pi refresh (the hook never ran in this scenario), so the cache must still count as warm when the
# window's compaction check lands 30 s after the settle: a 60 s TTL instead of idle_cache's 20 s.
WARM_CONFIG = json.loads(json.dumps(CONFIG))
WARM_CONFIG["providers"][BRIDGE]["cache"]["ttlSeconds"] = 60

HINT = r"\n  > \d{4}-\d{2}-\d{2} "


def read(p):
    try:
        return p.read_text("utf-8")
    except OSError:
        return ""


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class TestRetro(ReplayCase):
    def test_hints_digest_and_retro_files(self):
        rig = self.rig("retro", load_fixture("retro"), providers=(BRIDGE,), config=WARM_CONFIG, settings=SETTINGS)
        (rig.project / "a.txt").write_text("alpha\n", "utf-8")
        reqs = rig.root / "requests.log"
        pi = rig.start(provider=BRIDGE, env=dict(ENV, FOREMAN_FAKE_REQUESTS=str(reqs)))
        sid = pi.session_id()
        pi.prompt("[[replay:rt1]] build it", timeout=60)
        pi.wait_child_notify(timeout=180)

        retro_dir = rig.project / ".workflow" / "retro"
        files = wait_until(lambda: list(retro_dir.glob("*.md")) if retro_dir.is_dir() else [], timeout=120)
        self.assertEqual(len(files), 1, files)
        # the file is appended to: wait until the Retro section it carries is complete, not just present
        text = wait_until(lambda: (lambda t: t if "- fake: enhance the brief" in t else "")(read(files[0])),
                          describe=lambda t: t)
        self.assertIn("compaction (manual)", text)
        self.assertRegex(text, r"counters: denies=\d+ rereviews=\d+ budget_hits=\d+ rung_up=\d+")
        self.assertIn("- fake: missing an allow rule\n- fake: enhance the brief", text)

        # The adapter writes the retro file and the V hint one after the other in the compaction callback, so the file being
        # complete does not mean the hint is in the ledger yet. Wait on the hint itself; `read` returns "" while Windows
        # holds the ledger (the hint's rename), and the poll then tries again.
        ledger = rig.project / ".workflow" / "LEDGER-rt.md"
        led = wait_until(lambda: (lambda t: t if "retro written" in t else "")(read(ledger)), describe=lambda t: t)
        self.assertIn("retro written", led)
        self.assertEqual([r for recs in rig.traces().values() for r in recs if r.get("event") == "hint_write_failed"], [])
        self.assertRegex(led, r"- \[x\] 1\. a" + HINT + r"ledger mark\n")
        self.assertRegex(led, r"- \[ \] 2\. b" + HINT + r"reviewer launched \(run \S+\)" + HINT + r"review PASS \(run \S+\)\n")
        self.assertRegex(led, r"- \[ \] V\. fresh-eyes verification passed" + HINT + r"retro written\n")

        before = len(read(reqs).splitlines())
        pi.prompt("[[replay:rt3]] next", timeout=60)
        last = wait_until(lambda: read(reqs).splitlines()[before:],
                          describe=lambda _: "request log lines: %d" % len(read(reqs).splitlines()))
        req = last[0]
        self.assertIn("## Compaction digest", req)
        self.assertIn("LEDGER-rt.md is the source of truth", req)
        self.assertIn("Closed since the last compaction: 1", req)

        pi.prompt("/retro --model", timeout=30)
        state = rig.state_dir / "retro" / ("retro-%s.md" % re.sub(r"[^A-Za-z0-9._-]", "_", sid))
        out = wait_until(lambda: (lambda t: t if "### Model retro" in t else "")(read(state)), describe=lambda t: t)
        pi.close()
        self.assertIn("/retro", out)
        self.assertIn("friction: rereviews=", out)
        self.assertIn("### Model retro\n\n- fake model retro: missing a test fixture", out)


if __name__ == "__main__":
    unittest.main()
