"""scripts/foreman_radar.py --json: `waits[].prRefs` (the watched PRs with repository and host) is copied only when present and
well-formed; a live file without it (an older writer) gives the same wait as before."""
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


def wait(**extra):
    return dict({"id": "pr_watch", "kind": "pr", "note": "1 pr watch", "ageSeconds": 0, "leftSeconds": 0, "prs": [5]}, **extra)


class PrRefsCopy(Fixture):
    def waits_of(self, waits):
        top = live("s-r", "r", "fm-r", hb=0)
        top["waits"] = waits
        self.put_live(top)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root["waits"]

    def test_pr_refs_are_copied_only_when_present_and_well_formed(self):
        ref = {"n": 5, "repo": "owner/repo-b", "host": "github.com"}
        got = self.waits_of([wait(prRefs=[ref, {"n": "x", "repo": "owner/repo-b"}, {"n": True, "repo": "r"}, {"n": 6, "repo": ""}, "junk"]),
                             wait(prRefs=[]), wait(prRefs="junk"), wait()])
        self.assertEqual(got[0]["prRefs"], [ref])
        self.assertEqual(got[0]["prs"], [5])
        for old in got[1:]:
            self.assertNotIn("prRefs", old)
            self.assertEqual(old["prs"], [5])


if __name__ == "__main__":
    unittest.main()
