"""The addressing lines of `foreman session open --machine`: `child address:`, the name-mismatch warning and the `info:` lines."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_foreman_session_remote import RemoteBase, fsn  # noqa: E402


class RemoteAddressingTest(RemoteBase):
    def open_with(self, **probe_over):
        """The real open path over the fake hc; the remote's probe reply gets `probe_over` merged in (None removes a key)."""
        real = fsn.hc_exec_verb

        def verb(binary, name, argv, v, payload, timeout):
            reply = real(binary, name, argv, v, payload, timeout)
            if v == "probe":
                for k, val in probe_over.items():
                    if val is None:
                        reply.pop(k, None)
                    else:
                        reply[k] = val
            return reply

        with mock.patch.object(fsn, "hc_exec_verb", side_effect=verb):
            code, out, err = self.run_main(*self.open_args())
        self.assertEqual(code, 0, err)
        return out.splitlines()

    def set_transport(self, transport):
        (self.padir / "intercom").mkdir(parents=True, exist_ok=True)
        (self.padir / "intercom" / "config.json").write_text(json.dumps({"crossMachine": {"transport": transport}}), "utf-8")

    def lines(self, out, prefix):
        return [l for l in out if l.startswith(prefix)]

    def test_child_address_uses_the_remotes_intercom_name(self):
        out = self.open_with(intercomMachineName="winbox")
        self.assertEqual(self.lines(out, "child address:"), ["child address: child@winbox"])

    def test_child_address_falls_back_to_the_machine_name(self):
        for seen in (None, "", "bad name!", "-lead", 5, "x" * 65):
            with self.subTest(seen=seen):
                out = self.open_with(intercomMachineName=seen)
                self.assertEqual(self.lines(out, "child address:"), ["child address: child@alpha"])

    def test_child_address_strips_control_characters(self):
        out = self.open_with(intercomMachineName="win\x1b\x07box")
        self.assertEqual(self.lines(out, "child address:"), ["child address: child@winbox"])
        self.assertFalse(any("\x1b" in l or "\x07" in l for l in out))

    def test_child_address_with_only_control_characters_falls_back(self):
        out = self.open_with(intercomMachineName="\x1b\x07")
        self.assertEqual(self.lines(out, "child address:"), ["child address: child@alpha"])

    def test_a_name_mismatch_warns_with_both_fixes(self):
        out = self.open_with(intercomMachineName="winbox")
        (warning,) = self.lines(out, "warning:")
        self.assertIn("intercom name differs: winbox", warning)
        self.assertIn("`hc machine add winbox`", warning)
        self.assertIn("`foreman machine setup alpha`", warning)

    def test_a_missing_or_bad_remote_name_warns_with_the_machine_name(self):
        out = self.open_with(intercomMachineName="bad name!")
        (warning,) = self.lines(out, "warning:")
        self.assertIn("intercom name differs: (none)", warning)
        self.assertIn("`hc machine add alpha`", warning)
        self.assertIn("`foreman machine setup alpha`", warning)

    def test_a_matching_name_has_no_warning(self):
        out = self.open_with(intercomMachineName="alpha")
        self.assertEqual(self.lines(out, "warning:"), [])
        self.assertEqual(self.lines(out, "child address:"), ["child address: child@alpha"])

    def test_differing_addons_give_an_info_line(self):
        self.set_transport("hc")
        out = self.open_with(intercomMachineName="alpha", addons=["pi-something"])
        (info,) = self.lines(out, "info:")
        self.assertIn("add-ons differ", info)
        self.assertIn("`foreman machine setup alpha`", info)

    def test_a_non_hc_transport_gives_an_info_line(self):
        self.set_transport("tcp")
        out = self.open_with(intercomMachineName="alpha", addons=[])
        (info,) = self.lines(out, "info:")
        self.assertIn("`foreman setup --intercom-hc`", info)

    def test_a_missing_intercom_config_counts_as_not_hc(self):
        out = self.open_with(intercomMachineName="alpha", addons=[])
        self.assertIn("`foreman setup --intercom-hc`", "\n".join(self.lines(out, "info:")))

    def test_nothing_differs_means_no_info_line(self):
        self.set_transport("hc")
        out = self.open_with(intercomMachineName="alpha", addons=[])
        self.assertEqual(self.lines(out, "info:"), [])
        self.assertEqual(self.lines(out, "warning:"), [])


if __name__ == "__main__":
    unittest.main()
