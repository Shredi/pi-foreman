import contextlib
import io
import json
import subprocess
import sys
import tempfile
import time
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
        rec = {"id": "5", "method": "select", "title": title, "options": ["revise", "reject", "approve"]}
        self.assertEqual(ws.deny_response(rec), {"type": "extension_ui_response", "id": "5", "value": "approve"})
        # the title alone is not enough: the options must be exactly the three answers
        for opts in (["approve", "No"], ["approve", "revise", "reject", "other"], ["approve", "approve", "revise"], None):
            self.assertNotEqual(ws.deny_response(dict(rec, options=opts)).get("value"), "approve", opts)
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
        self.assertNotIn("review", p)  # no review_model: the harness default (cheapest role-map model) applies
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


class FakePi:
    """Stands in for PiRpc: each prompt is answered with a response, an optional notify and an optional file write."""

    def __init__(self, on_prompt=None):
        self.sent, self.queue, self.on_prompt = [], [], on_prompt

    def send(self, msg):
        self.sent.append(msg)
        if msg.get("type") == "prompt":
            self.queue.append({"type": "response", "id": msg["id"], "success": True})
            self.queue.append({"type": "extension_ui_request", "method": "notify", "message": "out of %s" % msg["message"]})
            if self.on_prompt:
                self.on_prompt(msg["message"])

    def _next(self, deadline):  # absolute epoch deadline, like PiRpc._next
        if time.time() >= deadline:
            raise TimeoutError
        if self.queue:
            return self.queue.pop(0)
        raise TimeoutError

    def request(self, msg):
        return {"isStreaming": False, "pendingMessageCount": 0}


class PostStepsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work, self.state = Path(tmp.name) / "app", Path(tmp.name) / "state"
        (self.work / ".git").mkdir(parents=True)
        (self.work / "a.txt").write_text("one")

    def run_steps(self, steps, pi):
        status = {}
        ws.run_post_steps(pi, {"bench": {"post_steps": steps}}, str(self.work), self.state, status, quiet_seconds=0, cap_seconds=5)
        return status

    def test_steps_default_to_none_and_map_to_slash_commands(self):
        self.assertEqual(ws.post_steps_of(row()), [])
        pi = FakePi()
        self.assertEqual(self.run_steps([], pi), {})
        self.assertEqual(pi.sent, [])
        status = self.run_steps(["retro", "sync", "bogus"], pi)
        self.assertEqual([m["message"] for m in pi.sent], ["/retro --model", "/sync --dry-run"])
        self.assertEqual([r.get("error") for r in status["post_steps"]["steps"]], [None, None, "unknown_step"])

    def test_retro_gets_known_limits_only_when_the_file_exists(self):
        lim = self.work.parent / "limits.md"
        r = {"bench": {"known_limits": str(lim)}}
        self.assertEqual(ws.post_step_command(r, "retro"), "/retro --model")
        lim.write_text("offline")
        self.assertEqual(ws.post_step_command(r, "retro"), "/retro --model --known-limits " + str(lim))
        self.assertEqual(ws.post_step_command(r, "sync"), "/sync --dry-run")

    def test_output_goes_to_state_marker_is_written_and_unchanged_workspace_is_not_infra(self):
        status = self.run_steps(["retro"], FakePi())
        self.assertEqual((self.state / "post-steps" / "retro.txt").read_text("utf-8").strip(), "out of /retro --model")
        self.assertGreater(json.loads((self.state / ws.POST_MARKER).read_text("utf-8"))["ms"], 0)
        self.assertFalse(status["post_steps"]["workspace_changed"])
        self.assertNotIn("infra_error", status)
        self.assertEqual(sorted(p.name for p in self.work.iterdir()), [".git", "a.txt"])

    def test_workspace_change_marks_the_cell_infra_but_git_dir_changes_do_not(self):
        (self.work / ".git" / "HEAD").write_text("x")
        self.assertEqual(self.run_steps(["retro"], FakePi(lambda _: (self.work / ".git" / "index").write_text("y")))
                         .get("infra_error"), None)
        status = self.run_steps(["retro"], FakePi(lambda _: (self.work / "a.txt").write_text("two")))
        self.assertEqual(status["infra_error"], "post_step_changed_workspace")
        status = {"infra_error": "usage_limit"}
        ws.run_post_steps(FakePi(lambda _: (self.work / "b.txt").write_text("n")), {"bench": {"post_steps": ["sync"]}},
                          str(self.work), self.state, status, quiet_seconds=0, cap_seconds=5)
        self.assertEqual(status["infra_error"], "usage_limit")  # an earlier infra reason is kept

    def test_post_step_finishes_on_agent_settled_and_warns_at_the_cap(self):
        pi = FakePi()
        pi.send = lambda msg: pi.queue.extend([{"type": "response", "id": msg["id"], "success": True},
                                              {"type": "agent_start"}, {"type": "agent_end"}, {"type": "agent_settled"}])
        t0 = time.time()
        text, err = ws.run_post_step(pi, 0, "/retro", quiet_seconds=60, cap_seconds=30)
        self.assertIsNone(err)
        self.assertLess(time.time() - t0, 5)
        err_out = io.StringIO()
        with contextlib.redirect_stderr(err_out):
            text, err = ws.run_post_step(FakePi(), 0, "/retro", quiet_seconds=60, cap_seconds=0.05)
        self.assertEqual(err, "step_cap_reached")
        self.assertIn("WARNING post step 0", err_out.getvalue())


if __name__ == "__main__":
    unittest.main()
