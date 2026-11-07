"""scripts/foreman_radar.py --json: the live file's `show` pointer passes through with its three keys only; an over-long dir drops it."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "scripts"))

from test_foreman_radar import NOW, Fixture, live  # noqa: E402
import foreman_radar as fr  # noqa: E402


class ShowPassthroughTests(Fixture):
    def node(self, show, **extra):
        d = live("s-show", "show", "fm-show", hb=5)
        if show is not None:
            d["show"] = show
        d.update(extra)
        self.put_live(d)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root

    def test_three_keys_pass_through(self):
        got = self.node({"dir": "/w/.workflow/scratch/show/s-show", "plan": 3, "note": 1})
        self.assertEqual(got["show"], {"dir": "/w/.workflow/scratch/show/s-show", "plan": 3, "note": 1})

    def test_dir_alone_and_extra_keys_are_cut(self):
        got = self.node({"dir": "/w/show/s", "ruled": 2, "other": "x"})
        self.assertEqual(got["show"], {"dir": "/w/show/s"})

    def test_bad_version_types_are_omitted(self):
        got = self.node({"dir": "/w/show/s", "plan": True, "note": "1"})
        self.assertEqual(got["show"], {"dir": "/w/show/s"})
        got = self.node({"dir": "/w/show/s", "plan": -1, "note": 1.5})
        self.assertEqual(got["show"], {"dir": "/w/show/s"})

    def test_over_long_dir_drops_the_field(self):
        got = self.node({"dir": "/" + "a" * 1024, "plan": 1})
        self.assertNotIn("show", got)

    def test_dir_at_the_limit_is_kept_whole(self):
        d = "/" + "a" * 1023
        got = self.node({"dir": d, "plan": 1})
        self.assertEqual(got["show"], {"dir": d, "plan": 1})

    def test_bad_shapes_drop_the_field(self):
        for bad in ("x", 5, ["dir"], {"dir": 5}, {"dir": ""}, {"plan": 1}):
            self.assertNotIn("show", self.node(bad), msg=repr(bad))

    def test_absent_field_stays_absent(self):
        self.assertNotIn("show", self.node(None))


if __name__ == "__main__":
    unittest.main()
