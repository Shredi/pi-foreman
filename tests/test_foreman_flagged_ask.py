"""R31c: flagged asks (`ask_flag` trace events) -> retro candidates -> backlog kind flagged-ask (global store only, complete command), grouped listing."""
from __future__ import annotations

import contextlib
import io
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_backlog as fb  # noqa: E402
import foreman_retro as fr  # noqa: E402

T0 = "2026-01-01T00:00:00Z"
LONG = "grep -c x /state/trace-01a.jsonl | cut -c1-700 | head -5 " + "&& echo padding " * 30  # well over MAX_TEXT, with a path


def flag(family="state_usage_read", cls="state_usage_read", rule="state-protect", command=LONG):
    return {"event": "ask_flag", "family": family, "class": cls, "rule": rule, "command": command, "decision": "approved"}


class FlaggedAskTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="flagged_test_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agent = self.tmp / "agent"
        self.agent.mkdir()
        self.ws = self.tmp / "proj"
        (self.ws / ".git").mkdir(parents=True)
        (self.ws / ".workflow").mkdir()
        self.cfg = {}

    def rec(self, cands, session="s1"):
        return fb.record(cands, workspace_root=str(self.ws), session=session, cfg=self.cfg, agent_dir=str(self.agent), now=T0)

    def cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = fb.main(["--agent-dir", str(self.agent), "--cwd", str(self.ws)] + list(argv))
        self.assertEqual(rc, 0, out.getvalue())
        return out.getvalue()

    def test_retro_candidates_carry_family_and_complete_command(self):
        cands = [c for c in fr.candidates({}, [flag()], [], None) if c["kind"] == "flagged-ask"]
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0]["family"], "state_usage_read")
        self.assertEqual(cands[0]["evidence"], LONG)
        self.assertIn("via state-protect", cands[0]["candidate"])

    def test_P1_filed_into_the_global_store_only(self):
        # a committed repo store exists for this workspace: a flagged ask must not touch it
        repo_store = Path(fb.repo_store(str(self.ws)))
        repo_store.write_text("# Retro backlog: repo\n")
        before = repo_store.read_text()
        [c] = [c for c in fr.candidates({}, [flag()], [], None) if c["kind"] == "flagged-ask"]
        [(eid, how)] = self.rec([c])
        self.assertEqual(how, "created")
        path, origin = fb.store_path_for("flagged-ask", workspace_root=str(self.ws), cfg=self.cfg, agent_dir=str(self.agent))
        self.assertEqual(origin, "global")
        self.assertEqual(repo_store.read_text(), before)
        text = Path(path).read_text()
        self.assertIn("kind: flagged-ask", text)
        self.assertIn("family: state_usage_read", text)
        [e] = fb.load(path)
        self.assertEqual(e["evidence"], " ".join(LONG.split()))  # complete, not cut at MAX_TEXT, not path-scrubbed
        self.assertGreater(len(e["evidence"]), fb.MAX_TEXT)
        self.assertIn("/state/trace-01a.jsonl", e["evidence"])

    def test_other_kinds_keep_their_cap_and_scrub(self):
        self.rec([{"kind": "permission", "candidate": "allow x", "evidence": "in /some/dir/file.py " + "y " * 200}])
        path, _ = fb.store_path_for("permission", workspace_root=str(self.ws), cfg=self.cfg, agent_dir=str(self.agent))
        [e] = fb.load(path)
        self.assertLessEqual(len(e["evidence"]), fb.MAX_TEXT)
        self.assertNotIn("/some/dir", e["evidence"])

    def test_P2_list_groups_by_family(self):
        cs = [fr_c for ev in (flag(), flag(), flag("trace_read", "trace_read", "r2", "cat y"), flag("trace_read", "trace_read", "r3", "cat z"))
              for fr_c in fr.candidates({}, [ev], [], None)]
        for i, c in enumerate(cs):
            self.rec([c], session="s%d" % i)
        out = self.cli("list", "--kind", "flagged-ask")
        self.assertIn("flagged asks: state_usage_read (x", out)
        self.assertIn("flagged asks: trace_read (x2)", out)
        self.assertEqual(out.count("flagged asks:"), 2)
        self.assertEqual(sum(1 for line in out.splitlines() if line.startswith("  ")), 3)  # three entries below the two headers
        self.assertLess(out.index("state_usage_read"), out.index("flagged asks: trace_read"))  # larger family total first

    def test_P3_retro_section(self):
        self.assertEqual(fr.flagged_counts([flag(), flag(), flag("trace_read")]), {"state_usage_read": 2, "trace_read": 1})
        self.assertIsNone(fr.flagged_counts(None))
        rep = {"session": "s", "review": None, "trace": None, "usage": None, "explorer": None, "cache": None, "session_tools": None,
               "proposals": None, "flagged_asks": {"state_usage_read": 2}}
        self.assertIn("Flagged asks: state_usage_read=2", fr.render_text(rep).replace(" ", "").replace("Flaggedasks:", "Flagged asks: "))

    def test_P4_other_kinds_list_as_today(self):
        self.rec([{"kind": "permission", "candidate": "allow bash pattern git push", "evidence": "asks=2"}])
        out = self.cli("list")
        self.assertNotIn("flagged asks:", out)
        self.assertIn("allow bash pattern git push", out)


if __name__ == "__main__":
    unittest.main()
