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
    verdict = "allow" if outcome == "approved" else "deny"
    layer = "dialog" if decided == USER else "review"
    return [{"id": rid, "ts": ts, "session": session, "tool": "bash", "layer": layer, "verdict": verdict,
             "shape": family_cmd, **({"model": "m"} if layer == "review" else {})}]


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

    def test_explorer_line_from_usage_and_research_rung_events(self):
        def u(lid, model, role="explorer"):
            return {"foremanSession": "s1", "role": role, "launchId": lid, "kind": "first", "provider": "p", "model": model}
        usage = [u("a", "m-opus"), u("a", "m-opus"), u("b", "m-sonnet"), u("c", "m-sonnet"), u("d", "m-haiku", "child"), u("e", "m-sonnet", "builder")]
        trace = [{"event": "research_rung", "role": "explorer", "marker": "fact-critical", "kind": "single", "model": "p/m-opus"},
                 {"event": "research_rung", "role": "explorer", "marker": "research", "kind": "entry", "model": "p/m-haiku"}]
        ranks = {"p": [{"match": "m-opus*", "tier": 0}, {"match": "m-sonnet*", "tier": 1}, {"match": "m-haiku*", "tier": 2}]}
        e = fr.explorer_metrics(trace, usage, "s1", ranks)
        # singles by usage (one per launchId), tasks/chain entries by event; a single's event adds nothing
        self.assertEqual((e["launches"], e["models"], e["factCritical"], e["topShare"]), (4, {"p/m-opus": 1, "p/m-sonnet": 2, "p/m-haiku": 1}, 1, 25))
        self.assertEqual(fr.render_explorer(e), "explorer: 4 launches, m-opus 1 (25 %, fact-critical 1); m-sonnet 2; m-haiku 1")
        self.assertIsNone(fr.explorer_metrics(trace, usage, "s1")["topShare"])
        self.assertIn("; fact-critical 1", fr.render_explorer(fr.explorer_metrics(trace, usage, "s1")))

    def test_git_pack_line_compares_pack_and_bash_git(self):
        trace = [{"event": "tool_pack", "pack": "git", "op": o} for o in ("status", "status", "log", "move")]
        trace.append({"event": "tool_pack", "pack": "other", "op": "log"})
        cmds = ["cd x && git status", "git log -3", "gitleaks detect", "ls"]
        sess = [{"type": "message", "message": {"role": "assistant", "content": [
            {"type": "toolCall", "name": "bash", "arguments": {"command": c}} for c in cmds]}}]
        rep = fr.build(sess, trace, None, None, 5, str(self.tmp))
        self.assertEqual(rep["trace"]["git_pack"], {"status": 2, "log": 1, "move": 1})
        self.assertEqual(rep["session_tools"]["bash_git_calls"], 2)
        self.assertEqual(fr.git_pack_line(rep), "git: pack 4 calls (status 2, log 1, move 1) vs bash git 2")
        self.assertIn(fr.git_pack_line(rep), fr.render_text(rep).splitlines()[:10])
        self.assertEqual(fr.git_pack_line(fr.build(None, None, None, None, 5, str(self.tmp))), None)
        self.assertEqual(fr.git_pack_line(fr.build(None, [], None, None, 5, str(self.tmp))), None)

    def test_pr_line_and_git_line_split_pr_ops(self):
        ops = ("pr_checks", "pr_checks", "pr_create", "pr_watch", "status")
        trace = [{"event": "tool_pack", "pack": "git", "op": o} for o in ops]
        rep = fr.build(None, trace, None, None, 5, str(self.tmp))
        self.assertEqual(rep["trace"]["pr_pack"], {"pr_checks": 2, "pr_create": 1, "pr_watch": 1})
        self.assertEqual(rep["trace"]["git_pack"], {"status": 1})
        self.assertEqual(fr.pr_pack_line(rep), "pr: 4 calls (create 1, checks 2, watch 1)")
        self.assertIn(fr.pr_pack_line(rep), fr.render_text(rep).splitlines())
        self.assertIsNone(fr.pr_pack_line(fr.build(None, [], None, None, 5, str(self.tmp))))
        self.assertIsNone(fr.pr_pack_line(fr.build(None, None, None, None, 5, str(self.tmp))))

    def test_pr_track_events_are_no_longer_counted(self):
        rep = fr.build(None, [{"event": "pr_track", "path": "push", "count": 1}], None, None, 5, str(self.tmp))
        self.assertNotIn("pr_track", rep["trace"])
        self.assertFalse([l for l in fr.render_text(rep).splitlines() if l.startswith("pr: tracked")])

    def test_explorer_counts_unmarked_launch_entries(self):
        trace = [{"event": "launch_entry", "role": "explorer", "kind": "entry", "model": "p/m-haiku"},
                 {"event": "launch_entry", "role": "builder", "kind": "entry", "model": "p/m-haiku"},
                 {"event": "launch_entry", "role": "explorer", "kind": "entry", "model": None}]
        e = fr.explorer_metrics(trace, [], "s1")
        self.assertEqual((e["launches"], e["models"]), (2, {"p/m-haiku": 1, "?": 1}))

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
            {"event": "read_budget", "action": "remind"},
            {"event": "recheck_budget", "action": "deny"},
            {"event": "rung_up", "role": "builder"},
            {"event": "child_read_budget", "action": "warn"}, {"event": "child_read_budget", "action": "deny"},
            {"event": "review_defer_headless"},
            {"event": "turn", "cause": "user"}, {"event": "turn"},
        ]
        t = fr.build(None, trace, None, None, 5, str(self.tmp))["trace"]
        self.assertEqual({k: t[k] for k in ("rereviews", "budget_hits", "rung_up", "child_read_budget", "review_defer_headless", "turns")},
                         {"rereviews": 1, "budget_hits": 3, "rung_up": 1, "child_read_budget": 2, "review_defer_headless": 1, "turns": 2})
        out = self.run_cli("--trace", self.write("t.jsonl", trace))
        self.assertIn("friction: rereviews=1 budget_hits=3 rung_up=1 child_read_budget=2 review_defer_headless=1 turns=2", out)

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

    def retro_run(self, *extra):
        trace = self.write("trace.jsonl", [
            {"event": "ask", "role": "builder", "runId": "run-1", "toolFamily": "bash", "decision": "child"},
            {"event": "ask", "role": "builder", "runId": "run-1", "toolFamily": "bash", "decision": "child"},
            {"event": "rereview", "role": "reviewer"},
            {"event": "report", "role": "builder", "kind": "rule", "subject": "guard x", "effect": "blocked", "id": "abc"},
        ])
        return self.run_cli("--trace", trace, "--agent-dir", str(self.tmp / "agent"), *extra)

    def test_retro_creates_no_entries_and_keeps_its_report(self):
        out = self.retro_run()
        self.assertIn("friction: rereviews=1", out)
        self.assertNotIn("backlog:", out)
        self.assertFalse((self.tmp / "agent" / "pi-foreman").exists())
        self.assertEqual(json.loads(self.retro_run("--json"))["trace"]["rereviews"], 1)
        self.assertFalse((self.tmp / "agent" / "pi-foreman").exists())

    def test_report_events_are_counted_by_kind(self):
        t = fr.trace_metrics([{"event": "report", "kind": "rule"}, {"event": "report", "kind": "rule"}, {"event": "report", "kind": "skill"}, {"event": "friction", "kind": "rule"}])
        self.assertEqual(t["reports"], {"rule": 2, "skill": 1})
        self.assertIn("reports: rule=1", self.retro_run())

    def test_the_old_backlog_flags_are_accepted_and_do_nothing(self):
        out = self.retro_run("--backlog-workspace", str(self.tmp / "ws"), "--workspace-key", "proj", "--backlog-session", "s1", "--no-backlog")
        self.assertIn("friction: rereviews=1", out)
        self.assertFalse((self.tmp / "agent" / "pi-foreman").exists())
        self.assertFalse((self.tmp / "ws").exists())

    def test_retro_has_no_candidate_generation(self):
        for name in ("candidates", "emit_backlog", "FRICTION_KINDS", "DEFAULT_ASK_THRESHOLD"):
            self.assertFalse(hasattr(fr, name), name)

    def test_default_agent_dir_is_the_suite_temp_dir(self):
        import os
        import _isolation
        self.assertEqual(os.environ["PI_CODING_AGENT_DIR"], _isolation.AGENT_DIR)
        self.assertNotEqual(Path(_isolation.AGENT_DIR), Path.home() / ".pi" / "agent")
        trace = self.write("trace.jsonl", [{"event": "ask", "role": "builder", "runId": "r", "toolFamily": "bash", "decision": "child"}] * 2)
        home = self.tmp / "home"
        home.mkdir()
        with mock.patch.dict(os.environ, {"HOME": str(home), "USERPROFILE": str(home)}):
            self.run_cli("--trace", trace)
        self.assertEqual(list(home.rglob("*")), [])
        self.assertFalse((Path(_isolation.AGENT_DIR) / "pi-foreman" / "state" / "retro" / "backlog").exists())

    def test_selftest(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--selftest"]), 0)


def tool_usage_line(i, role="foreman", used=(), found=(), read=(), declared=None, hidden=("example_hidden",),
                    skills_listed=("example-listed-skill", "example-unread-skill"), skills_hidden=("example-domain-skill",)):
    declared = ["read", "example_used", "example_tool", "example_extra"] if declared is None else declared
    return {"ts": "2026-01-01T00:00:%02d.000Z" % (i % 60), "kind": "tool-usage", "session": "s%d" % i, "role": role,
            "declared": declared, "hidden": list(hidden), "used": list(used), "found": list(found),
            "skillsListed": list(skills_listed), "skillsHidden": list(skills_hidden), "skillsRead": list(read),
            "sources": {"read": "builtin", "example_used": "pi-foreman", "example_tool": "example-package",
                        "example_extra": "example-package", "fusion_reason": "pi-background-tasks"}}


class ToolUsageRetroTest(unittest.TestCase):
    NOW = 1767225600.0 + 3600  # 2026-01-01T01:00:00Z

    def setUp(self):
        self.agent = Path(tempfile.mkdtemp(prefix="retro_tu_"))
        self.addCleanup(shutil.rmtree, self.agent, True)
        self.dir = self.agent / "pi-foreman" / "state" / "usage"
        self.dir.mkdir(parents=True)

    def write_sessions(self, lines, name="f1.jsonl"):
        with open(self.dir / name, "w", encoding="utf-8") as fh:
            for r in lines:
                fh.write(json.dumps(r) + "\n")

    def twenty(self):
        out = []
        for i in range(20):
            used = ["read", "example_used"] + (["example_tool"] if i == 0 else [])  # example_tool: 1 of 20 = 5%
            out.append(tool_usage_line(i, used=used, found=["example_hidden", "example-domain-skill"] if i < 6 else [],
                                       read=["example-listed-skill"]))
        return out

    def test_twenty_sessions_fire_suggestions_and_package_lines(self):
        self.write_sessions(self.twenty())
        t = fr.tool_usage_metrics(str(self.agent), now=self.NOW)
        text = "\n".join(fr.render_tool_usage(t))
        self.assertIn("tools: declared never used: example_extra (0 of 20 sessions); found: example_hidden (6 of 20)", text)
        self.assertIn("skills: listed never read: example-unread-skill; found: example-domain-skill (6 of 20)", text)
        self.assertIn('used in under 10% (foreman, 20 sessions): tools.deferred: add "example_tool"', text)
        self.assertEqual(text.count("example_extra"), 2)  # the counts line and the never-used line, not the searchable line
        self.assertIn("found in 25% or more", text)
        self.assertIn("always on, remove from tools.deferred: example_hidden", text)
        self.assertIn("never used (foreman, 20 sessions): example_extra (example-package) -> tools.deferred", text)
        self.assertIn("skills never read (foreman, 20 sessions): example-unread-skill -> skills.hidden or remove the skill directory", text)
        self.assertIn("skills found in 25% or more", text)
        self.assertNotIn("example_used", text)

    def test_rarely_used_tool_in_child_role_gets_no_under_10_percent_line(self):
        lines = []
        for i in range(20):
            used = ["read", "example_used"] + (["example_tool"] if i == 0 else [])
            lines.append(tool_usage_line(i, role="builder", used=used, hidden=()))
        self.write_sessions(lines)
        text = "\n".join(fr.render_tool_usage(fr.tool_usage_metrics(str(self.agent), now=self.NOW)))
        self.assertNotIn("used in under 10% (builder", text)
        self.assertNotIn("roles.builder.searchable", text)
        self.assertNotIn("roles.builder.tools: remove", text)

    def child_text(self, searchable):
        (self.agent / "foreman.json").write_text(json.dumps({"roles": {"builder": {"searchable": searchable}}}), encoding="utf-8")
        lines = [tool_usage_line(i, role="builder", used=["read", "example_used", "example_tool"], hidden=("example_extra",),
                                 found=["example_extra"] if i < 10 else []) for i in range(20)]
        self.write_sessions(lines)
        return "\n".join(fr.render_tool_usage(fr.tool_usage_metrics(str(self.agent), now=self.NOW)))

    def test_never_used_child_tool_in_role_searchable_names_searchable(self):
        text = self.child_text(["example_extra"])
        self.assertIn("never used (builder, 20 sessions): example_extra (example-package) -> roles.builder.searchable", text)

    def test_never_used_child_tool_in_role_tools_names_tools(self):
        text = self.child_text(["foreman_move"])
        self.assertIn("never used (builder, 20 sessions): example_extra (example-package) -> roles.builder.tools", text)
        self.assertNotIn("roles.builder.searchable", text)

    def test_child_role_gets_no_found_in_25_percent_line(self):
        text = self.child_text(["example_extra"])
        self.assertNotIn("found in 25% or more (builder", text)

    def test_unused_package_gets_pi_remove_and_bg_features_remedy(self):
        lines = []
        for i in range(20):
            line = tool_usage_line(i, used=["example_used"], declared=["example_used", "example_tool", "example_extra", "fusion_reason"])
            lines.append(line)
        self.write_sessions(lines)
        text = "\n".join(fr.render_tool_usage(fr.tool_usage_metrics(str(self.agent), now=self.NOW)))
        self.assertIn("example_extra, example_tool (example-package) -> pi remove npm:example-package", text)
        # pi-background-tasks is bundled: never a pi remove line, the source switch instead
        self.assertNotIn("pi remove npm:pi-background-tasks", text)
        self.assertIn("fusion_reason (pi-background-tasks) -> PI_BG_FEATURES=process", text)
        # a package with one used tool is not removed: the add-on's optional tool points at the source switch instead
        lines = [tool_usage_line(i, used=["example_used", "bg_run"], declared=["example_used", "bg_run", "fusion_reason"]) for i in range(20)]
        lines = [dict(l, sources={"example_used": "pi-foreman", "bg_run": "pi-background-tasks", "fusion_reason": "pi-background-tasks"}) for l in lines]
        self.write_sessions(lines)
        text = "\n".join(fr.render_tool_usage(fr.tool_usage_metrics(str(self.agent), now=self.NOW)))
        self.assertIn("fusion_reason (pi-background-tasks) -> PI_BG_FEATURES=process", text)
        self.assertNotIn("pi remove", text)

    def test_a_tool_is_printed_once_package_remedy_wins(self):
        lines = [tool_usage_line(i, used=["example_used"], declared=["example_used", "example_tool", "example_extra"]) for i in range(20)]
        self.write_sessions(lines)
        text = "\n".join(fr.render_tool_usage(fr.tool_usage_metrics(str(self.agent), now=self.NOW)))
        self.assertIn("-> pi remove npm:example-package", text)
        self.assertNotIn("used in under 10%", text)

    def test_floor_and_bg_feature_constants_match_deferred_ts(self):
        import re
        ts = (Path(__file__).resolve().parent.parent / "extensions" / "core-adapter" / "deferred.ts").read_text(encoding="utf-8")
        floor = re.search(r"DEFERRED_FLOOR[^=]*=\s*\[([^\]]*)\]", ts).group(1)
        self.assertEqual(list(fr.TOOL_FLOOR), re.findall(r'"([^"]+)"', floor))
        # the doctor's optional tools: fusion_ prefix and two names
        doctor = re.search(r"const optional = registered\.filter\(([^;]*)\);", ts).group(1)
        want = ["fusion_*"] + re.findall(r'n === "([^"]+)"', doctor)
        self.assertIn('n.startsWith("fusion_")', doctor)
        self.assertEqual(list(fr.BG_FEATURE_TOOLS), want)

    def test_five_sessions_print_counts_only(self):
        self.write_sessions(self.twenty()[:5])
        t = fr.tool_usage_metrics(str(self.agent), now=self.NOW)
        self.assertIsNone(t["suggestions"])
        text = "\n".join(fr.render_tool_usage(t))
        self.assertIn("tools: declared never used: example_extra (0 of 5 sessions); found: example_hidden (5 of 5)", text)
        self.assertIn("fewer than 20: no suggestion", text)
        self.assertNotIn("suggest", text.replace("no suggestion", ""))
        self.assertNotIn("->", text)

    def test_last_line_per_session_and_old_sessions_are_counted_right(self):
        first = tool_usage_line(1, used=[])
        last = dict(tool_usage_line(1, used=["example_extra"]), ts="2026-01-01T00:00:50.000Z")
        old = dict(tool_usage_line(2), ts="2025-01-01T00:00:00.000Z")
        self.write_sessions([last, first, old])
        t = fr.tool_usage_metrics(str(self.agent), now=self.NOW)
        self.assertEqual(t["sessions"], 1)
        self.assertNotIn("example_extra", t["tools_never_used"])
        self.assertIsNone(fr.tool_usage_metrics(str(self.agent / "nowhere"), now=self.NOW))

    def test_tool_usage_lines_do_not_change_usage_metrics(self):
        rec = {"role": "builder", "kind": "first", "launchId": "L1", "foremanSession": "f1", "input": 10, "output": 5,
               "cost": {"total": 0.5}}
        before = fr.usage_metrics([rec], "f1")
        extra = [tool_usage_line(1, role="builder"), dict(tool_usage_line(2, role="explorer"), foremanSession="f1")]
        self.assertEqual(fr.usage_metrics([rec] + extra, "f1"), before)
        self.assertEqual(list(fr.usage_metrics(extra, "f1")), [])
        self.assertEqual(fr.explorer_metrics(None, extra, "f1"), fr.explorer_metrics(None, [], "f1"))

    def test_cli_prints_the_lines_after_the_report(self):
        self.write_sessions(self.twenty())
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fr.main(["--agent-dir", str(self.agent)]), 0)
        # fixtures are dated 2026-01-01: inside the window only while the clock is near it, so only the shape is pinned here
        self.assertTrue(out.getvalue().startswith("pi-foreman retro"))


if __name__ == "__main__":
    unittest.main()
