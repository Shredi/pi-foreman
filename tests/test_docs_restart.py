"""Docs of the restart round: intercom.allowRemote and the machine it is set on (D107), hc send and hc keys limits, the restart command, the claude-bridge login renewal."""
import re
import unittest
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / "docs"


def doc(name):
    return (DOCS / name).read_text(encoding="utf-8")


class RestartDocs(unittest.TestCase):
    def test_sessions_names_allow_remote_and_the_sending_machine(self):
        text = doc("sessions.md")
        para = re.search(r"\*\*Intercom across machines\.\*\*.*", text).group(0)
        self.assertIn("intercom.allowRemote", para)
        self.assertIn("read on the machine that sends", para)
        self.assertIn("remote machine", para)

    def test_herdr_hc_send_and_keys_limits(self):
        text = doc("herdr.md")
        for needle in ("`hc send` from inside an hc terminal wraps the text", "`HC_TERMINAL_ID`, `HC_SCOPE` and `HC_TERMINAL_SOCKET` unset",
                       "`hc keys` cannot type `_` or an uppercase letter", "never types a command into an existing shell"):
            self.assertIn(needle, text)

    def test_sessions_lists_the_restart_command(self):
        text = doc("sessions.md")
        self.assertIn("bin/foreman session open|list|restart", text)
        self.assertIn("foreman session restart <label|child id|label@machine>", text)
        self.assertIn("it never writes `closed` into the registry", text)

    def test_install_names_the_bridge_login_renewal(self):
        text = doc("install.md")
        self.assertIn("CLAUDE_CONFIG_DIR=<agent dir>/pi-foreman/claude-config claude auth login", text)
        self.assertIn("Renewing the login on a remote machine", text)

    def test_close_names_the_local_terminal_reap(self):
        text = doc("close.md")
        self.assertIn("its kept terminal is ended and removed", text)
        self.assertIn("keeps its worktree and branch", text)


if __name__ == "__main__":
    unittest.main()
