"""`foreman session brief --rework` (scripts/foreman_session.py): the marker `rework-<k>` beside the delivered brief on the CLI path and on the
machine-session payload path; no flag, no marker; the markers are their own sequence."""
from __future__ import annotations

import argparse
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402

ADDRESS = "opener@parentbox"


def markers(d):
    return sorted(n for n in os.listdir(str(d)) if n.startswith("rework"))


class CliPathTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rework_cli_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.handoff = self.tmp / "handoff"
        self.handoff.mkdir()
        (self.handoff / "child").write_text("kid-1\n", "utf-8")
        self.agent = self.tmp / "agent"
        self.sent = []

    def brief(self, *args):
        out, err = io.StringIO(), io.StringIO()
        sent = self.sent
        with mock.patch.object(fsn, "send_intercom", side_effect=lambda to, text: (sent.append((to, text)), (True, ""))[1]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fsn.main(["--agent-dir", str(self.agent), "brief", str(self.handoff), *args, "--parent-id", "parent-1"])
        return code, out.getvalue(), err.getvalue()

    def test_the_flag_writes_an_empty_marker_beside_the_brief(self):
        code, _, err = self.brief("send it back", "--rework")
        self.assertEqual(code, 0, err)
        self.assertEqual(markers(self.handoff), ["rework-1"])
        self.assertEqual((self.handoff / "rework-1").stat().st_size, 0)
        self.assertEqual((self.handoff / "brief-1.md").read_text("utf-8"), "send it back\n")
        self.assertEqual(len(self.sent), 1)

    def test_no_flag_writes_no_marker(self):
        self.assertEqual(self.brief("plain brief")[0], 0)
        self.assertEqual(markers(self.handoff), [])

    def test_the_word_inside_the_body_text_writes_none(self):
        self.assertEqual(self.brief("please do not use --rework here")[0], 0)
        self.assertEqual(markers(self.handoff), [])
        self.assertEqual((self.handoff / "brief-1.md").read_text("utf-8"), "please do not use --rework here\n")

    def test_markers_are_their_own_sequence_independent_of_brief_and_ruling_numbers(self):
        (self.handoff / "brief-7.md").write_text("old", "utf-8")
        (self.handoff / "ruling-3.md").write_text("old", "utf-8")
        self.assertEqual(self.brief("one", "--rework")[0], 0)  # brief-1.md, rework-1
        self.assertEqual(self.brief("two", "--rework")[0], 0)  # brief-2.md, rework-2
        self.assertEqual(markers(self.handoff), ["rework-1", "rework-2"])
        self.assertTrue((self.handoff / "brief-2.md").is_file())

    def test_new_rework_takes_the_number_after_the_highest_and_never_overwrites(self):
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-1")
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-2")
        (self.handoff / "rework-1").unlink()
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-3", "no reuse of a free low number below the highest")
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-4")
        self.assertEqual(markers(self.handoff), ["rework-2", "rework-3", "rework-4"])

    def test_markers_1_and_3_present_the_next_is_4(self):
        (self.handoff / "rework-1").write_text("", "utf-8")
        (self.handoff / "rework-3").write_text("", "utf-8")
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-4")

    def test_marker_2_handled_and_removed_the_next_send_back_is_above_the_watermark(self):
        for n in ("rework-1", "rework-2", "rework-3"):
            (self.handoff / n).write_text("", "utf-8")
        (self.handoff / "rework-2").unlink()
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-4", "above the watermark 3")

    def test_a_stray_high_marker_does_not_hide_the_next_send_back(self):
        (self.handoff / "rework-900").write_text("", "utf-8")
        self.assertEqual(fsn.new_rework(self.handoff), self.handoff / "rework-901")

    def test_two_deliveries_never_share_a_marker(self):
        first = fsn.new_rework(self.handoff)
        second = fsn.new_rework(self.handoff)
        self.assertNotEqual(first, second)
        self.assertEqual(len(markers(self.handoff)), 2)

    def test_rework_999_is_the_last_one_refused_past_it_and_nothing_is_overwritten(self):
        (self.handoff / "rework-999").write_text("", "utf-8")
        with self.assertRaises(fsn.Refused):
            fsn.new_rework(self.handoff)
        self.assertEqual(markers(self.handoff), ["rework-999"])


class RemotePathTest(unittest.TestCase):
    NAME = "20261113-100000-demo"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rework_remote_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.dir = self.tmp / "pi-foreman" / "handoffs" / self.NAME
        self.dir.mkdir(parents=True)
        (self.dir / "parent").write_text(ADDRESS + "\n", "utf-8")
        (self.dir / "child").write_text("kid-2\n", "utf-8")

    def deliver(self, **over):
        p = {"handoffName": self.NAME, "parentAddress": ADDRESS, "kind": "brief", "name": "brief-1.md", "content": "x"}
        p.update(over)
        with mock.patch.object(fsn, "send_intercom", return_value=(True, "")):
            return fsn.remote_deliver(self.tmp, p)

    def test_the_receiving_side_writes_the_marker_when_the_field_is_set(self):
        r = self.deliver(rework=True)
        self.assertEqual(Path(r["path"]), self.dir / "brief-1.md")
        self.assertEqual(markers(self.dir), ["rework-1"])
        self.deliver(rework=True, name="ruling-2.md", kind="ruling")
        self.assertEqual(markers(self.dir), ["rework-1", "rework-2"], "two deliveries never share a marker")

    def test_an_absent_or_false_field_writes_none(self):
        self.deliver()
        self.deliver(rework=False, name="brief-2.md")
        self.assertEqual(markers(self.dir), [])

    def test_a_field_of_the_wrong_type_is_refused_and_writes_nothing(self):
        with self.assertRaises(fsn.Refused):
            self.deliver(rework="yes")
        self.assertEqual(markers(self.dir), [])
        self.assertFalse((self.dir / "brief-1.md").exists())

    def test_the_payload_carries_the_field_only_with_the_flag(self):
        entry = {"label": "demo", "child": "kid-2", "machine": "alpha", "handoffName": self.NAME, "parentAddress": ADDRESS}
        payloads = []

        def fake_exec(binary, name, argv, verb, payload, timeout):
            payloads.append(dict(payload))
            return {"bytes": 1, "woke": True}

        for flag in (False, True):
            a = argparse.Namespace(text="hello there", rework=flag)
            with mock.patch.object(fsn, "machine_entry", return_value=(None, ["foreman"])), \
                    mock.patch.object(fsn, "hc_required", return_value="hc"), \
                    mock.patch.object(fsn, "check_hc_machine"), \
                    mock.patch.object(fsn, "hc_exec_verb", side_effect=fake_exec), \
                    mock.patch.object(fsn, "read_registry", return_value={"sessions": [dict(entry)]}), \
                    mock.patch.object(fsn, "write_registry"), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(fsn.remote_brief(a, self.tmp, entry), 0)
        self.assertNotIn("rework", payloads[0])
        self.assertIs(payloads[1]["rework"], True)


if __name__ == "__main__":
    unittest.main()
