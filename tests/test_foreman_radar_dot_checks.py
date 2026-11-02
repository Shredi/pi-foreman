"""scripts/foreman_radar.py --json: a PR dot passes its per-check `checks` (capped) or `counts` through; the old shape is unchanged."""
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


class DotChecksTests(Fixture):
    def dots(self, dots):
        d = live("s-c", "c", "fm-c", hb=5)
        d["dots"] = dots
        self.put_live(d)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root["dots"]

    def pr(self, **over):
        return {"n": 7, "state": "run", "label": "#7", "src": "pr", **over}

    def test_checks_are_passed_through_and_state_stays(self):
        checks = [{"name": "a", "state": "fail"}, {"name": "b", "state": "run"}, {"name": "c", "state": "ok"}]
        (got,) = self.dots([self.pr(checks=checks)])
        self.assertEqual(got["checks"], checks)
        self.assertEqual(got["state"], "run")
        self.assertNotIn("counts", got)

    def test_counts_form_and_old_shape(self):
        (got,) = self.dots([self.pr(counts={"fail": 1, "run": 2, "ok": 30, "x": 1})])
        self.assertEqual(got["counts"], {"fail": 1, "run": 2, "ok": 30})
        (old,) = self.dots([self.pr()])
        self.assertNotIn("checks", old)
        self.assertNotIn("counts", old)

    def test_bad_entries_are_dropped_and_the_list_is_capped(self):
        mixed = [{"name": "a", "state": "bogus"}, {"name": 5, "state": "ok"}, "junk", {"name": "ok", "state": "ok"}]
        (got,) = self.dots([self.pr(checks=mixed)])
        self.assertEqual(got["checks"], [{"name": "ok", "state": "ok"}])
        (none,) = self.dots([self.pr(checks=[{"name": 5, "state": "ok"}])])
        self.assertNotIn("checks", none)
        many = [{"name": "c%d" % i, "state": "ok"} for i in range(30)]
        (cut,) = self.dots([self.pr(checks=many)])
        self.assertEqual(len(cut["checks"]), 12)

    def test_ext_dots_never_carry_checks(self):
        (got,) = self.dots([{"n": None, "state": "ok", "label": "deploy", "src": "ext", "checks": [{"name": "a", "state": "ok"}]}])
        self.assertNotIn("checks", got)


if __name__ == "__main__":
    unittest.main()
