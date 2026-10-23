"""One pane, one session: join() picks the winner by a total order, not by walk order, and a session that
lost its pane does not push to it."""
import itertools
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_herdr_sidebar import SYMS, PLUGIN, FakeHerdr, node, sidebar, write_agent_dir

G = SYMS["unicode"]
AGENTS = [{"pane_id": "w1:p1", "agent": "pi", "cwd": "/w"}]


def sess(key, state="working", age=10, pid=None, pane="w1:p1"):
    sym = "done" if state == "done" else "lost" if state in ("lost", "stale") else "working"
    return node(key, "session", key, sym, state, G, pane=pane, age=age, pid=pid, sid=key)


class WinnerTest(unittest.TestCase):
    def winner(self, nodes, procinfo=None):
        joins = sidebar.join(nodes, AGENTS, procinfo)
        self.assertLessEqual(len(joins), 1)
        return next(iter(joins), None)

    def test_both_input_orders_pick_the_same_winner(self):
        nodes = [sess("a", age=30), sess("b", age=5), sess("c", "done", age=1), sess("d", "stale", age=0)]
        got = {self.winner(list(p)) for p in itertools.permutations(nodes)}
        self.assertEqual(got, {"b"})

    def test_equal_records_tie_on_session_id(self):
        a, b = sess("a"), sess("b")
        self.assertEqual({self.winner([a, b]), self.winner([b, a])}, {"a"})

    def test_stale_heartbeat_with_reused_pid_loses(self):
        old = sess("old", "stale", age=4 * 86400, pid=4242)
        fresh = sess("fresh", age=40, pid=7)
        for order in ([old, fresh], [fresh, old]):
            self.assertEqual(self.winner(order, {"w1:p1": 4242}), "fresh")

    def test_stale_alone_does_not_claim_without_matching_agent_session(self):
        old = sess("old", "stale", age=99999, pid=4242)
        agents = [{"pane_id": "w1:p1", "agent": "pi", "agent_session": "/x/other.jsonl"}]
        self.assertEqual(sidebar.join([old], agents, {"w1:p1": 4242}), {})

    def test_pane_foreground_pid_beats_age(self):
        a, b = sess("a", age=5, pid=1), sess("b", age=50, pid=2)
        self.assertEqual(self.winner([a, b], {"w1:p1": 2}), "b")

    def test_repeated_joins_with_varying_walk_order_never_flip(self):
        live = sess("live", age=60, pid=9)
        leftovers = [sess("r%d" % i, "idle" if i % 2 else "lost", age=1000 + i) for i in range(4)]
        leftovers = [dict(n, state="lost") for n in leftovers]
        seen = set()
        for i, perm in enumerate(itertools.permutations([live] + leftovers)):
            if i % 7:
                continue
            seen.add(self.winner(list(perm)))
        self.assertEqual(seen, {"live"})

    def test_dedupe_panes_agrees_with_join(self):
        nodes = [sess("a", "done", age=1), sess("b", age=300)]
        roots, joins = sidebar.dedupe_panes(nodes, {"a": "w1:p1", "b": "w1:p1"})
        self.assertEqual(list(joins), ["b"])
        self.assertEqual([n["key"] for n in roots], ["b"])


@unittest.skipUnless(os.name == "posix" and hasattr(socket, "AF_UNIX"), "POSIX AF_UNIX socket")
class LoserPushTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir="/tmp" if os.path.isdir("/tmp") else None)
        self.herdr = FakeHerdr(os.path.join(self.tmp, "h.sock"))
        self.adir = write_agent_dir(self.tmp)
        self.state = os.path.join(self.tmp, "state")

    def tearDown(self):
        self.herdr.close()
        shutil.rmtree(self.tmp)

    def push(self):
        env = dict(os.environ, HERDR_SOCKET_PATH=os.path.join(self.tmp, "h.sock"),
                   HERDR_PLUGIN_STATE_DIR=self.state, HERDR_SIDEBAR_WIDTH="26")
        return subprocess.run([sys.executable, str(PLUGIN / "sidebar.py"), "push", "--session", "sid-1",
                               "--pane", "p1", "--agent-dir", self.adir],
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)

    def winners(self, mapping):
        os.makedirs(self.state, exist_ok=True)
        with open(os.path.join(self.state, "winners.json"), "w", encoding="utf-8") as fh:
            json.dump(mapping, fh)

    def test_non_winner_does_not_publish(self):
        self.winners({"p1": "sid-other"})
        res = self.push()
        self.assertEqual((res.returncode, res.stdout, res.stderr), (0, b"", b""))
        self.assertEqual(self.herdr.reports(), [])
        self.assertFalse(os.path.exists(os.path.join(self.state, "push", "sid-1.stamp")))

    def test_winner_publishes(self):
        self.winners({"p1": "sid-1"})
        self.push()
        self.assertEqual(len(self.herdr.reports()), 1)

    def test_pane_without_a_winner_entry_publishes(self):
        self.winners({"p2": "sid-other"})
        self.push()
        self.assertEqual(len(self.herdr.reports()), 1)

    def test_stale_winners_file_is_ignored(self):
        self.winners({"p1": "sid-other"})
        path = os.path.join(self.state, "winners.json")
        old = os.path.getmtime(path) - 3600
        os.utime(path, (old, old))
        self.push()
        self.assertEqual(len(self.herdr.reports()), 1)

    def test_daemon_publishes_winners(self):
        roots = [sess("a", age=3), sess("b", age=1)]
        joins = {"a": "w1:p1"}
        self.assertEqual(sidebar.pane_winners(roots, joins), {"w1:p1": "a"})


if __name__ == "__main__":
    unittest.main()
