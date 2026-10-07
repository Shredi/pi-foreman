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
        text = self.run_cli("--session", str(self.tmp / "nope.jsonl"))
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

    def test_selftest(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--selftest"]), 0)


if __name__ == "__main__":
    unittest.main()
