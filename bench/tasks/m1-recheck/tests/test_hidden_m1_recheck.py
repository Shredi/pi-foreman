"""Hidden check for the M1 re-check: the M1 live run pass criteria, unchanged.

1. A ledger was written with the write tool and bound to the foreman session, and every item,
   V included, is closed.
2. explorer, builder and reviewer were each launched, in that order, and each ran detached.
3. The tests pass and subtract(a, b) works.
4. The diff touches only calc.py and test_calc.py (.workflow/ and __pycache__ ignored).

Evidence comes from the foreman's adapter trace, its session marker and the waiter's record of
pi-subagents async runs, which the bench waiter copies to /logs/agent.
"""
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

APP = Path("/app")
LOGS = Path("/logs/agent")
ROLES = ["explorer", "builder", "reviewer"]


def jsonl(path):
    out = []
    for line in path.read_text("utf-8", "replace").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def foreman_traces():
    """[(session id, records)] for every trace whose session_start names the foreman role."""
    out = []
    for f in sorted((LOGS / "trace").glob("trace-*.jsonl")):
        recs = jsonl(f)
        if any(r.get("event") == "session_start" and r.get("role") == "foreman" for r in recs):
            out.append((f.name[len("trace-"):-len(".jsonl")], recs))
    return out


def live_ledgers():
    d = APP / ".workflow"
    if not d.is_dir():
        return []
    return [f for f in sorted(d.iterdir()) if re.match(r"(?i)ledger[-._].*\.md$", f.name) and not re.search(r"(?i)[-_]archive\.md$", f.name)]


class M1RecheckTest(unittest.TestCase):
    def setUp(self):
        self.foreman = foreman_traces()
        self.assertTrue(self.foreman, "no foreman trace in /logs/agent/trace")

    def bound_ledger(self):
        for sid, recs in self.foreman:
            marker = LOGS / "state" / ("fable-orch-model-%s.json" % re.sub(r"[^A-Za-z0-9_-]", "", sid))
            try:
                ledger = json.loads(marker.read_text("utf-8")).get("ledger")
            except (OSError, ValueError):
                continue
            if ledger and Path(ledger).parent.name.lower() == ".workflow":
                return sid, recs, Path(ledger).name
        return None

    def test_ledger_written_bound_and_closed(self):
        bound = self.bound_ledger()
        self.assertIsNotNone(bound, "no foreman session has a bound ledger")
        _, recs, name = bound
        self.assertTrue(any(r.get("event") == "guard" and r.get("guard") == "ledger_bind" and r.get("toolFamily") == "Write"
                            for r in recs), "the foreman never wrote a file with the write tool")
        ledger = APP / ".workflow" / name
        self.assertTrue(ledger.is_file(), "bound ledger %s missing in /app/.workflow" % name)
        text = ledger.read_text("utf-8")
        items = re.findall(r"^\s*- \[(.)\] (\d+|V)\.", text, re.M)
        self.assertTrue(any(i == "V" for _, i in items), "ledger has no V. item")
        self.assertTrue(any(i != "V" for _, i in items), "ledger has no numbered item")
        open_items = [i for mark, i in items if mark.lower() != "x"]
        self.assertEqual(open_items, [], "ledger items not closed")

    def test_roles_launched_in_order_and_detached(self):
        bound = self.bound_ledger()
        recs = bound[1] if bound else self.foreman[0][1]
        launches = [r.get("role") for r in recs if r.get("event") == "role_launch"]
        for role in ROLES:
            self.assertIn(role, launches, "%s was never launched" % role)
        first = [launches.index(r) for r in ROLES]
        self.assertEqual(first, sorted(first), "launch order was not explorer -> builder -> reviewer: %s" % launches)
        status = json.loads((LOGS / "bench-run.json").read_text("utf-8"))
        detached = [a for run in status.get("async_runs_at_end") or [] for a in run.get("agents") or []]
        for role in ROLES:
            self.assertIn(role, detached, "%s did not run as a detached (async) child" % role)

    def test_tests_pass(self):
        r = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(APP), "-p", "test_*.py"],
                           cwd=str(APP), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout.decode("utf-8", "replace")[-800:])
        self.assertIn("subtract", (APP / "test_calc.py").read_text("utf-8"), "test_calc.py has no subtract test")
        sys.path.insert(0, str(APP))
        from calc import add, subtract  # noqa: E402
        self.assertEqual(subtract(5, 3), 2)
        self.assertEqual(subtract(2, 5), -3)
        self.assertEqual(add(2, 3), 5)

    def test_diff_only_target_files(self):
        out = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=str(APP),
                             stdout=subprocess.PIPE, check=True, timeout=60).stdout.decode("utf-8")
        paths = set()
        for line in out.splitlines():
            p = line[3:].split(" -> ")[-1].strip('"')
            if p.startswith(".workflow/") or "__pycache__" in p.split("/"):
                continue
            paths.add(p)
        self.assertEqual(paths, {"calc.py", "test_calc.py"})


if __name__ == "__main__":
    unittest.main()
