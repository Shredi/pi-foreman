"""The shell guard takes the handoff allow-list from the payload (`handoff_names`) when it is well-formed, else uses its built-in tuple."""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import shell_write_guard as swg  # noqa: E402


class HandoffNamesPayload(unittest.TestCase):
    def setUp(self):
        base = os.path.realpath(tempfile.mkdtemp(prefix="pf-swg-hn-"))
        self.addCleanup(shutil.rmtree, base, True)
        self.ws = os.path.join(base, "ws").replace(os.sep, "/")
        self.h = os.path.join(base, "agent", "handoffs", "h1").replace(os.sep, "/")
        os.makedirs(self.ws)
        os.makedirs(os.path.join(self.h, "work"))

    def d(self, name, names):
        return swg.decide(f"echo x > {self.h}/{name}", self.ws, self.ws, "bash", None, None, None, self.h, names)

    def main_refuses(self, name, names):
        payload = {"tool_input": {"command": f"echo x > {self.h}/{name}"}, "cwd": self.ws, "workspace": self.ws, "handoff_dir": self.h}
        if names is not None:
            payload["handoff_names"] = names
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", mock.Mock(buffer=io.BytesIO(json.dumps(payload).encode()))), redirect_stdout(out):
            self.assertEqual(swg.main([]), 0)
        return bool(out.getvalue().strip())

    def test_a_well_formed_payload_list_replaces_the_builtin_tuple(self):
        self.assertIsNone(self.d("result.md", ["result.md"]))
        self.assertIsNotNone(self.d("plan.md", ["result.md"]))
        self.assertFalse(self.main_refuses("result.md", ["result.md"]))
        self.assertTrue(self.main_refuses("plan.md", ["result.md"]))

    def test_the_ask_pattern_and_work_stay_code(self):
        self.assertIsNone(self.d("ask-4.md", ["result.md"]))
        self.assertIsNone(self.d("work/x.txt", ["result.md"]))
        self.assertIsNotNone(self.d("work", ["result.md"]))

    def test_a_malformed_list_falls_back_to_the_builtin_tuple(self):
        for bad in ("result.md", {"a": 1}, 5, [], [1], ["result.md", 2], ["a/b"], ["..", "result.md"], ["a\\b"], [""], ["../x"], ["a b"], None):
            with self.subTest(bad=bad):
                self.assertIsNone(self.d("plan.md", bad), "plan.md is on the built-in tuple")
                self.assertIsNotNone(self.d("ruling.md", bad), "ruling.md is not")
                if bad is not None:
                    self.assertFalse(self.main_refuses("plan.md", bad))
                    self.assertTrue(self.main_refuses("ruling.md", bad))

    def test_no_payload_list_means_the_builtin_tuple(self):
        for n in swg.HANDOFF_CHILD_NAMES:
            self.assertIsNone(self.d(n, None), n)
        self.assertFalse(self.main_refuses("plan.md", None))


if __name__ == "__main__":
    unittest.main()
