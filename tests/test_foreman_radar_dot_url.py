"""scripts/foreman_radar.py --json: a PR dot passes its https `url` through; an unsafe or non-https one is dropped."""
from __future__ import annotations

import contextlib
import io
import json
import unittest
from unittest import mock

from test_foreman_radar import NOW, Fixture, live
import foreman_radar as fr


class DotUrlTests(Fixture):
    def dots(self, dots):
        d = live("s-u", "u", "fm-u", hb=5)
        d["dots"] = dots
        self.put_live(d)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), mock.patch.object(fr.time, "time", return_value=NOW):
            self.assertEqual(fr.main(["--agent-dir", str(self.adir), "--json"]), 0)
        (root,) = json.loads(out.getvalue())["roots"]
        return root["dots"]

    def test_https_url_is_passed_through(self):
        good = "https://example.test/acme/app/pull/7?x=1#top"
        got = self.dots([{"n": 7, "state": "ok", "label": "#7", "src": "pr", "url": good}])
        self.assertEqual(got, [{"n": 7, "state": "ok", "label": "#7", "src": "pr", "url": good}])

    def test_unsafe_or_non_https_url_is_dropped(self):
        bad = ["http://example.test/a/pull/1", "javascript:alert(1)", "https://example.test/a b", "https://example.test/a\nb",
               "https://example.test/a&b", "https://example.test/a|b", "https://example.test/a^b", "https://example.test/a<b",
               "https://example.test/a>b", 'https://example.test/a"b', "https://example.test/a'b", "https://example.test/a\\b",
               "https://example.test/" + "a" * 2100, 5, None, ["https://example.test/"]]
        got = self.dots([{"n": i, "state": "ok", "label": "#%d" % i, "src": "pr", "url": u} for i, u in enumerate(bad)]
                        + [{"n": 99, "state": "ok", "label": "#99", "src": "pr"}])
        self.assertEqual(len(got), 14)
        for d in got:
            self.assertNotIn("url", d)


if __name__ == "__main__":
    unittest.main()
