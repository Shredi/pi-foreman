"""Brief pages in scripts/foreman_session.py: a brief whose real path ends in .html is converted by briefpage-cli.ts (real Node) into a text copy
(what the session reads) and a rendered page (kept beside it). `open` writes brief.md = copy + footer and brief.html; `brief` writes
brief-<n>.md and brief-<n>.html; a remote target gets the copy only, under the 64 KiB limit. Non-page briefs are unchanged. No Node: brief_needs_node."""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_session as fsn  # noqa: E402
from test_foreman_session import FAKE  # noqa: E402

PAGE = "<html><body><h1>Finish the part</h1><p>Do <b>it</b>.</p></body></html>\n"
COPY = "<!-- generated from the brief page page.html; the page is the source -->\n# Finish the part\n\nDo **it**.\n"
HAS_NODE = shutil.which("node") is not None


@unittest.skipUnless(HAS_NODE, "needs Node >= 22.6")
class BriefPageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="brief_page_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.proj = self.tmp / "proj"
        self.proj.mkdir()
        subprocess.run(["git", "init", "-q", str(self.proj)], check=True)
        self.page = self.tmp / "page.html"
        self.page.write_text(PAGE, "utf-8")
        self.md = self.tmp / "brief.md"
        self.md.write_text("# Task\n\nDo the thing.\n", "utf-8")
        bindir = self.tmp / "bin"
        bindir.mkdir()
        (bindir / "herdr_fake.py").write_text(FAKE, "utf-8")
        if os.name == "nt":
            (bindir / "herdr.cmd").write_text('@"%s" "%%~dp0herdr_fake.py" %%*\r\n' % sys.executable, "utf-8")
        else:
            sh = bindir / "herdr"
            sh.write_text("#!%s\nexec(open(%r).read())\n" % (sys.executable, str(bindir / "herdr_fake.py")), "utf-8")
            sh.chmod(0o755)
        self.log = self.tmp / "herdr.log"
        self.env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "FAKE_HERDR_LOG": str(self.log),
                    "HERDR_PANE_ID": "w1:p1", "PI_CODING_AGENT_DIR": str(self.agent), "PI_FOREMAN_START_CONFIRM_SECONDS": "0"}
        for k in ("HC_TERMINAL_ID", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_BIN", "HERDR_BIN", "PI_INTERCOM_STABLE_ID", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_HANDOFF_DIR", "FAKE_HERDR_FAIL", "FAKE_HERDR_WORKSPACES"):
            self.env[k] = ""
        for k in os.environ:
            if k.startswith("PI_BG_"):
                self.env[k] = ""

    def run_main(self, *argv, **env):
        e = dict(self.env, **env)
        drop = [k for k, v in e.items() if v == ""]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, e), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            for k in drop:
                os.environ.pop(k, None)
            code = fsn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def open_args(self, brief, *extra):
        return ("open", "demo", str(brief), "--cwd", str(self.proj), "--parent-id", "parent-1") + extra

    def handoffs(self):
        d = self.agent / "pi-foreman" / "handoffs"
        return sorted(d.iterdir()) if d.is_dir() else []

    # ---- open

    def test_open_writes_the_copy_with_the_footer_and_keeps_the_page(self):
        code, _, err = self.run_main(*self.open_args(self.page))
        self.assertEqual(code, 0, err)
        (handoff,) = self.handoffs()
        text = (handoff / "brief.md").read_text("utf-8")
        self.assertEqual(text, COPY.rstrip("\n") + "\n" + fsn.footer("demo", False))
        self.assertNotIn("</html>", text)
        shown = (handoff / "brief.html").read_text("utf-8")
        self.assertIn('id="pi-foreman-banner"', shown)
        self.assertIn("Do <b>it</b>.", shown)
        self.assertEqual(self.page.read_text("utf-8"), PAGE, "the original page is left as it was")

    def test_a_markdown_brief_is_byte_identical_to_today(self):
        code, _, err = self.run_main(*self.open_args(self.md))
        self.assertEqual(code, 0, err)
        (handoff,) = self.handoffs()
        self.assertEqual((handoff / "brief.md").read_text("utf-8"), "# Task\n\nDo the thing.\n" + fsn.footer("demo", False))
        self.assertFalse((handoff / "brief.html").exists())

    def test_the_real_path_decides_a_link_to_a_page_is_a_page(self):
        link = self.tmp / "link.md"
        try:
            link.symlink_to(self.page)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks need privileges here")
        self.assertEqual(self.run_main(*self.open_args(link))[0], 0)
        (handoff,) = self.handoffs()
        self.assertTrue((handoff / "brief.html").is_file())

    def test_dry_run_converts_and_writes_nothing(self):
        code, _, err = self.run_main(*self.open_args(self.page, "--dry-run"))
        self.assertEqual(code, 0, err)
        self.assertEqual(self.handoffs(), [])
        big = self.tmp / "big.html"
        big.write_text("<p>%s</p>" % ("x" * (256 * 1024)), "utf-8")
        code, _, err = self.run_main(*self.open_args(big, "--dry-run"))
        self.assertEqual(code, 1)
        self.assertIn("[brief_too_large]", err)
        self.assertEqual(self.handoffs(), [])

    def test_a_conversion_error_refuses_the_open_with_its_code(self):
        big = self.tmp / "big.html"
        big.write_text("<p>%s</p>" % ("x" * (256 * 1024)), "utf-8")
        code, _, err = self.run_main(*self.open_args(big))
        self.assertEqual(code, 1)
        self.assertIn("refused [brief_too_large]", err)
        self.assertEqual(self.handoffs(), [])

    def test_no_node_refuses_a_page_with_brief_needs_node_and_leaves_a_markdown_brief_alone(self):
        empty = self.tmp / "nopath"
        empty.mkdir()
        code, _, err = self.run_main(*self.open_args(self.page), PATH=str(empty))
        self.assertEqual(code, 1)
        self.assertIn("refused [brief_needs_node]", err)
        self.assertIn("Node >= 22.6", err)
        self.assertEqual(self.handoffs(), [])
        self.assertEqual(self.run_main(*self.open_args(self.md, "--dry-run"), PATH=str(empty))[0], 0)

    def test_the_temp_dir_of_a_conversion_is_removed(self):
        made = []
        real = tempfile.mkdtemp

        def spy(*a, **k):
            d = real(*a, **k)
            made.append(d)
            return d

        with mock.patch.object(fsn.tempfile, "mkdtemp", side_effect=spy):
            copy, page, info = fsn.convert_brief_page(self.page)
        self.assertEqual(copy, COPY)
        self.assertEqual((info["ok"], info["title"], info["hidden"]), (True, "Finish the part", 0))
        self.assertEqual(len(made), 1)
        self.assertFalse(os.path.exists(made[0]))

    # ---- brief

    def brief(self, text):
        handoff = self.tmp / "handoff"
        handoff.mkdir(exist_ok=True)
        (handoff / "child").write_text("kid-1\n", "utf-8")
        self.sent = []
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(fsn, "send_intercom", side_effect=lambda to, msg: (self.sent.append((to, msg)), (True, ""))[1]), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fsn.main(["--agent-dir", str(self.agent), "brief", str(handoff), str(text), "--parent-id", "parent-1"])
        return code, err.getvalue(), handoff

    def test_brief_html_writes_brief_n_md_and_brief_n_html_with_the_same_n(self):
        code, err, handoff = self.brief(self.page)
        self.assertEqual(code, 0, err)
        self.assertEqual((handoff / "brief-1.md").read_text("utf-8"), COPY)
        self.assertIn("Do <b>it</b>.", (handoff / "brief-1.html").read_text("utf-8"))
        self.assertTrue(self.sent[0][1].endswith("brief-1.md and act on it"), self.sent)
        self.assertEqual(self.brief(self.md)[0], 0)
        self.assertTrue((handoff / "brief-2.md").is_file())
        self.assertFalse((handoff / "brief-2.html").exists(), "a markdown brief writes no page")
        self.assertEqual(self.brief(self.page)[0], 0)
        self.assertTrue((handoff / "brief-3.html").is_file())

    def test_brief_a_conversion_error_writes_nothing(self):
        big = self.tmp / "big.html"
        big.write_text("<p>%s</p>" % ("x" * (256 * 1024)), "utf-8")
        code, err, handoff = self.brief(big)
        self.assertEqual(code, 1)
        self.assertIn("[brief_too_large]", err)
        self.assertEqual(sorted(p.name for p in handoff.iterdir()), ["child"])

    # ---- remote

    def test_remote_brief_delivers_the_copy_only(self):
        kind, name, content = fsn.brief_name(str(self.page), {"briefs": 0})
        self.assertEqual((kind, name, content), ("brief", "brief-1.md", COPY))
        self.assertEqual(fsn.brief_name(str(self.md), {"briefs": 2})[1:], ("brief-3.md", "# Task\n\nDo the thing.\n"))

    def remote_open(self, brief):
        def stop():
            raise fsn.Refused("stopped after the size check", "stop_here")

        with mock.patch.object(fsn, "machine_entry", return_value=({"parentName": "parentbox"}, ["foreman"])), \
                mock.patch.object(fsn, "hc_required", side_effect=stop):
            return self.run_main("open", "demo", str(brief), "--machine", "box", "--cwd", "/remote/dir", "--parent-id", "parent-1")

    def test_remote_open_limit_applies_to_the_copy_not_the_page(self):
        tags = self.tmp / "tags.html"  # a page over 64 KiB whose text copy is small
        tags.write_text("<html><body>%s</body></html>" % ("<span></span>" * 6000 + "<p>small</p>"), "utf-8")
        self.assertGreater(tags.stat().st_size, 64 * 1024)
        self.assertIn("[stop_here]", self.remote_open(tags)[2], "past the size check")
        text = self.tmp / "text.html"  # a page whose copy is over 64 KiB
        text.write_text("<p>%s</p>" % ("x" * (64 * 1024)), "utf-8")
        self.assertIn("[too_large]", self.remote_open(text)[2])
        self.assertIn("[stop_here]", self.remote_open(self.page)[2])


class NoNodeTest(unittest.TestCase):
    def test_without_node_on_the_path_the_helper_refuses_with_a_code(self):
        empty = tempfile.mkdtemp(prefix="brief_nonode_")
        self.addCleanup(shutil.rmtree, empty, True)
        page = Path(empty) / "p.html"
        page.write_text(PAGE, "utf-8")
        with mock.patch.dict(os.environ, {"PATH": empty}):
            with self.assertRaises(fsn.Refused) as cm:
                fsn.convert_brief_page(page)
        self.assertEqual(cm.exception.code, "brief_needs_node")
        self.assertIn("Node >= 22.6", str(cm.exception))

    def test_is_brief_page_follows_the_name_case_insensitively(self):
        self.assertTrue(fsn.is_brief_page("x/Brief.HTML"))
        self.assertFalse(fsn.is_brief_page("x/brief.md"))


if __name__ == "__main__":
    unittest.main()
