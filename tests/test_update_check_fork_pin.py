"""scripts/foreman_update_check.py skips a github: pin without a registry lookup."""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_update_check as uc  # noqa: E402

SPEC = "github:<owner>/pi-intercom#0123456789abcdef0123456789abcdef01234567"


class ForkPinTest(unittest.TestCase):
    def test_git_spec_forms_skip_lookup(self):
        def boom(name):
            raise AssertionError("registry must not be asked for a fork pin")

        for spec in (SPEC, SPEC.replace("github:", "git+https://github.com/"), SPEC.replace("github:", "git+ssh://git@github.com/")):
            row = uc.check({"name": "pi-intercom", "version": spec, "mode": "bundled"}, boom)
            self.assertTrue(row["fork"], spec)

    def test_check_skips_lookup(self):
        def boom(name):
            raise AssertionError("registry must not be asked for a fork pin")

        row = uc.check({"name": "pi-intercom", "version": SPEC, "mode": "bundled"}, boom)
        self.assertTrue(row["fork"])
        self.assertIsNone(row["error"])
        self.assertEqual(uc.render([row]).splitlines()[0], "pi-intercom: fork pin, see docs/install.md")

    def test_main_prints_line_and_checks_others(self):
        lock = {"schema": 1, "packages": [
            {"name": "pi-intercom", "version": SPEC, "mode": "bundled"},
            {"name": "other", "version": "1.0.0", "mode": "bundled"},
        ]}
        seen = []

        def fetcher(name):
            seen.append(name)
            return {"dist-tags": {"latest": "1.0.0"}, "versions": {"1.0.0": {}}}

        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "lock.json"
            f.write_text(json.dumps(lock), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = uc.main(["--lock", str(f)], fetcher)
        self.assertEqual(rc, 0)
        self.assertIn("pi-intercom: fork pin, see docs/install.md\n", out.getvalue())
        self.assertNotIn("pi-intercom", seen)
        self.assertIn("other", seen)


if __name__ == "__main__":
    unittest.main()
