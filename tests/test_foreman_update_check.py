"""scripts/foreman_update_check.py with a mocked registry."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_update_check as uc  # noqa: E402

DOCS = {
    "pi-subagents": {"dist-tags": {"latest": "0.77.0"},
                     "versions": {v: {} for v in ("0.75.0", "0.76.0", "0.77.0", "0.78.0-beta.1")},
                     "time": {"0.76.0": "2026-10-04T10:00:00Z", "0.77.0": "2026-10-06T10:00:00Z"}},
}


def fetcher(name):
    if name in DOCS:
        return DOCS[name]
    raise urllib.error.HTTPError("u", 404, "nf", None, None)


class UpdateCheckTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="uc_test_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.lock = self.tmp / "lock.json"
        self.lock.write_text(json.dumps({"schema": 1, "pi": {"name": "pi-missing", "version": "1.0.0"},
                                         "packages": [{"name": "pi-subagents", "version": "0.75.0", "mode": "install",
                                                       "notes": "https://example.test/v{version}"},
                                                      {"name": "pi-foreman", "mode": "local"}]}))

    def run_main(self, *argv, fetch=fetcher):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = uc.main(["--lock", str(self.lock), *argv], fetcher=fetch)
        return rc, out.getvalue()

    def test_newer_versions_dates_and_notes(self):
        row = uc.check({"name": "pi-subagents", "version": "0.75.0", "notes": "https://example.test/v{version}"}, fetcher)
        self.assertEqual([n["version"] for n in row["newer"]], ["0.76.0", "0.77.0"])  # prerelease skipped
        self.assertEqual(row["newer"][0]["published"], "2026-10-04")
        self.assertEqual(row["notes"], "https://example.test/v0.77.0")

    def test_text_json_and_errors(self):
        rc, text = self.run_main()
        self.assertEqual(rc, 0)
        self.assertIn("pi-subagents: pinned 0.75.0, latest 0.77.0", text)
        self.assertIn("pi-missing: could not check (HTTP 404)", text)
        self.assertIn("pi-claude-bridge", text)  # not pinned, listed
        self.assertTrue(text.rstrip().endswith("Nothing was changed. To update, re-run the installer (setup.mjs) after raising the pin."))
        rc, js = self.run_main("--json")
        self.assertEqual(json.loads(js)["packages"][1]["latest"], "0.77.0")

    def test_offline_exit_zero_and_unreadable_lock(self):
        def offline(name):
            raise urllib.error.URLError("down")
        rc, text = self.run_main(fetch=offline)
        self.assertEqual(rc, 0)
        self.assertIn("could not check", text)
        self.lock.write_text("{nope")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.run_main()[0], 2)

    def test_repo_lock_has_notes(self):
        lock = json.loads((ROOT / "packages.lock.json").read_text(encoding="utf-8"))
        for e in [lock["pi"]] + [p for p in lock["packages"] if p["mode"] != "local"]:
            self.assertIn("{version}", e["notes"])


if __name__ == "__main__":
    unittest.main()
