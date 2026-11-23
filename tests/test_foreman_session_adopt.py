"""`foreman session adopt <label>` (scripts/foreman_session.py, D158): a main session takes over a local child whose recorded parent is gone.
The handoff `parent` file and the registry `parent` are rewritten, an adoption line is logged; each refusal changes nothing."""
from __future__ import annotations

import contextlib
import io
import json
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

NEW, OLD = "new-parent", "old-parent"


class AdoptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="adopt_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.handoff = self.tmp / "handoff"
        self.handoff.mkdir()
        (self.handoff / "child").write_text("kid-1\n", "utf-8")
        (self.handoff / "parent").write_text(OLD + "\n", "utf-8")
        self.entry = {"label": "job", "child": "kid-1", "parent": OLD, "handoff": str(self.handoff), "status": "open"}
        self.write_registry([self.entry])

    def write_registry(self, sessions):
        (self.agent / "pi-foreman").mkdir(parents=True, exist_ok=True)
        fsn.write_registry(str(self.agent), {"version": 1, "sessions": sessions})

    def adopt(self, target="job", env=None, listed=(), unreadable=False):
        env = {fsn.ENV_PUBLISHED: NEW, **(env or {})}
        out, err = io.StringIO(), io.StringIO()
        sessions = None if unreadable else [{"id": i, "name": i} for i in listed]
        clean = {k: v for k, v in os.environ.items() if k not in (fsn.ENV_PUBLISHED, fsn.ENV_STABLE, "PI_SUBAGENT_CHILD", "PI_FOREMAN_HANDOFF_DIR")}
        with mock.patch.dict(os.environ, {**clean, **env}, clear=True), mock.patch.object(fsn, "intercom_sessions", return_value=sessions), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fsn.main(["--agent-dir", str(self.agent), "adopt", target])
        return code, out.getvalue(), err.getvalue()

    def parent_file(self):
        return (self.handoff / "parent").read_text("utf-8").strip()

    def registry_parent(self):
        return fsn.read_registry(str(self.agent))["sessions"][0]["parent"]

    def assert_unchanged(self):
        self.assertEqual(self.parent_file(), OLD)
        self.assertEqual(self.registry_parent(), OLD)
        self.assertFalse((self.handoff / "adopted.log").exists())

    def test_adopt_rewrites_parent_file_and_registry_and_logs(self):
        code, out, err = self.adopt(listed=["someone-else"])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.parent_file(), NEW)
        self.assertEqual(self.registry_parent(), NEW)
        line = (self.handoff / "adopted.log").read_text("utf-8").strip()
        self.assertRegex(line, r"^adopted job by new-parent \(was old-parent\) \d{4}-")
        self.assertIn("adopted", out)

    def test_adopt_by_child_id_and_trace_line_when_tracing_is_on(self):
        trace = self.agent / "pi-foreman" / "state" / "trace-new-parent.jsonl"
        trace.parent.mkdir(parents=True, exist_ok=True)
        trace.write_text("", "utf-8")
        self.assertEqual(self.adopt("kid-1")[0], 0)
        rec = json.loads(trace.read_text("utf-8").strip())
        self.assertEqual((rec["event"], rec["from"], rec["to"]), ("session_adopt", OLD, NEW))

    def test_refused_while_the_recorded_parent_is_listed(self):
        for listed in ([OLD], ["x", OLD]):
            code, _, err = self.adopt(listed=listed)
            self.assertEqual(code, 1)
            self.assertIn("still running", err)
            self.assert_unchanged()

    def test_refused_when_the_list_cannot_be_read(self):
        code, _, err = self.adopt(unreadable=True)
        self.assertEqual(code, 1)
        self.assertIn("cannot be read", err)
        self.assert_unchanged()

    def test_refused_in_a_subagent_child(self):
        code, _, err = self.adopt(env={"PI_SUBAGENT_CHILD": "1"})
        self.assertEqual(code, 1)
        self.assertIn("subagent child", err)
        self.assert_unchanged()

    def test_refused_without_an_own_session_id(self):
        out, err = io.StringIO(), io.StringIO()
        clean = {k: v for k, v in os.environ.items() if k not in (fsn.ENV_PUBLISHED, fsn.ENV_STABLE, "PI_SUBAGENT_CHILD")}
        with mock.patch.dict(os.environ, clean, clear=True), mock.patch.object(fsn, "intercom_sessions", return_value=[]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fsn.main(["--agent-dir", str(self.agent), "adopt", "job"])
        self.assertEqual(code, 1)
        self.assertIn("no own session id", err.getvalue())
        self.assert_unchanged()

    def test_adopt_has_no_parent_id_option(self):
        code, _, _ = self.adopt()  # parser sanity
        self.assertEqual(code, 0)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(fsn.main(["--agent-dir", str(self.agent), "adopt", "job", "--parent-id", "x"]), 1)

    def test_refused_for_the_child_itself(self):
        code, _, err = self.adopt(env={fsn.ENV_PUBLISHED: "kid-1"})
        self.assertEqual(code, 1)
        self.assertIn("cannot adopt itself", err)
        code, _, err = self.adopt(env={"PI_FOREMAN_HANDOFF_DIR": str(self.handoff)})
        self.assertEqual(code, 1)
        self.assert_unchanged()

    def test_refused_for_a_remote_child(self):
        self.write_registry([dict(self.entry, machine="box")])
        code, _, err = self.adopt()
        self.assertEqual(code, 1)
        self.assertIn("restart it under this session", err)
        self.assertEqual(self.parent_file(), OLD)

    def test_unknown_target_refused(self):
        self.assertEqual(self.adopt("nope")[0], 1)
        self.assert_unchanged()


if __name__ == "__main__":
    unittest.main()
