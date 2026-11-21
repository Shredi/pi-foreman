"""The notice queue of a remote child: `remote notice` keeps every report as `notices/<seq>-<kind>.md` and a line of `notices.jsonl`
(written under the seq lock), answers at once with an unchanged stdout line, and says on stderr that the report is not yet confirmed."""
from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_session_remote import NoticeBase, fsn


class NoticeQueueTest(NoticeBase):
    def run_notice(self, *args):
        code, out, err = self.run_main("remote", "notice", *args)
        return code, json.loads(out), err

    def queue(self):
        f = self.dir / "notices.jsonl"
        return [json.loads(x) for x in f.read_text("utf-8").splitlines()] if f.exists() else []

    def test_each_notice_keeps_its_own_copy_and_queue_line(self):
        (self.dir / "plan.md").write_text("first", "utf-8")
        self.assertEqual(self.run_notice("plan")[0], 0)
        (self.dir / "plan.md").write_text("second", "utf-8")  # overwritten before the parent fetched seq 1
        self.assertEqual(self.run_notice("plan")[0], 0)
        self.assertEqual((self.dir / "notices" / "1-plan.md").read_text("utf-8"), "first")
        self.assertEqual((self.dir / "notices" / "2-plan.md").read_text("utf-8"), "second")
        q = self.queue()
        self.assertEqual([(r["seq"], r["kind"], r["bytes"]) for r in q], [(1, "plan", 5), (2, "plan", 6)])
        self.assertEqual(q[0]["sha256"], hashlib.sha256(b"first").hexdigest())
        self.assertIn("T", q[0]["at"])

    def test_stdout_is_unchanged_and_stderr_says_not_yet_confirmed(self):
        (self.dir / "result.md").write_text("done", "utf-8")
        code, r, err = self.run_notice("result")
        self.assertEqual((code, r["ok"], r["seq"]), (0, True, 1))
        self.assertEqual(sorted(r), ["label", "ok", "seq"])
        self.assertIn("sent, not yet confirmed; a pi-foreman note tells you when the parent confirms", err)
        self.assertEqual(self.run_notice("closed")[2].strip(), "", "a closed notice prints nothing new")

    def test_closed_without_a_result_and_refused_queue_records_without_a_copy(self):
        self.assertEqual(self.run_notice("closed")[0], 0)
        self.assertEqual(self.run_notice("refused", "--reason", "no-run")[0], 0)
        q = self.queue()
        self.assertEqual((q[0]["sha256"], q[0]["bytes"]), (None, 0))
        self.assertEqual((q[1]["kind"], q[1]["reason"]), ("refused", "no-run"))
        self.assertFalse((self.dir / "notices").exists())

    def test_a_failed_label_leaves_the_record_and_a_refused_one_leaves_none(self):
        (self.dir / "result.md").write_text("done", "utf-8")
        self.env["HC_TERMINAL_ID"] = ""
        code, r, err = self.run_notice("result")
        self.assertEqual(code, 1)
        self.assertEqual(self.queue(), [])
        self.assertNotIn("not yet confirmed", err)

    def test_on_seq_runs_under_the_lock_and_the_signature_stays(self):
        seen = []
        n = fsn.next_notice_seq(self.dir, lambda seq: seen.append((seq, (self.dir / "notice-seq.lock").exists())))
        self.assertEqual((n, seen), (1, [(1, True)]))
        self.assertEqual(fsn.next_notice_seq(self.dir), 2)

    def test_the_remote_footer_claims_delivery_only_after_a_note(self):
        text = " ".join(fsn.remote_footer("demo", True).split())
        self.assertIn("`sent, not yet confirmed` is not delivery", text)
        self.assertIn("only after a pi-foreman note says it was delivered", text)


if __name__ == "__main__":
    unittest.main()
