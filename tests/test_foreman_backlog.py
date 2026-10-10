"""scripts/foreman_backlog.py: store format, record, aging, locations, move, brief, lock, CLI."""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import foreman_backlog as fb  # noqa: E402

T0 = "2026-01-01T00:00:00Z"
T1 = "2026-01-02T00:00:00Z"


def cand(kind="permission", text="builder asked twice for `git push`", evidence="asks=2"):
    return {"kind": kind, "candidate": text, "evidence": evidence}


class BacklogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="backlog_test_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.agent = self.tmp / "agent"
        self.agent.mkdir()
        self.ws = self.tmp / "proj"
        (self.ws / ".git").mkdir(parents=True)
        self.cfg = {}

    def rec(self, cands, session="s1", now=T0, **kw):
        return fb.record(cands, workspace_root=str(self.ws), session=session, cfg=self.cfg, agent_dir=str(self.agent),
                         now=now, **kw)

    def store(self, kind="permission"):
        return fb.store_path_for(kind, workspace_root=str(self.ws), cfg=self.cfg, agent_dir=str(self.agent))

    def entries(self, kind="permission"):
        return fb.load(self.store(kind)[0])

    def cli(self, *argv, code=0):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = fb.main(["--agent-dir", str(self.agent), "--cwd", str(self.ws)] + list(argv))
        self.assertEqual(rc, code, out.getvalue())
        return out.getvalue()

    def write_cfg(self, cfg):
        self.cfg = cfg
        (self.agent / "foreman.json").write_text(json.dumps(cfg))

    def test_create_and_format(self):
        [(eid, how)] = self.rec([cand(evidence="asks=2 in /some/dir/file.py")])
        self.assertEqual((len(eid), how), (12, "created"))
        path, origin = self.store()
        self.assertEqual(origin, "central")
        text = Path(path).read_text()
        self.assertTrue(text.startswith("# Retro backlog: proj-"))
        self.assertIn("```retro-entry\nid: %s\nkind: permission\n" % eid, text)
        self.assertIn("evidence: asks=2 in file.py", text)
        self.assertNotIn(str(self.tmp), text)
        [e] = self.entries()
        self.assertEqual((e["count"], e["sessions"], e["status"], e["first_seen"]), (1, ["s1"], "open", T0))

    def test_bump_and_same_session(self):
        self.rec([cand()])
        self.assertEqual(self.rec([cand(evidence="asks=3")], session="s1", now=T1)[0][1], "seen")
        self.assertEqual(self.entries()[0]["count"], 1)
        self.assertEqual(self.rec([cand(evidence="asks=4")], session="s2", now=T1)[0][1], "bumped")
        [e] = self.entries()
        self.assertEqual((e["count"], e["first_seen"], e["last_seen"], e["sessions"], e["evidence"]),
                         (2, T0, T1, ["s1", "s2"], "asks=4"))

    def test_unknown_keys_preserved(self):
        self.rec([cand()])
        path = self.store()[0]
        Path(path).write_text(Path(path).read_text().replace("status: open", "status: open\nnote: keep me"))
        self.rec([cand()], session="s2")
        self.assertEqual(self.entries()[0]["note"], "keep me")

    def test_expire_revive_and_purge(self):
        [(eid, _)] = self.rec([cand()])
        self.rec([cand(kind="rule", text="done one")])
        self.cli("expire", "--now", "2026-01-10T00:00:00Z")
        self.assertEqual({e["status"] for e in self.entries()}, {"open"})
        out = self.cli("--json", "list", "--kind", "rule")
        self.cli("mark", json.loads(out)[0]["id"], "done")
        self.cli("expire", "--now", "2026-01-16T00:00:00Z")
        st = {e["kind"]: e["status"] for e in self.entries()}
        self.assertEqual(st, {"permission": "expired", "rule": "done"})
        self.assertEqual(self.rec([cand()], session="s9", now="2026-01-20T00:00:00Z")[0], (eid, "bumped"))
        self.assertEqual(self.entries()[0]["status"], "open")
        # done and expired entries go after 90 days; the done one counts from its mark, not its last sighting.
        self.cli("expire", "--now", "2026-03-01T00:00:00Z")
        self.assertEqual(len(self.entries()), 2)
        far = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 100 * 86400))
        self.cli("expire", "--now", far)
        self.assertEqual(self.entries(), [])

    def test_workspace_key(self):
        key = fb.derive_key(str(self.ws))
        self.assertRegex(key, r"^proj-[0-9a-f]{8}$")
        self.assertEqual(fb.sanitize_key("bench/my task:1"), "bench/my-task-1")
        for bad in ("../x", "a/../b", "a/./b", ""):
            with self.assertRaises(ValueError):
                fb.sanitize_key(bad)
        self.cfg = {"retro": {"workspaceKey": "bench/task-7"}}
        path, _ = self.store()
        self.assertEqual(Path(path), self.agent / "pi-foreman" / "state" / "retro" / "backlog" / "bench" / "task-7.md")
        self.cfg = {"retro": {"backlogDir": str(self.tmp / "bl")}}
        self.assertEqual(Path(self.store()[0]).parent, self.tmp / "bl")

    def test_harness_bug_goes_global(self):
        self.cfg = {"retro": {"repoBacklog": [{"path": str(self.ws), "commit": False}]}}
        path, origin = self.store("harness-bug")
        self.assertEqual((Path(path).name, origin), ("global.md", "global"))
        self.rec([cand(kind="harness-bug", text="guard crashed")])
        self.assertIn("# Retro backlog: global", Path(path).read_text())

    def test_repo_backlog_path_and_glob(self):
        for p in (str(self.ws), str(self.tmp / "pr*")):
            self.cfg = {"retro": {"repoBacklog": [{"path": p, "commit": True}]}}
            path, origin = self.store()
            self.assertEqual((Path(path), origin), (self.ws / ".workflow" / "retro-backlog.md", "repo"))
        self.cfg = {"retro": {"repoBacklog": [{"path": str(self.tmp / "other"), "commit": True}]}}
        self.assertEqual(self.store()[1], "central")

    def test_move_both_ways(self):
        [(eid, _)] = self.rec([cand()])
        central = self.store()[0]
        out = self.cli("move", eid, "--to", "repo")
        self.assertIn("not in retro.repoBacklog", out)
        repo = self.ws / ".workflow" / "retro-backlog.md"
        self.assertEqual([e["id"] for e in fb.load(str(repo))], [eid])
        self.assertEqual(fb.load(central), [])
        self.cli("move", eid, "--to", "central")
        self.assertEqual([e["id"] for e in fb.load(central)], [eid])
        self.assertEqual(fb.load(str(repo)), [])

    def test_brief(self):
        for s in ("s1", "s2"):
            self.rec([cand(text="builder asked twice for `git push`"), cand(text="reviewer asks for `git push` too"),
                      cand(kind="skill", text="no skill for releases")], session=s)
        self.rec([cand(text="explorer read 40 files once")])
        out = self.tmp / "brief.md"
        self.cli("brief", "--out", str(out))
        text = out.read_text()
        self.assertIn("never starts a session", text)
        self.assertNotIn("explorer read 40", text)
        self.assertLess(text.index("## skill"), text.index("## permission"))
        block = text[text.index("## permission"):text.index("## Instructions")]
        self.assertIn("Complementary (git push)", block)
        lines = [ln for ln in block.splitlines() if ln.startswith("- ")]
        self.assertEqual(len(lines), 2)
        self.assertIn("count 2", lines[0])
        for want in ("Plan first", "Group complementary", "this session's decision", "foreman backlog mark <id> done"):
            self.assertIn(want, text)
        self.cli("brief")
        self.assertEqual(len(list((self.ws / ".workflow" / "scratch").glob("brief-lessons-*.md"))), 1)

    def test_lock_fresh_waits_stale_broken(self):
        path = self.store()[0]
        os.makedirs(os.path.dirname(path))
        lock = path + ".lock"
        Path(lock).write_text("1")
        with mock.patch.object(fb, "LOCK_TIMEOUT", 0.2):
            with self.assertRaises(fb.LockTimeout):
                self.rec([cand()])
            old = time.time() - 120
            os.utime(lock, (old, old))
            self.assertEqual(self.rec([cand()])[0][1], "created")
        self.assertFalse(os.path.exists(lock))

    def test_cli_list_json(self):
        self.rec([cand(), cand(kind="harness-bug", text="guard crashed")])
        self.rec([cand()], session="s2")
        rows = json.loads(self.cli("--json", "list"))
        self.assertEqual([(r["kind"], r["count"], r["origin"]) for r in rows],
                         [("permission", 2, "central"), ("harness-bug", 1, "global")])
        self.assertEqual(len(json.loads(self.cli("list", "--json", "--min-count", "2"))), 1)
        self.assertEqual(json.loads(self.cli("--json", "list", "--status", "done")), [])
        self.cli("show", "000000000000", code=1)


if __name__ == "__main__":
    unittest.main()
