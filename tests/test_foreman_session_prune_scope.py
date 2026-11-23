"""`foreman session prune` inside a session acts only on the entries that session opened; `--all` and a plain shell keep the whole registry."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_remote_reap as rr  # noqa: E402
import test_foreman_session_prune as sp  # noqa: E402

fs = sp.fs
SKIP = "(opened by another session; --all includes it)"


class LocalScope(sp.Prune):
    def entries(self):
        return [sp.entry("mine", parent="me"), sp.entry("theirs", parent="other"), sp.entry("orphan")]

    def prune(self, *extra, env=None):
        env = dict(env or {})
        with mock.patch.dict(fs.os.environ, env):
            return self.run_prune(set(), extra=extra)

    def test_own_entry_is_pruned_and_foreign_ones_are_skipped_and_named(self):
        self.write(self.entries())
        text = self.prune("--parent-id", "me")
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "open", "orphan": "open"})
        self.assertIn("1 pruned", text)
        self.assertIn("skipped theirs  theirs  " + SKIP, text)
        self.assertIn("skipped orphan  orphan  " + SKIP, text)  # no `parent` recorded counts as another session's
        self.assertEqual(text.count("skipped theirs"), 1)

    def test_env_id_scopes_the_same_way(self):
        self.write(self.entries())
        self.prune(env={"PI_INTERCOM_SESSION_ID": "me"})
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "open", "orphan": "open"})
        self.write(self.entries())
        self.prune(env={"PI_INTERCOM_SESSION_ID": "", "PI_INTERCOM_STABLE_ID": "other"})
        self.assertEqual(self.statuses(), {"mine": "open", "theirs": "closed", "orphan": "open"})

    def test_all_prunes_every_entry(self):
        self.write(self.entries())
        text = self.prune("--parent-id", "me", "--all")
        self.assertEqual(set(self.statuses().values()), {"closed"})
        self.assertNotIn("skipped", text)

    def test_no_id_prunes_every_entry(self):
        self.write(self.entries())
        text = self.prune(env={"PI_INTERCOM_SESSION_ID": "", "PI_INTERCOM_STABLE_ID": ""})
        self.assertEqual(set(self.statuses().values()), {"closed"})
        self.assertNotIn("skipped", text)

    def test_dry_run_names_what_it_skips(self):
        self.write(self.entries())
        text = self.prune("--parent-id", "me", "--dry-run")
        self.assertIn("would prune mine", text)
        self.assertIn("skipped theirs", text)
        self.assertNotIn("would prune theirs", text)


class RemoteScope(rr.ReapBase):
    def seed_two(self, status="closing", mine_parent="me", their_parent="other"):
        rows = []
        for label, parent, address in (("mine", mine_parent, "alpha/t1"), ("theirs", their_parent, "alpha/t2")):
            row = {"label": label, "child": "fm-%s-abc123" % label, "status": status, "machine": "alpha",
                   "hc": {"address": address, "space": None, "tab": None}, "handoff": "/h/x"}
            if parent is not None:
                row["parent"] = parent
            rows.append(row)
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"version": 1, "sessions": rows}), "utf-8")
        self.set_terminal("alpha/t1", "finished")
        self.set_terminal("alpha/t2", "finished")

    def statuses(self):
        return {r["label"]: r["status"] for r in self.parent_registry()}

    def test_a_finished_terminal_of_another_session_is_left_alone(self):
        self.seed_two()
        code, out, err = self.run_main("prune", "--parent-id", "me")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.hc_calls("rm"), [["rm", "alpha/t1"]])
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "closing"})
        self.assertEqual(out.count("skipped theirs"), 1)
        self.assertIn("skipped theirs  fm-theirs-abc123  " + SKIP, out)

    def test_a_missing_parent_is_skipped(self):
        self.seed_two(their_parent=None)
        self.assertEqual(self.run_main("prune", "--parent-id", "me")[0], 0)
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "closing"})

    def test_all_removes_both(self):
        self.seed_two()
        self.assertEqual(self.run_main("prune", "--parent-id", "me", "--all")[0], 0)
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "closed"})

    def test_no_id_removes_both(self):
        self.seed_two()
        code, out, err = self.run_main("prune")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.statuses(), {"mine": "closed", "theirs": "closed"})
        self.assertNotIn("skipped", out)

    def test_the_expired_attempt_pass_respects_the_scope(self):
        self.seed_two(status="open")
        path = self.padir / "pi-foreman" / "state" / "sessions.json"
        reg = json.loads(path.read_text("utf-8"))
        for r in reg["sessions"]:
            r["closeTriedAt"] = 1.0  # long expired
        path.write_text(json.dumps(reg), "utf-8")
        self.assertEqual(self.run_main("prune", "--parent-id", "me")[0], 0)
        rows = {r["label"]: r for r in self.parent_registry()}
        self.assertEqual(rows["mine"]["status"], "closed")
        self.assertEqual(rows["theirs"]["status"], "open")
        self.assertEqual(rows["theirs"].get("closeTriedAt"), 1.0)


class MessagesAndDocs(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_docs_do_not_promise_that_prune_removes_a_running_terminal(self):
        text = (self.ROOT / "docs" / "sessions.md").read_text("utf-8")
        self.assertNotIn("remote terminal still running; prune will remove it", text)
        self.assertIn("the opening session's watcher removes it while that session runs", text)

    def test_docs_do_not_claim_remote_output_streams_line_by_line(self):
        text = (self.ROOT / "docs" / "sessions.md").read_text("utf-8")
        self.assertNotIn("The remote's output shows while it runs (stderr line by line)", text)
        self.assertIn("only when the command ends", text)


if __name__ == "__main__":
    unittest.main()
