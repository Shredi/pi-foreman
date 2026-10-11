"""foreman_retro cache line: keep-alives, warm compactions, cold resumes (approximate)."""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import _isolation  # noqa: E402,F401  (agent dir -> temp)
import foreman_retro as fr  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures"


def load(name):
    return [json.loads(x) for x in (FIX / name).read_text().splitlines() if x.strip()]


def ts(sec):
    return "2026-01-01T10:%02d:%02dZ" % (sec // 60, sec % 60)


def line(sec, role="foreman", kind="first", cache_read=0, cost=0.1, **kw):
    r = {"ts": ts(sec), "foremanSession": "s1", "role": role, "provider": "claude-bridge", "kind": kind,
         "input": 10, "cacheRead": cache_read, "cacheWrite": 500, "output": 5, "cost": {"total": cost}}
    r.update(kw)
    return r


class CacheLineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="retro_cache_"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def metrics(self, usage, trace=None, config=None):
        return fr.cache_metrics(trace if trace is not None else [], usage, "s1", config or {})

    def test_cold_resume_after_idle_gap(self):
        c = self.metrics(load("retro_cache_usage.jsonl"), load("retro_cache_trace.jsonl"))
        self.assertEqual(c["coldResumes"], 1)
        self.assertEqual(c["ttlSeconds"], 300)

    def test_keepalives_bridge_the_gap(self):
        usage = [line(0, cache_read=9000)] + [line(s, kind="keepalive", cache_read=9500, cost=0.01)
                                              for s in (270, 540)] + [line(600, cache_read=9500)]
        c = self.metrics(usage)
        self.assertEqual((c["coldResumes"], c["keepalives"]), (0, 2))

    def test_warm_compactions(self):
        c = self.metrics([], load("retro_cache_trace.jsonl"))
        self.assertEqual(c["warmCompactions"], 2)

    def test_keepalive_cost_summed(self):
        usage = [line(0), line(100, kind="keepalive", cost=0.011), line(200, kind="keepalive", cost=0.022),
                 line(300, kind="keepalive", cost=0.033)]
        c = self.metrics(usage)
        self.assertEqual(c["keepalives"], 3)
        self.assertAlmostEqual(c["keepaliveCost"], 0.066, places=4)
        self.assertEqual(fr.cache_line(c), "cache: keepalives 3 ($0.07), warm compactions 0, cold resumes 0")

    def test_absent_without_policy_and_counts(self):
        usage = [line(0, provider="nopolicy"), line(1000, provider="nopolicy")]
        self.assertIsNone(self.metrics(usage))
        rep = fr.build([{"type": "session", "id": "s1"}], [], usage, None, 5, str(self.tmp))
        self.assertNotIn("cache:", fr.render_text(rep))

    def test_no_ttl_reports_zero_cold_resumes(self):
        cfg = {"providers": {"nopolicy": {"cache": {"billing": "token"}}}}
        usage = [line(0, provider="nopolicy", cache_read=9000), line(1000, provider="nopolicy"),
                 line(1100, kind="keepalive", provider="nopolicy")]
        c = self.metrics(usage, config=cfg)
        self.assertEqual((c["coldResumes"], c["keepalives"]), (0, 1))

    def test_role_rows_exclude_keepalives(self):
        base = [line(0), line(60), line(120, role="builder", launchId="L1")]
        plain = fr.usage_metrics(base, "s1")
        withka = fr.usage_metrics(base + [line(90, kind="keepalive", cost=5)], "s1")
        self.assertEqual(plain, withka)
        self.assertEqual(withka["foreman"]["launches"], {"first": 2})

    def test_json_key_and_text_line(self):
        sess = [{"type": "session", "id": "s1"}]
        rep = fr.build(sess, load("retro_cache_trace.jsonl"), load("retro_cache_usage.jsonl"), None, 5, str(self.tmp))
        self.assertEqual(rep["cache"], {"keepalives": 0, "keepaliveCost": 0, "warmCompactions": 2,
                                        "coldResumes": 1, "ttlSeconds": 300})
        self.assertIn("cache: keepalives 0 ($0.00), warm compactions 2, cold resumes 1", fr.render_text(rep))
        sp = self.tmp / "s.jsonl"
        sp.write_text(json.dumps(sess[0]) + "\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            fr.main(["--session", str(sp), "--trace", str(FIX / "retro_cache_trace.jsonl"),
                     "--usage", str(FIX / "retro_cache_usage.jsonl"), "--agent-dir", str(self.tmp), "--json"])
        self.assertEqual(json.loads(out.getvalue())["cache"]["coldResumes"], 1)


if __name__ == "__main__":
    unittest.main()
