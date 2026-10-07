import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "bench"))
import wait_session as ws  # noqa: E402

ROLES = ["foreman", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"]


def row(**kw):
    roles = {r: {"model": "p/%s" % r} for r in ROLES}
    roles["builder"]["strong"] = {"model": "p/builder-strong"}
    return dict({"id": "r", "agent": "foreman", "provider": "p", "roles": roles}, **kw)


def error_msg(text, stop="error", role="assistant"):
    return {"type": "message_end", "message": {"role": role, "stopReason": stop, "errorMessage": text}}


class DenyTest(unittest.TestCase):
    def test_select_picks_the_no_option(self):
        rec = {"id": "1", "method": "select", "options": ["Yes", "Yes, for this session", "No", "No, provide reason"]}
        self.assertEqual(ws.deny_response(rec), {"type": "extension_ui_response", "id": "1", "value": "No"})

    def test_select_without_a_no_option_is_cancelled(self):
        out = ws.deny_response({"id": "2", "method": "select", "options": ["Allow", "Block"]})
        self.assertEqual(out, {"type": "extension_ui_response", "id": "2", "cancelled": True})

    def test_checkpoint_select_is_approved_and_other_selects_are_not(self):
        title = "pi-foreman checkpoint: plan-x.md (0123abcd)"
        rec = {"id": "5", "method": "select", "title": title, "options": ["approve", "revise", "reject"]}
        self.assertEqual(ws.deny_response(rec), {"type": "extension_ui_response", "id": "5", "value": "approve"})
        self.assertNotIn("value", ws.deny_response(dict(rec, title="Permission Required")))
        self.assertEqual(ws.deny_response(dict(rec, method="confirm"))["confirmed"], False)

    def test_confirm_is_never_confirmed(self):
        self.assertEqual(ws.deny_response({"id": "3", "method": "confirm"})["confirmed"], False)

    def test_input_and_editor_are_cancelled(self):
        for m in ("input", "editor"):
            self.assertEqual(ws.deny_response({"id": "4", "method": m}), {"type": "extension_ui_response", "id": "4", "cancelled": True})

    def test_role_from_a_forwarded_child_ask(self):
        self.assertEqual(ws.ask_role({"title": "Subagent 'builder' requests permission", "message": "uname -s"}), "builder")
        self.assertIsNone(ws.ask_role({"title": "pi-foreman: approval needed", "message": "x"}))


class AskTitleTest(unittest.TestCase):
    def test_command_lines_and_what_follows_are_dropped(self):
        title = "Permission Required\ntool : bash\nsubagent : builder\nrule : bash curl *\ncommand : curl http://x/secret\nrule : late\nfull command : a && curl x\ninput : {}"
        self.assertEqual(ws.ask_title(title), "Permission Required\ntool : bash\nsubagent : builder\nrule : bash curl *")
        self.assertEqual(ws.ask_title("one line"), "one line")
        self.assertEqual(ws.ask_title("T\nnote\nfull command : x"), "T")


class RefusalTest(unittest.TestCase):
    def test_refusal_is_classified_and_is_not_a_usage_limit(self):
        rec = error_msg("Your request: our safeguards flagged this message as a possible violation")
        self.assertTrue(ws.provider_refusal_error(rec))
        self.assertIsNone(ws.usage_limit_error(rec))
        self.assertTrue(ws.usage_limit_error(error_msg("You hit your weekly limit")))
        self.assertIsNone(ws.provider_refusal_error(error_msg("You hit your weekly limit")))

    def test_negatives(self):
        self.assertIsNone(ws.provider_refusal_error(error_msg("connection reset")))
        # a normal assistant turn that talks about refusing, and a non-error stop reason
        self.assertIsNone(ws.provider_refusal_error({"message": {"role": "assistant", "stopReason": "stop", "content": "def refuse(x): ..."}}))
        self.assertIsNone(ws.provider_refusal_error(error_msg("safeguards flagged this message", stop="stop")))
        self.assertIsNone(ws.provider_refusal_error(error_msg("safeguards flagged this message", role="user")))

    def test_note_refusal_sets_infra_fields_and_keeps_a_usage_limit(self):
        st = {}
        ws.note_refusal(st, "x" * 300)
        self.assertEqual((st["status"], st["infra_error"], len(st["error"])), ("infra_error", "provider_refusal", 200))
        st = {"infra_error": "usage_limit", "error": "e"}
        ws.note_refusal(st, "flagged this message")
        self.assertEqual(st["infra_error"], "usage_limit")


class BuildWorldTest(unittest.TestCase):
    def test_review_strong_trace_and_schema(self):
        cfg = ws.foreman_config(row(_required_child_extensions=["/x/fake.ts"]))
        p = cfg["providers"]["p"]
        self.assertEqual(p["review"], {"model": "p/reviewer"})
        self.assertEqual(p["roles"]["builder"]["strong"], {"model": "p/builder-strong"})
        self.assertTrue(cfg["trace"]["enabled"])
        self.assertNotIn("ceremony", cfg)
        self.assertEqual(ws.foreman_config(row(review_model="p/other"))["providers"]["p"]["review"]["model"], "p/other")
        fake = ws.foreman_config(row(_fake=True))["providers"]["p"]["review"]["model"]
        self.assertEqual(fake, "p/review-defer")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "foreman.json").write_text(json.dumps(cfg))
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "foreman_config.py"), "validate", "--json",
                                "--agent-dir", tmp, "--project-dir", tmp], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(r.returncode, 0, r.stdout.decode() + r.stderr.decode())

    def test_project_commands_reach_the_permission_config(self):
        cfg = ws.foreman_config(row(project_commands=["cargo test *"]))
        self.assertEqual(cfg["safety"]["permissions"]["projectCommands"], ["cargo test *"])
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "foreman.json").write_text(json.dumps(cfg))
            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "permissions_gen.py"), "--agent-dir", tmp, "render"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(r.returncode, 0, r.stderr.decode())
            self.assertIn('"cargo test *"', r.stdout.decode())


if __name__ == "__main__":
    unittest.main()
