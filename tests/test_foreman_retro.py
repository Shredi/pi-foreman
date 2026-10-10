"""scripts/foreman_retro.py on synthetic JSONL fixtures."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_retro as fr  # noqa: E402

SECRET = "super-secret-token-xyz"
USER = {"kind": "user", "via": "dialog"}


def ask(rid, family_cmd, outcome, session, ts, decided=USER):
    return [
        {"event": "permission_request.%s" % outcome, "requestId": rid, "toolName": "bash", "command": family_cmd,
         "timestamp": ts, "decidedBy": decided},
        {"event": "foreman_review.decision", "requestId": rid, "sessionId": session},
    ]


class RetroTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="retro_test_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name, records, torn=False):
        p = self.tmp / name
        with open(p, "w", encoding="utf-8") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
            if torn:
                fh.write('{"event": "tor')
        return str(p)

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = fr.main(list(argv))
        self.assertEqual(rc, 0)
        return out.getvalue()

    def test_review_metrics_and_overridden_denial(self):
        recs = []
        recs += ask("a", "git push origin %s" % SECRET, "denied", "s1", "2026-01-01T00:00:01")
        recs += ask("b", "git push origin main", "approved", "s1", "2026-01-01T00:00:02")
        recs += ask("c", "ls -la", "approved", "s1", "2026-01-01T00:00:03", {"kind": "authorizer", "name": "foreman-review", "verdict": "allow"})
        recs.append({"event": "foreman_review.decision", "requestId": "c", "sessionId": "s1", "model": "m", "verdict": "allow"})
        recs += ask("d", "ls", "approved", "other", "2026-01-01T00:00:04")
        rep = fr.build(None, None, None, recs, 5, str(self.tmp))
        r = rep["review"]
        self.assertEqual((r["human_approved"], r["human_denied"], r["review_allow"]), (2, 1, 1))
        self.assertEqual(r["denials_overridden"], 1)  # no session id: every ask counts
        sess = [{"type": "session", "id": "s1"}]
        r = fr.build(sess, None, None, recs, 5, str(self.tmp))["review"]
        self.assertEqual((r["human_approved"], r["review_allow"], r["denials_overridden"]), (1, 1, 1))

    def test_trace_usage_and_session_tools(self):
        trace = [
            {"event": "guard", "guard": "git_guard", "decision": "block"},
            {"event": "guard", "guard": "git_guard", "decision": "allow"},
            {"event": "overlay", "decision": "deny"},
            {"event": "triage_gate", "decision": "blocked"},
            {"event": "revision", "decision": "blocked"},
            {"event": "safe_op", "decision": "ran"}, {"event": "safe_op", "decision": "precondition_failed"},
            {"event": "supervisor_request", "decision": "open"},
            {"event": "turn", "cause": "intercom"}, {"event": "turn", "cause": "child"},
        ]
        usage = [
            {"foremanSession": "s1", "role": "builder", "launchId": "l1", "kind": "first", "input": 10, "output": 5, "cacheRead": 1, "cacheWrite": 2, "cost": {"total": 0.5}},
            {"foremanSession": "s1", "role": "builder", "launchId": "l2", "kind": "revision", "input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.25}},
            {"foremanSession": "zzz", "role": "builder", "launchId": "l9", "kind": "first", "input": 99, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 9}},
        ]
        calls = [{"type": "message", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "name": "bash", "arguments": {"command": "git status %d" % i}} for i in range(3)]}}]
        sess = [{"type": "session", "id": "s1"}] + calls
        rep = fr.build(sess, trace, usage, None, 5, str(self.tmp))
        t = rep["trace"]
        self.assertEqual(t["guard_blocks"], {"git_guard": 1})
        self.assertEqual((t["overlay_blocks"], t["triage_gate_blocks"], t["revisions"], t["supervisor_requests"]), (1, 1, 1, 1))
        self.assertEqual(t["precondition_hit_rate"], 0.5)
        self.assertEqual(t["turn_causes"], {"intercom": 1, "child": 1})
        b = rep["usage"]["builder"]
        self.assertEqual((b["children"], b["tokensIn"], b["cost"]), (2, 11, 0.75))
        self.assertEqual(rep["session_tools"]["top_tools"], {"bash": 3})
        self.assertEqual(rep["session_tools"]["repeated_bash_families"], {"git status": 3})

    def test_zero_logged_cost_is_priced_from_rates(self):
        rec = {"foremanSession": "s1", "role": "builder", "provider": "claude-bridge", "model": "m1", "input": 1000000,
               "output": 100000, "cacheRead": 2000000, "cacheWrite": 0, "cost": {"total": 0}}
        paid = dict(rec, model="m2", cost={"total": 0.5})
        rates = {"claude-bridge/m1": {"input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1.25},
                 "claude-bridge/m2": {"input": 100, "output": 100}}
        self.assertAlmostEqual(fr.usage_metrics([rec], "s1", rates)["builder"]["cost"], 1 + 0.5 + 0.2)
        self.assertEqual(fr.usage_metrics([rec], "s1")["builder"]["cost"], 0)
        self.assertEqual(fr.usage_metrics([paid], "s1", rates)["builder"]["cost"], 0.5)

    def test_friction_counters(self):
        trace = [
            {"event": "rereview", "role": "reviewer"},
            {"event": "read_budget", "action": "deny"}, {"event": "read_budget", "action": "warn"},
            {"event": "recheck_budget", "action": "deny"},
            {"event": "rung_up", "role": "builder"},
            {"event": "child_read_budget", "action": "warn"}, {"event": "child_read_budget", "action": "deny"},
            {"event": "review_defer_headless"},
            {"event": "turn", "cause": "user"}, {"event": "turn"},
        ]
        t = fr.build(None, trace, None, None, 5, str(self.tmp))["trace"]
        self.assertEqual({k: t[k] for k in ("rereviews", "budget_hits", "rung_up", "child_read_budget", "review_defer_headless", "turns")},
                         {"rereviews": 1, "budget_hits": 2, "rung_up": 1, "child_read_budget": 2, "review_defer_headless": 1, "turns": 2})
        out = self.run_cli("--trace", self.write("t.jsonl", trace))
        self.assertIn("friction: rereviews=1 budget_hits=2 rung_up=1 child_read_budget=2 review_defer_headless=1 turns=2", out)

    def test_proposal_threshold_deny_and_baseline(self):
        recs = []
        n = 0
        for fam_cmd, count in (("npm ci", 3), ("make build", 2), ("rsync -a x y", 3), ("sudo ls", 3)):
            for i in range(count):
                n += 1
                recs += ask("r%d" % n, fam_cmd, "approved", "s%d" % (i % 2), "2026-01-01T00:00:%02d" % n)
        recs += ask("bad", "rsync -a z", "denied", "s0", "2026-01-01T00:01:00")
        rep = fr.build(None, None, None, recs, 3, str(self.tmp))
        self.assertEqual([p["pattern"] for p in rep["proposals"]], ["npm ci *"])  # make: 2 < 3; rsync denied; sudo baseline-denied
        one_session = []
        for i in range(4):
            one_session += ask("o%d" % i, "cargo build", "approved", "s1", "2026-01-01T00:00:0%d" % i)
        self.assertEqual(fr.build(None, None, None, one_session, 3, str(self.tmp))["proposals"], [])

    def test_cli_torn_line_proposals_file_and_no_content(self):
        recs = []
        for i in range(4):
            recs += ask("p%d" % i, "npm ci --token %s" % SECRET, "approved", "s%d" % (i % 2), "2026-01-01T00:00:0%d" % i)
        log = self.write("review.jsonl", recs, torn=True)
        out_file = self.tmp / "sub" / "proposals.json"
        text = self.run_cli("--review-log", log, "--proposals-out", str(out_file), "--min-reviews", "3", "--agent-dir", str(self.tmp))
        self.assertNotIn(SECRET, text)
        self.assertIn("proposals: 1 candidate", text)
        self.assertIn("trace: no data", text)
        doc = json.loads(out_file.read_text(encoding="utf-8"))
        self.assertNotIn(SECRET, json.dumps(doc))
        self.assertEqual(doc["minReviews"], 3)
        self.assertEqual(doc["proposals"][0]["pattern"], "npm ci *")
        self.assertIn("safety.permissions.bash.allow", doc["apply_hint"])
        j = json.loads(self.run_cli("--review-log", log, "--json", "--agent-dir", str(self.tmp)))
        self.assertIn("proposals", j)

    def test_missing_files_say_no_data(self):
        text = self.run_cli("--session", str(self.tmp / "nope.jsonl"), "--agent-dir", str(self.tmp / "agent"))
        self.assertIn("approvals: no data", text)
        self.assertIn("spawn cost: no data", text)

    def test_code_running_families_are_never_proposed(self):
        bad = ["python3 -c", "python3.12 script.py", "node -e", "/usr/bin/bash -c", "sh -c", "pwsh -Command", "cmd /c", "osascript -e",
               "eval echo", "xargs rm", "env FOO=1", "sudo make", "ssh host", "git config", "git -c", "npx tool", "npm exec", "find -exec",
               "FOO=1 make", "nohup make", "nice make", "time make", "timeout 5", "command make", "stdbuf -oL", "busybox sh",
               "uv run", "uvx tool", "pipx run", "poetry run", "pnpm dlx", "pnpm exec", "yarn dlx", "yarn exec", "bunx tool",
               "go run", "cargo run", "awk {print}", "gawk -f", "mawk -f", "lua x.lua", "Rscript x.R", "tclsh x", "dash -c",
               "ksh -c", "fish -c", "git remote", "git submodule", "git -C", "git -cx=y", "git --git-dir=x", "git --work-tree",
               "git --exec-path=x", "git --config-env=a=B", "git --namespace", "git -p", "git --paginate",
               "doas make", "setsid make", "watch make", "parallel echo", "flock /tmp/l", "script -c", "strace make",
               "ltrace make", "chroot /x", "runuser -u", "su -c", "wsl make", "wsl.exe make", "git hook", "git bisect",
               "git rebase", "git filter-branch"]
        for fam in bad:
            self.assertTrue(fr.runs_code(fam), fam)
        for fam in ["npm ci", "git status", "make test", "find .", "uv sync", "go build", "cargo build"]:
            self.assertFalse(fr.runs_code(fam), fam)
        asks = [{"family": f, "outcome": "approved", "session": sess} for f in bad + ["npm ci"] for sess in ("a", "b", "c")]
        self.assertEqual([p["pattern"] for p in fr.propose(asks, 3, [])], ["npm ci *"])

    def test_protected_path_families_are_never_proposed(self):
        prot = fr.load_protect_patterns(str(self.tmp / "agent"))
        bad = ["cat .git/config", "cp ./.pi/settings.json", "vim ~/.gitconfig", "cat %s" % (self.tmp / "agent" / "foreman.json").as_posix()]
        for fam in bad:
            self.assertTrue(fr.touches_protected(fam, prot), fam)
        self.assertFalse(fr.touches_protected("cat src/a.py", prot))
        asks = [{"family": f, "outcome": "approved", "session": sess} for f in bad + ["cat src/a.py"] for sess in ("a", "b", "c")]
        self.assertEqual([p["pattern"] for p in fr.propose(asks, 3, [], prot)], ["cat src/a.py *"])
        # Windows: expanduser yields backslashes and a drive; both sides must normalise the same way.
        win = lambda p: "C:\\Users\\T" + p[1:].replace("/", "\\") if p.startswith("~") else p
        with mock.patch.object(fr.os.path, "expanduser", win):
            wprot = fr.load_protect_patterns(str(self.tmp / "agent"))
            self.assertEqual(fr.norm_word("~\\.GitConfig"), "c:/users/t/.gitconfig")
            self.assertFalse([p for p in wprot if "\\" in p], wprot)
            for fam in ("vim ~/.gitconfig", "vim ~\\.gitconfig", "vim C:\\Users\\T\\.gitconfig"):
                self.assertTrue(fr.touches_protected(fam, wprot), fam)

    def backlog_run(self, session, *extra):
        trace = self.write("trace.jsonl", [
            {"event": "ask", "role": "builder", "runId": "run-%s" % session, "toolFamily": "bash", "decision": "child"},
            {"event": "ask", "role": "builder", "runId": "run-%s" % session, "toolFamily": "bash", "decision": "child"},
            {"event": "friction", "role": "builder", "runId": "run-%s" % session, "kind": "rule",
             "note": "the test command was missing from /tmp/%s/notes.md" % session},
        ])
        agent = self.tmp / "agent"
        return self.run_cli("--trace", trace, "--agent-dir", str(agent), "--backlog-workspace", str(self.tmp / "ws"),
                            "--workspace-key", "proj", "--backlog-session", session, *extra)

    def entries(self):
        import foreman_backlog as bl
        return bl.load(str(self.tmp / "agent" / "pi-foreman" / "state" / "retro" / "backlog" / "proj.md"))

    def test_backlog_two_candidates_bump_on_a_second_session_and_stay_stable(self):
        out = self.backlog_run("s1")
        self.assertIn("backlog: 2 new, 0 bumped (proj.md)", out)
        first = self.entries()
        self.assertEqual(len(first), 2)
        self.assertEqual({e["kind"] for e in first}, {"permission", "rule"})
        self.assertIn("backlog: 0 new, 2 bumped (proj.md)", self.backlog_run("s2"))
        second = self.entries()
        self.assertEqual(sorted(e["id"] for e in second), sorted(e["id"] for e in first))
        self.assertEqual([e["count"] for e in second], [2, 2])
        self.assertGreaterEqual(second[0]["last_seen"], first[0]["last_seen"])
        text = json.dumps(second)
        self.assertNotIn("/tmp", text)
        self.assertNotIn(str(self.tmp), text)
        self.assertNotIn("run-s1", text)

    def test_no_backlog_and_retro_disabled_write_nothing(self):
        out = self.backlog_run("s1", "--no-backlog")
        self.assertNotIn("backlog:", out)
        self.assertFalse((self.tmp / "agent" / "pi-foreman").exists())
        (self.tmp / "agent").mkdir()
        (self.tmp / "agent" / "foreman.json").write_text(json.dumps({"version": 1, "retro": {"enabled": False}}))
        self.backlog_run("s2")
        self.assertFalse((self.tmp / "agent" / "pi-foreman").exists())

    def test_child_trace_file_gives_a_per_role_ask_candidate(self):
        fore = self.write("trace-F1.jsonl", [{"event": "ask", "toolFamily": "Bash", "decision": "ask"}])
        child = self.write("trace-L1.jsonl", [
            {"event": "ask", "role": "builder", "runId": "L1", "toolFamily": "Bash", "decision": "child"},
            {"event": "ask", "role": "builder", "runId": "L1", "toolFamily": "Bash", "decision": "child"}])
        out = self.run_cli("--trace", fore, "--trace", child, "--agent-dir", str(self.tmp / "agent"),
                           "--backlog-workspace", str(self.tmp / "ws"), "--workspace-key", "proj")
        self.assertIn("backlog: 1 new", out)
        [e] = self.entries()
        self.assertEqual((e["kind"], e["candidate"], e["sessions"]), ("permission", "builder runs hit >=2 permission asks", ["F1"]))

    def test_candidate_classes_from_trace_usage_and_session_tools(self):
        trace = [{"event": "child_read_budget", "role": "explorer", "action": "deny"},
                 {"event": "rereview", "role": "reviewer"}, {"event": "rung_up", "role": "builder", "reason": "context"},
                 {"event": "ask", "toolFamily": "bash"}, {"event": "ask", "toolFamily": "bash"}]
        usage = [{"role": "builder", "launchId": "l%d" % i, "cost": {"total": c}} for i, c in enumerate((1, 1, 1, 9))]
        usage.append({"role": "builder", "launchId": "x", "kind": "retro", "cost": {"total": 99}})
        rep = {"review": {"denials_overridden": 1}, "proposals": [{"pattern": "git fetch *", "example_family": "git fetch", "approvals": 5, "sessions": 2}]}
        got = {c["candidate"]: c["kind"] for c in fr.candidates(rep, trace, usage, {"repeated_bash_families": {"git fetch": 3, "make test": 4}})}
        self.assertEqual(got["session runs hit >=2 permission asks"], "permission")
        self.assertEqual(got["explorer runs hit the child read budget"], "agent")
        self.assertEqual(got["reviewer needed a rereview after changes"], "agent")
        self.assertEqual(got["builder climbed a model rung (context)"], "routing")
        self.assertEqual(got["builder run cost over 2x the role median"], "routing")
        self.assertEqual((got["repeated bash family: git fetch"], got["repeated bash family: make test"]), ("permission", "rule"))
        self.assertEqual(got["allow bash pattern git fetch *"], "permission")
        self.assertEqual(got["denied permission asks were later approved for the same command family"], "permission")

    def test_bulk_read_candidates_from_session(self):
        def call(path):
            return {"type": "toolCall", "name": "read", "arguments": {"path": path}}
        calls = [call("/a/b/big.py")] * 3 + [call("C:\\x\\other.py")] + [call("/f%d.txt" % i) for i in range(46)]
        sess = [{"type": "message", "message": {"role": "assistant", "content": calls}}]
        m = fr.session_metrics(sess)
        self.assertEqual((m["read_calls"], m["repeated_reads"]), (50, {"big.py": 3}))
        got = {c["candidate"]: (c["kind"], c["evidence"]) for c in fr.candidates({}, [], [], m)}
        self.assertEqual(got["repeated reads of big.py"][0], "agent")
        self.assertEqual(got["bulk reads: >=50 read calls in one session"], ("agent", "50 read calls"))
        self.assertEqual(fr.candidates({}, [], [], fr.session_metrics(sess[:0])), [])

    def test_default_agent_dir_is_the_suite_temp_dir(self):
        import os
        import _isolation
        self.assertEqual(os.environ["PI_CODING_AGENT_DIR"], _isolation.AGENT_DIR)
        self.assertNotEqual(Path(_isolation.AGENT_DIR), Path.home() / ".pi" / "agent")
        trace = self.write("trace.jsonl", [{"event": "ask", "role": "builder", "runId": "r", "toolFamily": "bash", "decision": "child"}] * 2)
        home = self.tmp / "home"
        home.mkdir()
        with mock.patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}):
            self.run_cli("--trace", trace, "--backlog-workspace", str(self.tmp / "ws"), "--workspace-key", "iso",
                         "--backlog-session", "iso1")
        self.assertEqual(list(home.rglob("*")), [])
        self.assertTrue((Path(_isolation.AGENT_DIR) / "pi-foreman" / "state" / "retro" / "backlog" / "iso.md").exists())

    def test_selftest(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--selftest"]), 0)


if __name__ == "__main__":
    unittest.main()
