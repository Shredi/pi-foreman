"""Replay driver Pi CLI resolver (ledger item 10): FOREMAN_PI_CLI, global npm root, Pi's managed install.

Temp dirs only; no live Pi, no npm call (npm_root is injected).
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver  # noqa: E402

PKG = ("@earendil-works", "pi-coding-agent")


def _touch(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("// cli\n", "utf-8")
    return path


class PiCliResolver(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="pf-pi-cli-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.root / "home"
        self.npm = self.root / "npm-root"
        self.home.mkdir()
        self.npm.mkdir()

    def managed(self, version="1.2.0", write_cli=True):
        install = self.home / ".pi" / "agent" / "install"
        install.mkdir(parents=True, exist_ok=True)
        (install / "current-version").write_text(version + "\n", "utf-8")
        cli = install.joinpath("releases", version, "node_modules", *PKG, "dist", "cli.js")
        return _touch(cli) if write_cli else cli

    def resolve(self, environ=None, npm_root=None):
        return driver.resolve_pi_cli(environ or {}, self.npm if npm_root is None else npm_root, self.home)

    def test_global_npm_root_wins_over_managed(self):
        glob = _touch(self.npm.joinpath(*PKG, "dist", "bundle", "cli.js"))
        self.managed()
        self.assertEqual(self.resolve(), glob)

    def test_managed_install_when_not_in_global_root(self):
        cli = self.managed()
        self.assertEqual(self.resolve(), cli)

    def test_managed_install_when_npm_lookup_fails(self):
        cli = self.managed()

        def broken():
            raise RuntimeError("npm not found on PATH")

        self.assertEqual(self.resolve(npm_root=broken), cli)

    def test_explicit_env_wins_over_both(self):
        _touch(self.npm.joinpath(*PKG, "dist", "bundle", "cli.js"))
        self.managed()
        explicit = _touch(self.root / "custom" / "cli.js")
        self.assertEqual(self.resolve({"FOREMAN_PI_CLI": str(explicit)}), explicit)

    def test_explicit_env_missing_fails_without_fallback(self):
        self.managed()
        missing = self.root / "nope" / "cli.js"
        with self.assertRaises(RuntimeError) as ctx:
            self.resolve({"FOREMAN_PI_CLI": str(missing)})
        self.assertIn(str(missing), str(ctx.exception))

    def test_nothing_found_names_every_path_and_the_supported_pin(self):
        managed = self.managed(write_cli=False)
        with self.assertRaises(RuntimeError) as ctx:
            self.resolve()
        msg = str(ctx.exception)
        self.assertIn(str(self.npm.joinpath(*PKG, "dist", "bundle", "cli.js")), msg)
        self.assertIn(str(managed), msg)
        lock = json.loads((driver.REPO / "packages.lock.json").read_text("utf-8"))["pi"]
        self.assertIn("pi-coding-agent@%s" % lock["version"], msg)
        self.assertIn("Pi %s is supported" % lock["range"], msg)

    def test_no_managed_install_names_current_version_file(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.resolve()
        self.assertIn(str(self.home / ".pi" / "agent" / "install" / "current-version"), str(ctx.exception))

    def test_current_version_cannot_escape_releases(self):
        install = self.home / ".pi" / "agent" / "install"
        install.mkdir(parents=True)
        (install / "current-version").write_text("../../evil\n", "utf-8")
        _touch(install.parent.parent.joinpath("evil", "node_modules", *PKG, "dist", "cli.js"))
        with self.assertRaises(RuntimeError):
            self.resolve()


if __name__ == "__main__":
    unittest.main()
