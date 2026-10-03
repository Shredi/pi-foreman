"""Golden replay scenarios on the fake provider (design section 10, ledger items 43, 60, 69).

Run:  python -m unittest discover -s tests/replay -v
Needs node, Pi 1.0.0 (global npm install) and pi-subagents 0.75.0 (installed on first use
into FOREMAN_REPLAY_CACHE, or FOREMAN_PI_SUBAGENTS). Without Pi the tests skip, unless
FOREMAN_REPLAY_REQUIRED=1 (CI), where a missing Pi is a failure.
FOREMAN_REPLAY_UPDATE_GOLDEN=1 rewrites the golden files from the current run.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import driver  # noqa: E402
from driver import PROVIDER_A, PROVIDER_B, Rig, load_fixture, marker, notifications, shape, tool_results, trace_of  # noqa: E402


def _unavailable():
    if not shutil.which("node"):
        return "node not on PATH"
    try:
        driver.pi_cli()
        driver.pi_subagents_dir()
    except Exception as exc:  # noqa: BLE001 - any setup failure means "cannot replay here"
        return str(exc)
    return None


REASON = _unavailable()
if REASON and os.environ.get("FOREMAN_REPLAY_REQUIRED") == "1":
    raise RuntimeError("replay prerequisites missing: %s" % REASON)

GOLDEN = Path(__file__).resolve().parent / "golden"


@unittest.skipIf(REASON is not None, "replay prerequisites missing: %s" % REASON)
class ReplayCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        self.t0 = time.time()
        self.rigs = []

    def tearDown(self):
        for r in self.rigs:
            r.close()
        sys.stderr.write("[replay] %s: %.1fs\n" % (self.id().rsplit(".", 1)[-1], time.time() - self.t0))

    def rig(self, name, script, **kw):
        r = Rig(name, script, **kw)
        self.rigs.append(r)
        return r

    def golden(self, name, actual):
        """Compare {key: shaped trace} with golden/<name>.json (or rewrite it on request)."""
        path = GOLDEN / (name + ".json")
        if os.environ.get("FOREMAN_REPLAY_UPDATE_GOLDEN") == "1":
            GOLDEN.mkdir(exist_ok=True)
            path.write_text(json.dumps(actual, indent=1) + "\n", "utf-8")
        self.assertEqual(actual, json.loads(path.read_text("utf-8")))


class TestLedgerFlow(ReplayCase):
    """Item 60: session marker written at session_start (decision C2) and session-scoped ledgers."""

    def test_marker_spawn_stop_and_second_session(self):
        rig = self.rig("ledger", load_fixture("ledger_flow"))
        a = rig.start()
        sid_a = a.session_id()
        # C2: the adapter wrote the marker at session_start, before any ledger exists.
        m = marker(rig, sid_a)
        self.assertIsNotNone(m, "no session marker after session_start")
        self.assertEqual(m.get("session_id"), sid_a)
        self.assertNotIn("ledger", m)

        recs = a.prompt("[[replay:a1]] start", timeout=60)
        [(_, err, text)] = tool_results(recs, "subagent")
        self.assertTrue(err)
        self.assertIn("LEDGER GUARD", text)
        self.assertIn("no ledger of its own", text)

        recs = a.prompt("[[replay:a2]] continue", timeout=60)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("write", False), ("bash", False), ("subagent", False)])
        ledger = rig.project / ".workflow" / "LEDGER-replay.md"
        self.assertIn("LEDGER-replay.md: 2 open item(s)", res[1][2])  # `ledger` shim on PATH, same session
        self.assertEqual(Path(marker(rig, sid_a)["ledger"]).resolve(), ledger.resolve())
        holds = [r["entry"] for r in recs if r.get("type") == "entry_appended" and (r.get("entry") or {}).get("customType") == "pi-foreman-stop-gate"]
        self.assertEqual(len(holds), 1, "stop gate did not hold exactly once while items are open")
        self.assertIn("still has 2 open item(s)", holds[0]["content"])
        notice, _ = a.wait_child_notify(timeout=90)
        self.assertIn("child result", notice)
        a.close()

        b = rig.start()
        sid_b = b.session_id()
        self.assertNotEqual(sid_a, sid_b)
        recs = b.prompt("[[replay:b1]] start", timeout=60)
        res = tool_results(recs)
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", True), ("bash", True)])  # ledger exits 1: unbound
        self.assertIn("no ledger of its own", res[0][2])
        self.assertIn("this session has no ledger of its own", res[1][2])
        self.assertNotIn("ledger", marker(rig, sid_b))
        b.close()

        t = rig.traces()
        self.golden("ledger_flow", {"sessionA": shape(t["trace-" + sid_a]), "sessionB": shape(t["trace-" + sid_b])})


class TestWriteGate(ReplayCase):
    """A session may not `write` over a ledger another session owns."""

    def test_write_over_foreign_ledger_blocked(self):
        rig = self.rig("write", load_fixture("write_gate"))
        a = rig.start()
        sid_a = a.session_id()
        res = tool_results(a.prompt("[[replay:w1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("write", False)])
        a.close()
        ledger = rig.project / ".workflow" / "LEDGER-other.md"
        before = ledger.read_text("utf-8")

        b = rig.start()
        sid_b = b.session_id()
        [(name, err, text)] = tool_results(b.prompt("[[replay:w2]] start", timeout=60))
        self.assertEqual((name, err), ("write", True))
        self.assertIn("LEDGER", text)
        self.assertEqual(ledger.read_text("utf-8"), before)
        b.close()
        t = rig.traces()
        self.golden("write_gate", {"sessionA": shape(t["trace-" + sid_a]), "sessionB": shape(t["trace-" + sid_b])})


class TestDestructiveGuard(ReplayCase):
    """Destructive guard deny on `bash`, and on the same call made from inside `codemode`.
    `shred --version` is denied by the guard on its name alone; if it ever ran it would only
    print a version string."""

    def test_bash_and_codemode_denied(self):
        rig = self.rig("destructive", load_fixture("destructive"))
        pi = rig.start()
        sid = pi.session_id()
        res = tool_results(pi.prompt("[[replay:c1]] start", timeout=60))
        # The nested call made by the codemode script is hooked and reported as its own bash call.
        self.assertEqual([(n, e) for n, e, _ in res], [("bash", True), ("bash", True), ("codemode", True)])
        self.assertTrue(res[0][2].startswith("DESTRUCTIVE GUARD:"), res[0][2])
        self.assertTrue(res[1][2].startswith("DESTRUCTIVE GUARD:"), res[1][2])
        self.assertIn("Script failed", res[2][2])
        self.assertIn("DESTRUCTIVE GUARD:", res[2][2])
        pi.close()
        self.golden("destructive", {"session": shape(rig.traces()["trace-" + sid])})


class TestAskHandling(ReplayCase):
    """A guard `ask`: RPC answers it through extension_ui_request; print/JSON mode blocks it.
    The command is `true || find … -delete`: the guard asks because of `find -delete`, and the
    `true ||` short-circuit means find never runs even when the ask is approved."""

    def test_ask_rpc_approve_deny_and_no_ui(self):
        rig = self.rig("ask", load_fixture("ask"))
        pi = rig.start()
        sid = pi.session_id()
        recs = pi.prompt("[[replay:d1]] approve", answers=[{"confirmed": True}], timeout=60)
        asks = [r for r in recs if r.get("type") == "extension_ui_request" and r.get("method") == "confirm"]
        self.assertEqual(len(asks), 1)
        self.assertIn("find", asks[0].get("message", ""))
        [(_, err, _)] = tool_results(recs, "bash")
        self.assertFalse(err)
        recs = pi.prompt("[[replay:d1]] deny", answers=[{"confirmed": False}], timeout=60)
        [(_, err, text)] = tool_results(recs, "bash")
        self.assertTrue(err)
        self.assertTrue(text.startswith("Denied by the user."), text)
        pi.close()

        code, recs, _ = rig.run_print("[[replay:d1]] json", mode="json")
        [(_, err, text)] = tool_results(recs, "bash")
        self.assertTrue(err)
        self.assertIn("needs approval, no UI (mode: json)", text)
        code, out, err = rig.run_print("[[replay:d1]] print", mode="text")
        self.assertEqual(code, 0)
        self.assertIn("Asked.", out)  # print mode: the blocked call shows only in the trace below

        t = rig.traces()
        rpc = shape(t.pop("trace-" + sid))
        others = sorted((shape(v) for v in t.values()), key=json.dumps)
        no_ui = [r for v in others for r in v if r.get("event") == "ask"]
        self.assertEqual(no_ui, [{"event": "ask", "guard": "destructive_guard", "toolFamily": "Bash", "decision": "no-ui"}] * 2)
        self.golden("ask", {"rpc": rpc, "printAndJson": others})


class TestProviderSwitch(ReplayCase):
    """The same role launch under two parent providers gets each provider's mapped child model."""

    def test_child_model_follows_parent_provider(self):
        rig = self.rig("provider", load_fixture("provider_switch"), providers=(PROVIDER_A, PROVIDER_B))
        seen = {}
        for provider in (PROVIDER_A, PROVIDER_B):
            pi = rig.start(provider=provider)
            res = tool_results(pi.prompt("[[replay:p1]] start", timeout=60))
            self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
            notice, _ = pi.wait_child_notify(timeout=90)
            self.assertIn("child result", notice)
            pi.close()
            child = trace_of(rig.traces(), "child", provider + "/")
            self.assertIsNotNone(child, "no child trace on %s" % provider)
            seen[provider] = [r["model"] for r in child if r.get("event") in ("session_start", "llm")]
        self.assertEqual(seen, {PROVIDER_A: ["foreman-fake/explorer"] * 2, PROVIDER_B: ["foreman-fake-b/explorer"] * 2})
        t = rig.traces()
        self.golden("provider_switch", {p: shape(trace_of(t, "foreman", p + "/")) for p in (PROVIDER_A, PROVIDER_B)})


class TestRequiredChildExtension(ReplayCase):
    """R3: a detached child carries the adapter as a required child extension (its guard blocks
    in the child), and /foreman doctor names the registration path that is active."""

    def test_child_guarded_and_doctor_names_path(self):
        rig = self.rig("childext", load_fixture("child_extension"))
        pi = rig.start()
        res = tool_results(pi.prompt("[[replay:f1]] start", timeout=60))
        self.assertEqual([(n, e) for n, e, _ in res], [("subagent", False)])
        notice, _ = pi.wait_child_notify(timeout=90)
        self.assertIn("child: the guard refused", notice)
        doctor = "\n".join(notifications(pi.prompt("/foreman doctor", timeout=30)))
        pi.close()
        self.assertIn("required child extension pi-foreman-core-adapter:", doctor)
        expected = os.environ.get("FOREMAN_REPLAY_REGISTRATION", "global-symbol registry")
        self.assertIn("INFO required child extension registration path: " + expected, doctor)
        child = trace_of(rig.traces(), "child")
        self.assertIsNotNone(child, "adapter did not load in the child")
        self.golden("child_extension", {"child": shape(child)})


if __name__ == "__main__":
    unittest.main()
