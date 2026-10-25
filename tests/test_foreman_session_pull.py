"""Pull return path (scripts/foreman_session.py): protocol 2 probe and open, the outbox notice, the `remote outbox`
verb, `foreman session pull`, SSH connection sharing and the config keys.

Same fakes as test_foreman_session_remote.py (fake ssh, herdr and node; machine names alpha and beta). The tests that
need a fake binary, or real lstat/uid/mode/symlink behaviour, are `posix_only`; the pure-Python ones are not.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))
import test_foreman_session_remote as rt  # noqa: E402  (a module reference: its test classes are not re-collected here)

fsn, fc = rt.fsn, rt.fc
PARENT, ADDRESS, OTHER = rt.PARENT, rt.ADDRESS, rt.OTHER
posix_only, lines_of = rt.posix_only, rt.lines_of
STABLE = "fm-stable-id"
STABLE_ADDRESS = STABLE + "@beta"
PULL_MACHINES = {"alpha": {"parentName": "beta", "returnPath": "pull"}, "beta": {}, "gamma": {}}


def ago(seconds):
    return (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=seconds)).isoformat()


class PullBase(rt.RemoteBase):
    def setUp(self):
        super().setUp()
        self.write_config(PULL_MACHINES)

    def pull_open(self, **over):
        """A remote pull open with a stable-id parent: (reply, remote handoff dir)."""
        reply = self.remote_open(returnPath="pull", pollSeconds=20, parentAddress=STABLE_ADDRESS, **over)
        return reply, self.handoff(reply)

    def write_outbox(self, d, *lines):
        (d / "outbox.jsonl").write_text("".join(l + "\n" for l in lines), "utf-8")

    def outbox_call(self, reply, after=0, address=STABLE_ADDRESS, **over):
        params = {"handoffName": reply["handoffName"], "parentAddress": address, "after": after}
        params.update(over)
        return self.remote("outbox", params)


def entry(seq, text="t"):
    return json.dumps({"seq": seq, "at": "2026-10-25T10:00:00+00:00", "text": text})


@posix_only
class ProbeModeTest(PullBase):
    def probe(self, address=STABLE_ADDRESS, mode=None, **env):
        params = {"parentName": "beta", "parentAddress": address}
        if mode:
            params["returnPath"] = mode
        return self.remote("probe", params, **env)

    def test_pull_probe_reply(self):
        code, r = self.probe(mode="pull")
        self.assertEqual(code, 0)
        self.assertEqual((r["protocol"], r["returnPath"], r["returnPathOk"], r["relayCommand"]), (2, "pull", True, "pi-intercom"))
        self.assertNotIn("returnPathError", r)

    def test_pull_probe_needs_no_herdr_check(self):
        code, r = self.probe(mode="pull", FAKE_HERDR_MACHINES="[]", FAKE_HERDR_AGENTS="[]",
                             HERDR_BIN_PATH=str(self.tmp / "missing herdr"))
        self.assertEqual((code, r["returnPathOk"]), (0, True))
        _, push = self.probe(address=ADDRESS, HERDR_BIN_PATH=str(self.tmp / "missing herdr"))
        self.assertFalse(push["returnPathOk"])

    def test_push_probe_reply_and_missing_field_reads_as_push(self):
        for mode in (None, "push"):
            code, r = self.probe(address=ADDRESS, mode=mode)
            self.assertEqual((code, r["returnPath"], r["returnPathOk"]), (0, "push", True))

    def test_relay_command_comes_from_the_intercom_config(self):
        (self.radir / "intercom").mkdir()
        (self.radir / "intercom" / "config.json").write_text(
            json.dumps({"crossMachine": {"remoteCommand": "/opt/n/node /opt/n/cli.mjs"}}), "utf-8")
        self.assertEqual(self.probe(mode="pull")[1]["relayCommand"], "/opt/n/node /opt/n/cli.mjs")

    def test_pull_probe_needs_a_writable_handoff_root(self):
        with mock.patch.object(os, "access", return_value=False):
            code, r = self.probe(mode="pull")
        self.assertEqual((code, r["returnPath"], r["returnPathOk"]), (0, "pull", False))
        self.assertIn("not writable", r["returnPathError"])
        self.assertFalse((self.radir / "pi-foreman").exists())  # nothing was created

    def test_address_rules_per_mode(self):
        code, r = self.probe(address="a/b@beta", mode="pull")
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.probe(address=STABLE_ADDRESS)  # push: the P1 rule, a session UUID
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.probe(mode="sideways")
        self.assertEqual((code, r["code"]), (1, "bad_request"))

    def test_protocol_mismatch_names_both_values(self):
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), FAKE_SSH_PROTOCOL="3", HERDR_PANE_ID="")
        self.assertEqual(rc, 1)
        self.assertIn("[remote_protocol]", err)
        self.assertIn("speaks protocol 3, this side speaks 2;", err)


@posix_only
class OpenModeTest(PullBase):
    def calls(self):
        return lines_of(self.logs["ssh"])

    def test_pull_open_with_a_stable_id_and_no_pane(self):
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        probe, opened = (json.loads(c["stdin"]) for c in self.calls())
        self.assertEqual(probe, {"parentName": "beta", "parentAddress": STABLE_ADDRESS, "returnPath": "pull"})
        self.assertEqual((opened["returnPath"], opened["pollSeconds"], opened["parentAddress"]), ("pull", 20, STABLE_ADDRESS))
        row = self.parent_registry()[0]
        self.assertEqual((row["returnPath"], row["parent"], row["parentAddress"]), ("pull", STABLE, STABLE_ADDRESS))
        h = Path(row["remoteHandoff"])
        self.assertEqual((h / "return-path").read_text("utf-8").strip(), "pull")
        self.assertEqual((h / "parent").read_text("utf-8").strip(), STABLE_ADDRESS)
        self.assertIn("about every 20 s", (h / "brief.md").read_text("utf-8"))

    def test_a_row_without_returnpath_defaults_to_pull(self):
        (self.padir / "foreman.json").write_text(json.dumps({"sessions": {"machines": {"alpha": {"parentName": "beta"}}}}), "utf-8")
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.calls()[0]["stdin"])["returnPath"], "pull")

    def test_poll_seconds_follow_the_config(self):
        self.write_config({}, {"sessions": {"machines": PULL_MACHINES, "pull": {"intervalSeconds": 45}}})
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(self.calls()[1]["stdin"])["pollSeconds"], 45)

    def test_push_open_leaves_the_fields_out_and_writes_no_file(self):
        self.write_config({"alpha": {"parentName": "beta"}, "beta": {}})
        rc, out, err = self.run_main(*self.open_args())
        self.assertEqual(rc, 0, err)
        probe, opened = (json.loads(c["stdin"]) for c in self.calls())
        self.assertEqual(probe, {"parentName": "beta", "parentAddress": ADDRESS})
        self.assertNotIn("returnPath", opened)
        self.assertNotIn("pollSeconds", opened)
        row = self.parent_registry()[0]
        self.assertEqual(row["returnPath"], "push")
        self.assertFalse((Path(row["remoteHandoff"]) / "return-path").exists())
        self.assertNotIn("outbox.jsonl", (Path(row["remoteHandoff"]) / "brief.md").read_text("utf-8"))

    def test_no_opener_id_is_refused(self):
        env = {"PI_CODING_AGENT_DIR": str(self.padir)}
        rc, out, err = self.run_main(*self.open_args(parent=None), **env)
        self.assertEqual(rc, 1)
        self.assertIn("[no_return_path]", err)
        self.assertIn("no opener intercom id; pass --parent-id", err)
        self.assertEqual(self.calls(), [])

    def test_ids_outside_the_charset_are_refused(self):
        for bad in ("a/b", "a@b", "x" * 121, "sp ace"):
            rc, out, err = self.run_main(*self.open_args(parent=bad), HERDR_PANE_ID="")
            self.assertEqual(rc, 1, bad)
            self.assertIn("[no_return_path]", err)
            self.assertIn("A-Z a-z 0-9 . _ : -", err)
        self.assertEqual(self.calls(), [])

    def test_the_remote_refuses_a_non_uuid_address_in_push_mode(self):
        code, r = self.remote("open", self.open_params(parentAddress=STABLE_ADDRESS))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.remote("open", self.open_params(parentAddress=STABLE_ADDRESS, returnPath="push"))
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        self.assertFalse((self.radir / "pi-foreman").exists())

    def test_the_remote_open_checks_pull_fields(self):
        for over in ({"pollSeconds": 0}, {"pollSeconds": 3601}, {"pollSeconds": True}, {"pollSeconds": "20"}):
            code, r = self.remote("open", self.open_params(returnPath="pull", parentAddress=STABLE_ADDRESS, **over))
            self.assertEqual((code, r["code"]), (1, "bad_request"), over)
        code, r = self.remote("open", self.open_params(pollSeconds=20))  # a push open has no pollSeconds
        self.assertEqual((code, r["code"]), (1, "bad_request"))

    def test_a_pull_open_writes_return_path_and_a_push_open_does_not(self):
        reply, d = self.pull_open()
        self.assertEqual((d / "return-path").read_text("utf-8").strip(), "pull")
        self.assertEqual((d / "parent").read_text("utf-8").strip(), STABLE_ADDRESS)
        push = self.remote_open()
        self.assertFalse((self.handoff(push) / "return-path").exists())
        self.assertTrue((self.handoff(push) / "parent").is_file())


class NoticeModeBase(PullBase):
    def setUp(self):
        super().setUp()
        self.reply, self.dir = self.pull_open()
        self.env.update(PI_CODING_AGENT_DIR=str(self.radir), PI_FOREMAN_REMOTE_PARENT="1", PI_FOREMAN_HANDOFF_DIR=str(self.dir),
                        HERDR_PANE_ID="")

    def notice(self, *args, **env):
        code, out, err = self.run_main("remote", "notice", *args, **env)
        return code, json.loads(out)

    def lines(self):
        return [json.loads(l) for l in (self.dir / "outbox.jsonl").read_text("utf-8").splitlines()]


@posix_only
class OutboxNoticeTest(NoticeModeBase):
    def test_append_format_and_reply(self):
        data = "# Result\n\nAll done \u2713\n".encode("utf-8")
        (self.dir / "result.md").write_bytes(data)
        code, r = self.notice("result")
        self.assertEqual((code, r["ok"], r["queued"], r["seq"], r["bytes"], r["truncated"]), (0, True, True, 1, len(data), False))
        self.assertNotIn("sent", r)
        self.assertEqual(r["sha256"], rt.hashlib.sha256(data).hexdigest())
        (row,) = self.lines()
        self.assertEqual(sorted(row), ["at", "seq", "text"])
        head = "Result from demo: %s sha256:%s bytes:%d" % (self.dir / "result.md", r["sha256"], len(data))
        self.assertEqual(row["text"], head + "\n---\n" + data.decode("utf-8"))
        self.assertIsNotNone(datetime.datetime.fromisoformat(row["at"]))
        self.assertEqual(lines_of(self.logs["node"]), [])  # nothing is sent

    def test_seq_increments(self):
        (self.dir / "result.md").write_text("x", "utf-8")
        self.assertEqual([self.notice("result")[1]["seq"] for _ in range(3)], [1, 2, 3])
        self.assertEqual([l["seq"] for l in self.lines()], [1, 2, 3])

    def test_closed_notice_text(self):
        (self.dir / "result.md").write_text("x", "utf-8")
        code, r = self.notice("closed", "--close", "ready")
        self.assertEqual((code, r["queued"], r["seq"]), (0, True, 1))
        self.assertEqual(self.lines()[0]["text"], "foreman:closed %s CLOSE: ready" % (self.dir / "result.md"))

    def test_refused_notice_is_cut_and_stripped(self):
        code, r = self.notice("refused", "--reason=first line\x07 here\nsecond line")
        self.assertEqual((code, r["queued"]), (0, True))
        self.assertEqual(self.lines()[0]["text"], "foreman:refused first line here")
        self.notice("refused", "--reason=" + "y" * 500)
        self.assertEqual(self.lines()[1]["text"], "foreman:refused " + "y" * 200)
        self.notice("refused", "--reason=--leading dash")
        self.assertEqual(self.lines()[2]["text"], "foreman:refused --leading dash")

    def test_no_windows_cut_in_pull_mode(self):
        (self.dir / "result.md").write_bytes(b"a" * 33000)
        with mock.patch.object(fsn, "host_platform", return_value="win32"):
            code, r = self.notice("result")
        self.assertEqual((code, r["truncated"]), (0, True))  # cut at remoteInlineMaxBytes (32768), not at the argv limit
        body = self.lines()[0]["text"].split("\n---\n", 1)[1]
        self.assertEqual(len(body), 32768)

    def test_a_corrupt_last_line_refuses(self):
        self.write_outbox(self.dir, entry(1), "{not json")
        (self.dir / "result.md").write_text("x", "utf-8")
        code, r = self.notice("result")
        self.assertEqual((code, r["ok"], r["code"]), (1, False, "outbox_corrupt"))
        self.write_outbox(self.dir, entry(1), json.dumps({"seq": "2"}))
        self.assertEqual(self.notice("result")[1]["code"], "outbox_corrupt")
        self.assertEqual(len((self.dir / "outbox.jsonl").read_text("utf-8").splitlines()), 2)  # nothing appended

    def test_a_held_lock_refuses_with_outbox_locked(self):
        import fcntl
        (self.dir / "result.md").write_text("x", "utf-8")
        with open(self.dir / "outbox.lock", "a+b") as held, mock.patch.object(fsn, "OUTBOX_LOCK_SECONDS", 0.3):
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            code, r = self.notice("result")
        self.assertEqual((code, r["code"]), (1, "outbox_locked"))
        self.assertFalse((self.dir / "outbox.jsonl").exists())

    def test_two_notices_under_a_held_lock_serialize(self):
        import fcntl
        seqs = []
        with open(self.dir / "outbox.lock", "a+b") as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            threads = [threading.Thread(target=lambda t=t: seqs.append(fsn.outbox_append(self.dir, t))) for t in ("a", "b")]
            for t in threads:
                t.start()
            time.sleep(0.3)
            self.assertEqual(seqs, [])  # both wait for the lock
            fcntl.flock(held.fileno(), fcntl.LOCK_UN)
        for t in threads:
            t.join(10)
        self.assertEqual(sorted(seqs), [1, 2])
        self.assertEqual(sorted(l["seq"] for l in self.lines()), [1, 2])

    def test_push_mode_keeps_the_p1_reply_and_appends_nothing(self):
        push = self.remote_open()
        d = self.handoff(push)
        (d / "result.md").write_text("done", "utf-8")
        code, out, err = self.run_main("remote", "notice", "result", PI_FOREMAN_HANDOFF_DIR=str(d))
        r = json.loads(out)
        self.assertEqual((code, r["sent"], r["ok"]), (0, True, True))
        self.assertNotIn("queued", r)
        self.assertFalse((d / "outbox.jsonl").exists())
        self.assertEqual(len(lines_of(self.logs["node"])), 1)

    def test_a_non_uuid_parent_in_push_mode_is_bad_parent(self):
        push = self.remote_open()
        d = self.handoff(push)
        (d / "parent").write_text(STABLE_ADDRESS + "\n", "utf-8")
        (d / "result.md").write_text("done", "utf-8")
        code, out, err = self.run_main("remote", "notice", "result", PI_FOREMAN_HANDOFF_DIR=str(d))
        self.assertEqual((code, json.loads(out)["code"]), (1, "bad_parent"))


@posix_only
class OutboxVerbTest(PullBase):
    def setUp(self):
        super().setUp()
        self.reply, self.dir = self.pull_open()

    def test_cursor(self):
        self.write_outbox(self.dir, entry(1, "one"), entry(2, "two"), entry(3, "three"))
        code, r = self.outbox_call(self.reply, after=1)
        self.assertEqual(code, 0)
        self.assertEqual([(e["seq"], e["text"]) for e in r["entries"]], [(2, "two"), (3, "three")])
        self.assertEqual((r["next"], r["more"], r["skipped"]), (3, False, 0))
        self.assertEqual(self.outbox_call(self.reply, after=3)[1]["entries"], [])
        self.assertEqual(self.outbox_call(self.reply, after=3)[1]["next"], 3)
        self.assertEqual(self.outbox_call(self.reply, after=0)[1]["next"], 3)

    def test_no_outbox_file(self):
        code, r = self.outbox_call(self.reply, after=4)
        self.assertEqual((code, r["entries"], r["next"], r["more"], r["skipped"]), (0, [], 4, False, 0))

    def test_byte_cap_with_more_and_at_least_one_entry(self):
        self.write_outbox(self.dir, entry(1, "a" * 100), entry(2, "b" * 100), entry(3, "c" * 100))
        _, r = self.outbox_call(self.reply, maxBytes=400)
        self.assertEqual(([e["seq"] for e in r["entries"]], r["next"], r["more"]), ([1, 2], 2, True))
        _, r = self.outbox_call(self.reply, after=2, maxBytes=400)
        self.assertEqual(([e["seq"] for e in r["entries"]], r["more"]), ([3], False))
        _, r = self.outbox_call(self.reply, maxBytes=1)  # an entry larger than the cap still comes, alone
        self.assertEqual(([e["seq"] for e in r["entries"]], r["more"]), ([1], True))

    def test_bad_and_oversized_lines_are_skipped_and_counted(self):
        big = entry(3, "x" * 65537)
        self.write_outbox(self.dir, entry(1), "garbage", big, entry(1, "again"), json.dumps({"seq": "5", "text": "t"}),
                          json.dumps({"seq": 6, "text": 7}), json.dumps([1]), entry(4, "ok"))
        _, r = self.outbox_call(self.reply)
        self.assertEqual([e["seq"] for e in r["entries"]], [1, 4])
        self.assertEqual((r["skipped"], r["next"]), (6, 4))

    def test_wrong_session_and_handoff_checks(self):
        code, r = self.outbox_call(self.reply, address=OTHER + "@beta")
        self.assertEqual((code, r["code"]), (1, "wrong_session"))
        code, r = self.remote("outbox", {"handoffName": "20260101-000000-nope", "parentAddress": STABLE_ADDRESS, "after": 0})
        self.assertEqual((code, r["code"]), (1, "no_handoff"))
        code, r = self.remote("outbox", {"handoffName": "../x", "parentAddress": STABLE_ADDRESS, "after": 0})
        self.assertEqual((code, r["code"]), (1, "bad_request"))
        code, r = self.outbox_call(self.reply, after=-1)
        self.assertEqual((code, r["code"]), (1, "bad_request"))

    def test_live_comes_from_the_presence_file_of_the_child(self):
        live = self.radir / "pi-foreman" / "state" / "live"
        live.mkdir(parents=True)
        base = {"v": 1, "heartbeatAt": ago(30), "lastEventAt": ago(12), "state": "blocked", "blockedSince": ago(8),
                "runs": [{"state": "working"}, {"state": "done"}, {"state": "working"}], "paneId": "w9:p1"}
        (live / "other.json").write_text(json.dumps(dict(base, intercomId="fm-someone-else", state="working")), "utf-8")
        self.assertIsNone(self.outbox_call(self.reply)[1]["live"])  # only the child's own intercomId counts
        (live / "child.json").write_text(json.dumps(dict(base, intercomId=self.reply["child"])), "utf-8")
        got = self.outbox_call(self.reply)[1]["live"]
        self.assertEqual((got["state"], got["workingRuns"], got["paneId"]), ("blocked", 2, "w9:p1"))
        self.assertEqual(sorted(got), ["blockedAgeSeconds", "heartbeatAgeSeconds", "lastEventAgeSeconds", "paneId", "state",
                                       "workingRuns"])
        self.assertTrue(30 <= got["heartbeatAgeSeconds"] < 45, got)  # ages are computed on the remote
        self.assertTrue(12 <= got["lastEventAgeSeconds"] < 27, got)
        self.assertTrue(8 <= got["blockedAgeSeconds"] < 23, got)

    def test_live_not_blocked_has_a_null_blocked_age(self):
        live = self.radir / "pi-foreman" / "state" / "live"
        live.mkdir(parents=True)
        (live / "c.json").write_text(json.dumps({"intercomId": self.reply["child"], "heartbeatAt": ago(1), "lastEventAt": ago(1),
                                                 "state": "idle", "blockedSince": None, "runs": [], "paneId": None}), "utf-8")
        got = self.outbox_call(self.reply)[1]["live"]
        self.assertEqual((got["state"], got["blockedAgeSeconds"], got["workingRuns"], got["paneId"]), ("idle", None, 0, None))


class PullCommandBase(PullBase):
    def pull(self, target="demo", **env):
        rc, out, err = self.run_main("pull", target, "--json", **env)
        return rc, (json.loads(out) if out.strip() else None), err

    def registry_bytes(self):
        return (self.padir / "pi-foreman" / "state" / "sessions.json").read_bytes()


@posix_only
class PullCommandTest(PullCommandBase):
    def setUp(self):
        super().setUp()
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        self.row = self.parent_registry()[0]
        self.rh = Path(self.row["remoteHandoff"])

    def test_json_shape(self):
        self.write_outbox(self.rh, entry(1, "one"), entry(2, "two"))
        rc, out, err = self.pull()
        self.assertEqual(rc, 0, err)
        self.assertEqual(sorted(out), ["errors", "pulled"])
        self.assertEqual(out["errors"], [])
        (item,) = out["pulled"]
        self.assertEqual(sorted(item), ["child", "entries", "label", "live", "machine", "more", "next", "skipped"])
        self.assertEqual((item["child"], item["label"], item["machine"], item["next"], item["more"], item["live"]),
                         (self.row["child"], "demo", "alpha", 2, False, None))
        self.assertEqual([e["seq"] for e in item["entries"]], [1, 2])
        call = self.ssh_call()
        self.assertEqual(call["argv"][-1], "foreman session remote outbox --json")
        self.assertEqual(json.loads(call["stdin"]), {"handoffName": self.row["handoffName"], "parentAddress": STABLE_ADDRESS,
                                                      "after": 0, "maxBytes": 262144})

    def ssh_call(self):
        return lines_of(self.logs["ssh"])[-1]

    def test_the_cursor_comes_from_the_registry_entry(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        data = json.loads(reg.read_text("utf-8"))
        data["sessions"][0]["outboxSeq"] = 7
        reg.write_text(json.dumps(data), "utf-8")
        self.write_outbox(self.rh, *[entry(i) for i in range(1, 10)])
        rc, out, err = self.pull(self.row["child"])
        self.assertEqual(json.loads(self.ssh_call()["stdin"])["after"], 7)
        self.assertEqual([e["seq"] for e in out["pulled"][0]["entries"]], [8, 9])

    def test_nothing_changes_on_disk(self):
        self.write_outbox(self.rh, entry(1))
        before = self.registry_bytes()
        mirror = Path(self.row["mirror"])
        self.assertEqual(self.pull()[0], 0)
        self.assertEqual(self.registry_bytes(), before)
        self.assertEqual(list(mirror.iterdir()), [])
        self.assertEqual(sorted(p.name for p in (self.padir / "pi-foreman").iterdir()), ["remote", "state"])

    def test_unreachable_machine(self):
        rc, out, err = self.pull(FAKE_SSH_MODE="255")
        self.assertEqual(rc, 1)
        self.assertEqual(out["pulled"], [])
        (e,) = out["errors"]
        self.assertEqual((e["child"], e["label"], e["machine"]), (self.row["child"], "demo", "alpha"))
        self.assertIn("unreachable", e["error"])

    def test_an_ineligible_target_is_refused(self):
        rc, out, err = self.pull("nope")
        self.assertEqual((rc, out), (1, None))
        self.assertIn("no session", err)


class PullAllTest(PullCommandBase):
    def rows(self, **over):
        base = {"machine": "alpha", "returnPath": "pull", "status": "open", "handoffName": "20260101-000000-x",
                "parentAddress": STABLE_ADDRESS, "parent": STABLE, "handoff": "h", "last": None}
        return dict(base, **over)

    def test_all_pulls_only_eligible_entries(self):
        rows = [self.rows(label="open", child="fm-open-000001"),
                self.rows(label="pending", child="fm-pending-000002", status="pending"),
                self.rows(label="closing", child="fm-closing-000003", status="closing"),
                self.rows(label="closed", child="fm-closed-000004", status="closed"),
                self.rows(label="failed", child="fm-failed-000005", status="failed"),
                self.rows(label="push", child="fm-push-000006", returnPath="push"),
                self.rows(label="legacy", child="fm-legacy-000007", returnPath=None),
                self.rows(label="local", child="fm-local-000008", machine=None),
                "junk"]
        rows[6].pop("returnPath")
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        reg.write_text(json.dumps({"version": 1, "sessions": rows}), "utf-8")
        asked = []

        def fake(name, target, command, verb, payload, timeout):
            asked.append((name, verb, payload["handoffName"], timeout))
            return {"ok": True, "entries": [], "next": 0, "more": False, "skipped": 0, "live": None}

        with mock.patch.object(fsn, "ssh_verb", side_effect=fake), mock.patch.object(fsn, "machine_target", return_value="alpha-host"):
            rc, out, err = self.pull("all")
        self.assertEqual(rc, 0, err)
        self.assertEqual([p["label"] for p in out["pulled"]], ["open", "pending", "closing"])
        self.assertEqual(out["errors"], [])
        self.assertEqual({a[1:] for a in asked}, {("outbox", "20260101-000000-x", fsn.OUTBOX_TIMEOUT)})
        before = reg.read_bytes()
        self.assertEqual(reg.read_bytes(), before)

    def test_a_push_or_closed_target_is_not_pullable(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        reg.write_text(json.dumps({"version": 1, "sessions": [self.rows(label="push", child="fm-push-000006", returnPath="push"),
                                                              self.rows(label="done", child="fm-done-000009", status="closed")]}), "utf-8")
        for target in ("push", "done"):
            rc, out, err = self.pull(target)
            self.assertEqual((rc, out), (1, None))
            self.assertIn("[not_pullable]", err)

    def test_a_malformed_reply_is_an_error(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        reg.write_text(json.dumps({"version": 1, "sessions": [self.rows(label="open", child="fm-open-000001")]}), "utf-8")
        with mock.patch.object(fsn, "ssh_verb", return_value={"ok": True, "entries": "x"}), \
                mock.patch.object(fsn, "machine_target", return_value="alpha-host"):
            rc, out, err = self.pull("all")
        self.assertEqual((rc, out["pulled"]), (1, []))
        self.assertIn("malformed", out["errors"][0]["error"])


class FooterTest(unittest.TestCase):
    def test_pull_footer_wording(self):
        text = fsn.remote_footer("demo", True, 32768, mode="pull", poll_seconds=20)
        self.assertIn("the parent fetches them about every 20 s", text)
        self.assertIn("queued", text)
        self.assertIn("The parent closes the session", text)
        self.assertNotIn("the owner closes this pane", text)
        self.assertIn("within about a minute", fsn.remote_footer("demo", False, 32768, mode="pull"))
        self.assertNotIn("about every", fsn.remote_footer("demo", False, 32768, mode="pull"))

    def test_push_footer_is_the_default_and_unchanged(self):
        push = fsn.remote_footer("demo", False, 32768)
        self.assertEqual(push, fsn.remote_footer("demo", False, 32768, mode="push", poll_seconds=20))
        self.assertIn("the owner closes this pane on this machine", push)
        self.assertNotIn("queued", push)


@posix_only
class MuxTest(PullBase):
    def setUp(self):
        super().setUp()
        self.uid = os.getuid()
        self.mux_tmp = Path(tempfile.mkdtemp(prefix="pfm", dir="/tmp")).resolve()
        self.addCleanup(shutil.rmtree, str(self.mux_tmp), True)
        self.other = Path(tempfile.mkdtemp(prefix="pfo", dir="/tmp")).resolve()
        self.addCleanup(shutil.rmtree, str(self.other), True)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.apply_env({}, self.stack)
        self.stack.enter_context(mock.patch.object(fsn, "ACTIVE_AGENT_DIR", None))
        self.stack.enter_context(mock.patch.object(fsn, "_mux_noted", False))
        self.stack.enter_context(mock.patch.object(tempfile, "gettempdir", return_value=str(self.mux_tmp)))
        self.stack.enter_context(mock.patch.object(fsn, "MUX_FALLBACK_DIR", str(self.mux_tmp)))
        self.sock = self.mux_tmp / ("pi-foreman-ssh-%d" % self.uid)

    def enable(self, value=True):
        self.write_config({}, {"sessions": {"machines": PULL_MACHINES, "ssh": {"controlMaster": value}}})

    def test_options_are_present_on_posix(self):
        self.enable()
        opts = fsn.mux_options()
        self.assertEqual(opts, ["-o", "ControlMaster=auto", "-o", "ControlPath=%s/%%C" % self.sock, "-o", "ControlPersist=600"])
        st = os.lstat(self.sock)
        self.assertEqual((st.st_uid, st.st_mode & 0o7777), (self.uid, 0o700))
        self.assertEqual(fsn.mux_options(), opts)  # the second call reuses the directory

    def test_options_reach_every_ssh_call(self):
        self.enable()
        rc, out, err = self.run_main(*self.open_args(parent=STABLE), HERDR_PANE_ID="")
        self.assertEqual(rc, 0, err)
        for call in lines_of(self.logs["ssh"]):
            argv = call["argv"]
            self.assertEqual(argv[:4], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
            self.assertEqual(argv[4:10], ["-o", "ControlMaster=auto", "-o", "ControlPath=%s/%%C" % self.sock, "-o", "ControlPersist=600"])
            self.assertEqual(argv[10], "alpha-host")

    def test_absent_on_win32_and_with_control_master_false(self):
        self.enable()
        with mock.patch.object(fsn, "host_platform", return_value="win32"):
            self.assertEqual(fsn.mux_options(), [])
        self.assertFalse(self.sock.exists())
        self.enable(False)
        self.assertEqual(fsn.mux_options(), [])
        self.assertFalse(self.sock.exists())

    def test_default_config_turns_it_on(self):
        (self.padir / "foreman.json").write_text(json.dumps({"sessions": {"machines": PULL_MACHINES}}), "utf-8")
        self.assertEqual(len(fsn.mux_options()), 6)

    def skipped_once(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(fsn.mux_options(), [])
            self.assertEqual(fsn.mux_options(), [])
        self.assertEqual(err.getvalue().count("ssh connection sharing skipped"), 1)

    def test_a_symlink_is_refused(self):
        self.enable()
        self.sock.symlink_to(self.other, target_is_directory=True)
        self.skipped_once()

    def test_a_wrong_owner_is_refused(self):
        self.enable()
        with mock.patch.object(os, "getuid", return_value=self.uid + 1):  # the directory it makes is not owned by that uid
            self.sock = self.mux_tmp / ("pi-foreman-ssh-%d" % (self.uid + 1))
            self.skipped_once()

    def test_a_wrong_mode_is_refused(self):
        self.enable()
        self.sock.mkdir(mode=0o755)
        self.sock.chmod(0o755)
        self.skipped_once()

    def test_a_too_long_path_is_refused_and_nothing_is_created(self):
        self.enable()
        long_base = str(self.mux_tmp / ("d" * 120))
        with mock.patch.object(tempfile, "gettempdir", return_value=long_base), mock.patch.object(fsn, "MUX_FALLBACK_DIR", long_base):
            self.skipped_once()
        self.assertFalse(Path(long_base).exists())

    def test_the_socket_limit_is_103_on_macos_and_107_elsewhere(self):
        self.enable()
        name = "pi-foreman-ssh-%d" % self.uid
        # a base whose socket path is 105 bytes: too long for macOS, fine elsewhere
        pad = 105 - fsn.MUX_SOCKET_SUFFIX - len(name) - 1 - len(str(self.mux_tmp)) - 1
        base = self.mux_tmp / ("b" * pad)
        base.mkdir()
        with mock.patch.object(tempfile, "gettempdir", return_value=str(base)), \
                mock.patch.object(fsn, "MUX_FALLBACK_DIR", str(self.other)):
            with mock.patch.object(fsn, "host_platform", return_value="linux"):
                self.assertEqual(fsn.mux_dir(), str(base / name))
            with mock.patch.object(fsn, "host_platform", return_value="darwin"):
                self.assertEqual(fsn.mux_dir(), str(self.other / name))  # falls back

    def test_a_long_macos_temp_dir_falls_back_to_tmp(self):
        self.enable()
        deep = self.mux_tmp / ("t" * 60)
        deep.mkdir()
        with mock.patch.object(tempfile, "gettempdir", return_value=str(deep)), \
                mock.patch.object(fsn, "MUX_FALLBACK_DIR", str(self.other)), \
                mock.patch.object(fsn, "host_platform", return_value="darwin"):
            got = fsn.mux_dir()
        self.assertEqual(got, str(self.other / ("pi-foreman-ssh-%d" % self.uid)))
        self.assertFalse((deep / ("pi-foreman-ssh-%d" % self.uid)).exists())


HANG_SSH = r'''
import os, subprocess, sys
sys.stdin.buffer.read()
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(6)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
print('{"ok": true, "entries": []}')
'''


@posix_only
class StderrFileTest(PullBase):
    def test_a_child_holding_stderr_cannot_block_the_verb(self):
        self.script(self.bin / "ssh", HANG_SSH)
        with contextlib.ExitStack() as stack:
            self.apply_env({}, stack)
            stack.enter_context(mock.patch.object(fsn, "ACTIVE_AGENT_DIR", None))
            started = time.monotonic()
            reply = fsn.ssh_verb("alpha", "alpha-host", "foreman", "outbox", {"after": 0}, 20)
        self.assertEqual(reply["ok"], True)
        self.assertLess(time.monotonic() - started, 4)

    def test_stderr_text_still_reaches_the_error(self):
        with contextlib.ExitStack() as stack:
            self.apply_env({"FAKE_SSH_MODE": "255"}, stack)
            stack.enter_context(mock.patch.object(fsn, "ACTIVE_AGENT_DIR", None))
            with self.assertRaises(fsn.Unreachable) as caught:
                fsn.ssh_verb("alpha", "alpha-host", "foreman", "outbox", {}, 20)
        self.assertIn("Connection refused", str(caught.exception))


class PullConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="session_pull_cfg_")).resolve()
        self.addCleanup(shutil.rmtree, str(self.tmp), True)
        self.agent = self.tmp / "agent"
        self.agent.mkdir()
        self.project = self.tmp / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()

    def load(self, project=None, l2=None):
        if l2 is not None:
            (self.agent / "foreman.json").write_text(json.dumps(l2), "utf-8")
        if project is not None:
            (self.project / ".pi" / "foreman.json").write_text(json.dumps(project), "utf-8")
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project), trusted_project=True)

    def issues(self, cfg):
        out = []
        fc.validate_schema(cfg, fc.read_json(fc.SCHEMA_PATH), "", out)
        return out + fc.semantic_issues(cfg)

    def test_defaults(self):
        sessions = self.load()["config"]["sessions"]
        self.assertEqual(sessions["pull"], {"intervalSeconds": 20, "fastSeconds": 5})
        self.assertEqual(sessions["ssh"], {"controlMaster": True})

    def test_the_user_layer_sets_the_keys(self):
        r = self.load(l2={"sessions": {"pull": {"intervalSeconds": 30, "fastSeconds": 3}, "ssh": {"controlMaster": False},
                                       "machines": {"alpha": {"returnPath": "push"}}}})
        sessions = r["config"]["sessions"]
        self.assertEqual((sessions["pull"], sessions["ssh"]), ({"intervalSeconds": 30, "fastSeconds": 3}, {"controlMaster": False}))
        self.assertEqual(sessions["machines"]["alpha"]["returnPath"], "push")

    def test_pull_from_the_project_layer_is_ignored(self):
        r = self.load(project={"sessions": {"pull": {"intervalSeconds": 99}}})
        self.assertEqual(r["config"]["sessions"]["pull"], {"intervalSeconds": 20, "fastSeconds": 5})
        self.assertTrue(any("sessions.pull" in w for w in r["warnings"]), r["warnings"])

    def test_ssh_from_the_project_layer_is_ignored(self):
        r = self.load(project={"sessions": {"ssh": {"controlMaster": False}}})
        self.assertEqual(r["config"]["sessions"]["ssh"], {"controlMaster": True})
        self.assertTrue(any("sessions.ssh" in w for w in r["warnings"]), r["warnings"])

    def test_schema_bounds(self):
        ok = {"sessions": {"machines": {"alpha": {"returnPath": "pull"}, "beta": {"returnPath": "push"}},
                           "pull": {"intervalSeconds": 5, "fastSeconds": 60}, "ssh": {"controlMaster": False}}}
        self.assertEqual(self.issues(ok), [])
        self.assertEqual(self.issues({"sessions": {"pull": {"intervalSeconds": 300, "fastSeconds": 2}}}), [])
        for bad in ({"pull": {"intervalSeconds": 4}}, {"pull": {"intervalSeconds": 301}}, {"pull": {"fastSeconds": 1}},
                    {"pull": {"fastSeconds": 61}}, {"pull": {"intervalSeconds": "20"}}, {"pull": {"other": 1}},
                    {"ssh": {"controlMaster": "yes"}}, {"ssh": {"other": True}},
                    {"machines": {"alpha": {"returnPath": "both"}}}):
            self.assertTrue(self.issues({"sessions": bad}), bad)


@posix_only
class OutboxSkippedCursorTest(PullBase):
    def test_a_trailing_bad_line_is_counted_once(self):
        reply, d = self.pull_open()
        self.write_outbox(d, entry(1), entry(2), "garbage")
        self.assertEqual(self.outbox_call(reply, after=0)[1]["skipped"], 1)
        self.assertEqual(self.outbox_call(reply, after=2)[1]["skipped"], 0)


class PullForwardingTest(PullBase):
    def row(self, **over):
        return dict({"machine": "alpha", "returnPath": "pull", "status": "open", "handoffName": "20260101-000000-x",
                     "parentAddress": STABLE_ADDRESS, "parent": STABLE, "handoff": "h", "last": None, "label": "demo",
                     "child": "fm-demo-000001", "ask": {"n": 2, "topic": "t", "at": "x"}}, **over)

    def test_pull_one_forwards_the_remote_skipped_count(self):
        reply = {"ok": True, "entries": [], "next": 0, "more": False, "skipped": 3, "live": None}
        with mock.patch.object(fsn, "ssh_verb", return_value=reply), mock.patch.object(fsn, "machine_target", return_value="h"):
            got = fsn.pull_one(self.padir, self.row(), {})
        self.assertEqual(got["skipped"], 3)
        del reply["skipped"]
        with mock.patch.object(fsn, "ssh_verb", return_value=reply), mock.patch.object(fsn, "machine_target", return_value="h"):
            self.assertEqual(fsn.pull_one(self.padir, self.row(), {})["skipped"], 0)

    def test_a_ruling_deliver_clears_ask_only_from_the_same_number(self):
        fsn.write_registry(self.padir, {"version": 1, "sessions": [self.row()]})
        files = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, str(files), True)

        def deliver(name):
            (files / name).write_text("r", "utf-8")
            a = argparse.Namespace(text=str(files / name))
            with mock.patch.object(fsn, "ssh_verb", return_value={"bytes": 1, "woke": True}), \
                    mock.patch.object(fsn, "machine_target", return_value="h"):
                self.assertEqual(fsn.remote_brief(a, self.padir, self.row()), 0)
            return fsn.read_registry(self.padir)["sessions"][0]

        self.assertEqual(deliver("ruling-1.md")["ask"]["n"], 2)
        self.assertEqual(deliver("steer-5.md")["ask"]["n"], 2)
        self.assertIsNone(deliver("ruling-2.md")["ask"])


class PullArgvTest(PullBase):
    def test_a_dash_leading_child_id_after_double_dash_is_a_target(self):
        reg = self.padir / "pi-foreman" / "state" / "sessions.json"
        reg.parent.mkdir(parents=True)
        reg.write_text(json.dumps({"version": 1, "sessions": []}), "utf-8")
        rc, out, err = self.run_main("pull", "--json", "--", "-h")
        self.assertEqual(rc, 1)
        self.assertIn("no session with label or child id '-h'", err)


class Item17Test(unittest.TestCase):
    """RemoteOptionTest.test_local_open_with_plan_mode_still_works under a patched win32 platform."""

    def test_the_plan_mode_dry_run_under_win32(self):
        case = rt.RemoteOptionTest("test_local_open_with_plan_mode_still_works")
        # on Windows the fake herdr script is not found (no PATHEXT match), so the dry run prints the PowerShell line
        with mock.patch.object(sys, "platform", "win32"), mock.patch.object(fsn, "herdr_bin", return_value=None):
            result = unittest.TestResult()
            case.run(result)
        self.assertEqual((result.errors, result.failures), ([], []))


if __name__ == "__main__":
    unittest.main()
