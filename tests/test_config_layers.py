"""Project and session layers cannot loosen non-safety keys; invalid layer values drop alone
(security review S3, S4, S5)."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import foreman_config as fc  # noqa: E402


class LayerRulesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(os.path.realpath(self.tmp.name))
        self.agent = root / "agent"
        self.agent.mkdir()
        self.project = root / "proj"
        (self.project / ".pi").mkdir(parents=True)
        (self.project / ".git").mkdir()
        self.outside = root / "outside"
        self.outside.mkdir()

    def write(self, path, data):
        path.write_text(json.dumps(data))

    def load(self, proj=None, session=None, l2=None, l3=None):
        if l2 is not None:
            self.write(self.agent / "foreman.json", l2)
        if proj is not None:
            self.write(self.project / ".pi" / "foreman.json", proj)
        l3_paths = []
        if l3 is not None:
            self.write(Path(self.tmp.name) / "l3.json", l3)
            l3_paths = [str(Path(self.tmp.name) / "l3.json")]
        return fc.load_config(agent_dir=str(self.agent), project_dir=str(self.project),
                              trusted_project=True, l3_paths=l3_paths,
                              session_json=json.dumps(session) if session is not None else None)

    def test_python_path_only_from_l1_l3_l2(self):
        res = self.load(l2={"python": {"path": "/opt/py/bin/python3"}},
                        proj={"python": {"path": "/tmp/evil"}})
        self.assertEqual(res["config"]["python"]["path"], "/opt/py/bin/python3")
        self.assertIn("project python.path ignored", "\n".join(res["warnings"]))
        res = self.load(session={"python": {"path": "/tmp/evil"}})
        self.assertEqual(res["config"]["python"]["path"], "/opt/py/bin/python3")
        self.assertIn("session python.path ignored", "\n".join(res["warnings"]))

    def test_roles_narrow_only_and_no_new_ids(self):
        res = self.load(proj={"roles": {
            "explorer": {"tools": ["read", "edit", "write"], "launch": "detached"},
            "intruder": {"tools": ["bash", "edit"]}}},
            session={"roles": {"reviewer": {"tools": ["read", "foreman_move"]}}})
        roles = res["config"]["roles"]
        self.assertEqual(roles["explorer"]["tools"], ["read"])
        self.assertEqual(roles["reviewer"]["tools"], ["read"])
        self.assertNotIn("intruder", roles)
        joined = "\n".join(res["warnings"])
        for key in ("roles.explorer.tools: entries not extended: edit, write", "roles.intruder ignored",
                    "roles.explorer.launch ignored", "roles.reviewer.tools: entries not extended: foreman_move"):
            self.assertIn(key, joined)

    def test_role_file_ignored_prompt_append_kept(self):
        res = self.load(l2={"roles": {"builder": {"file": "/opt/roles/builder.md"}}},
                        proj={"roles": {"builder": {"file": "evil.md", "promptAppend": "repo note"}}},
                        session={"roles": {"explorer": {"file": "evil2.md"}}})
        roles = res["config"]["roles"]
        self.assertEqual(roles["builder"]["file"], "/opt/roles/builder.md")
        self.assertEqual(roles["builder"]["promptAppend"], "repo note")
        self.assertNotIn("file", roles["explorer"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.file ignored", joined)
        self.assertIn("session roles.explorer.file ignored", joined)

    def test_codemode_only_switched_off(self):
        res = self.load(l2={"providers": {"p1": {"roles": {"builder": {"model": "p1/b"},
                                                           "explorer": {"model": "p1/e", "codemode": True}}}}},
                        proj={"roles": {"builder": {"codemode": True}, "explorer": {"codemode": False}},
                              "providers": {"p1": {"roles": {"builder": {"codemode": True},
                                                             "explorer": {"codemode": False}}}}})
        cfg = res["config"]
        self.assertIs(cfg["roles"]["builder"]["codemode"], False)
        self.assertIs(cfg["roles"]["explorer"]["codemode"], False)
        self.assertNotIn("codemode", cfg["providers"]["p1"]["roles"]["builder"])
        self.assertIs(cfg["providers"]["p1"]["roles"]["explorer"]["codemode"], False)
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.codemode ignored", joined)
        self.assertIn("project providers.p1.roles.builder.codemode ignored", joined)

    def test_provider_roles_for_unknown_ids_ignored(self):
        res = self.load(proj={"providers": {"p1": {"roles": {"intruder": {"model": "p1/x"},
                                                             "builder": {"model": "p1/b"}}}}})
        proles = res["config"]["providers"]["p1"]["roles"]
        self.assertEqual(set(proles), {"builder"})
        self.assertIn("project providers.p1.roles.intruder ignored", "\n".join(res["warnings"]))

    def test_project_still_picks_models_and_fallback(self):
        res = self.load(proj={"providers": {"p1": {"roles": {"builder": {"model": "p1/b"}},
                                                   "fallback": {"provider": "p2"}}}})
        p1 = res["config"]["providers"]["p1"]
        self.assertEqual(p1["roles"]["builder"]["model"], "p1/b")
        self.assertEqual(p1["fallback"], {"provider": "p2"})
        self.assertEqual(res["errors"], [])

    def test_invalid_project_value_keeps_lower_tightening(self):
        res = self.load(l3={"safety": {"permissions": {"deny": ["curl *"]}}},
                        l2={"safety": {"git": {"protectedBranches": ["release"]}}},
                        proj={"safety": {"children": {"mayPush": "no"},
                                         "permissions": {"deny": ["wget *", 7]}}})
        s = res["config"]["safety"]
        self.assertFalse(res["safetyFallback"])
        self.assertEqual(s["permissions"]["deny"], ["curl *", "wget *"])
        self.assertEqual(s["git"]["protectedBranches"], ["release"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project invalid safety value dropped: safety.children.mayPush", joined)
        self.assertIn("project invalid safety value dropped: safety.permissions.deny[1]", joined)

    def test_trace_dir_must_stay_in_workspace(self):
        res = self.load(proj={"trace": {"dir": "logs/trace"}})
        self.assertEqual(res["config"]["trace"]["dir"], "logs/trace")
        values = [str(self.outside), "../outside"]
        try:
            os.symlink(str(self.outside), str(self.project / "escape"), target_is_directory=True)
            values.append("escape/x")
        except OSError:  # Windows without symlink rights
            pass
        for value in values:
            res = self.load(proj={"trace": {"dir": value}})
            self.assertIsNone(res["config"]["trace"]["dir"], value)
            self.assertIn("project trace.dir ignored", "\n".join(res["warnings"]))

    def test_trace_dir_not_in_git_or_pi(self):
        for value in [".git/hooks", ".pi", "sub/.GIT/x", ".pi/agents"]:
            res = self.load(proj={"trace": {"dir": value}})
            self.assertIsNone(res["config"]["trace"]["dir"], value)
            self.assertIn("must not be inside a .git or .pi directory", "\n".join(res["warnings"]))

    def test_strong_model_only_from_l1_l3_l2(self):
        l2 = {"providers": {"p1": {"roles": {"builder": {"model": "p1/b", "strong": {"model": "p1/big"}}}}}}
        res = self.load(l2=l2, proj={"providers": {"p1": {"roles": {"builder": {"strong": {"model": "p1/x"}}}}}},
                        session={"providers": {"p1": {"roles": {"builder": {"strong": {"model": "p1/y"}}}}}})
        self.assertEqual(res["config"]["providers"]["p1"]["roles"]["builder"]["strong"], {"model": "p1/big"})
        joined = "\n".join(res["warnings"])
        self.assertIn("project providers.p1.roles.builder.strong ignored", joined)
        self.assertIn("session providers.p1.roles.builder.strong ignored", joined)

    def test_strong_on_revision_false_only(self):
        res = self.load(proj={"providers": {"p1": {"strongOnRevision": True}}})
        self.assertNotIn("strongOnRevision", res["config"]["providers"]["p1"])
        self.assertIn("project providers.p1.strongOnRevision ignored: it would loosen", "\n".join(res["warnings"]))
        res = self.load(l2={"providers": {"p1": {"strongOnRevision": True}}},
                        proj={"providers": {"p1": {"strongOnRevision": False}}})
        self.assertIs(res["config"]["providers"]["p1"]["strongOnRevision"], False)
        res = self.load(l2={}, proj={}, session={"providers": {"p1": {"strongOnRevision": True}}})
        self.assertNotIn("strongOnRevision", res["config"]["providers"]["p1"])
        self.assertIn("session providers.p1.strongOnRevision ignored", "\n".join(res["warnings"]))

    def test_revision_rounds_lower_only(self):
        res = self.load(proj={"ceremony": {"revisionRounds": {"standard": 3, "heavy": 1}}},
                        session={"ceremony": {"revisionRounds": {"heavy": 4}}})
        self.assertEqual(res["config"]["ceremony"]["revisionRounds"], {"standard": 1, "heavy": 1})
        joined = "\n".join(res["warnings"])
        self.assertIn("project ceremony.revisionRounds.standard ignored: it would loosen", joined)
        self.assertIn("session ceremony.revisionRounds.heavy ignored: it would loosen", joined)
        res = self.load(l2={"ceremony": {"revisionRounds": {"heavy": 5}}}, proj={}, session={})
        self.assertEqual(res["config"]["ceremony"]["revisionRounds"], {"standard": 1, "heavy": 5})

    def test_timeout_minutes_lower_only(self):
        res = self.load(l2={"roles": {"builder": {"timeoutMinutes": 90}}},
                        proj={"roles": {"builder": {"timeoutMinutes": 120}, "explorer": {"timeoutMinutes": 10}}},
                        session={"roles": {"reviewer": {"timeoutMinutes": 31}}})
        roles = res["config"]["roles"]
        self.assertEqual((roles["builder"]["timeoutMinutes"], roles["explorer"]["timeoutMinutes"],
                          roles["reviewer"]["timeoutMinutes"]), (90, 10, 30))
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.timeoutMinutes ignored: it would loosen", joined)
        self.assertIn("session roles.reviewer.timeoutMinutes ignored: it would loosen", joined)

    def test_lower_only_below_minimum_is_dropped_with_a_warning(self):
        res = self.load(proj={"roles": {"builder": {"timeoutMinutes": 0}}},
                        session={"ceremony": {"revisionRounds": {"standard": -1}}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["roles"]["builder"]["timeoutMinutes"], 60)
        self.assertEqual(res["config"]["ceremony"]["revisionRounds"]["standard"], 1)
        joined = "\n".join(res["warnings"])
        self.assertIn("project roles.builder.timeoutMinutes ignored: below the minimum 1", joined)
        self.assertIn("session ceremony.revisionRounds.standard ignored: below the minimum 0", joined)

    def test_require_triage_true_only(self):
        res = self.load(proj={"ceremony": {"requireTriage": False}}, session={"ceremony": {"requireTriage": False}})
        self.assertIs(res["config"]["ceremony"]["requireTriage"], True)
        self.assertIn("project ceremony.requireTriage ignored", "\n".join(res["warnings"]))
        res = self.load(l2={"ceremony": {"requireTriage": False}}, proj={"ceremony": {"requireTriage": True}}, session={})
        self.assertIs(res["config"]["ceremony"]["requireTriage"], True)
        res = self.load(l2={"ceremony": {"requireTriage": False}}, proj={}, session={})
        self.assertIs(res["config"]["ceremony"]["requireTriage"], False)

    def test_phase4_keys_follow_their_layer_rules(self):
        res = self.load(proj={"wait": {"maxActive": 20, "maxSeconds": 100, "ci": True, "batchWindowSeconds": 10},
                              "compaction": {"priceTiers": {"cheap": 9}, "threshold": {"cheap": 0.9, "standard": 0.1, "premium": 0.5}},
                              "sync": {"repos": [], "runRetro": False}, "retro": {"proposalMinReviews": 1},
                              "intercom": {"allowRemote": True}, "close": {"from": ["herdr", "other"]}},
                        session={"intercom": {"allowOpenPane": True}})
        cfg, joined = res["config"], "\n".join(res["warnings"])
        self.assertEqual((cfg["wait"]["maxActive"], cfg["wait"]["maxSeconds"], cfg["wait"]["batchWindowSeconds"]), (8, 100, 10))
        self.assertEqual(cfg["compaction"]["threshold"], {"cheap": 0.85, "standard": 0.75, "premium": 0.5})
        self.assertEqual(cfg["compaction"]["priceTiers"], {"cheap": 1, "standard": 5})
        self.assertEqual((cfg["retro"]["proposalMinReviews"], cfg["sync"]["runRetro"]), (5, False))
        self.assertIs(cfg["intercom"]["allowRemote"], False)
        self.assertIs(cfg["intercom"]["allowOpenPane"], False)
        self.assertEqual(cfg["close"]["from"], ["herdr"])
        self.assertIn("project wait.maxActive ignored: it would loosen", joined)
        self.assertIn("project compaction.threshold.standard ignored: below the minimum 0.3", joined)
        self.assertIn("project compaction.priceTiers ignored: the project may not set this key", joined)
        self.assertIn("project retro.proposalMinReviews ignored", joined)
        self.assertIn("project intercom.allowRemote ignored", joined)
        self.assertIn("project close.from: entries not extended: other", joined)

    def test_ceremony_escalation_keys_tighten_only(self):
        # MINOR-7: signals union only, file count lower only (>= 1), default raise only, wrong types dropped.
        res = self.load(proj={"ceremony": {"heavySignals": ["schema"], "heavyFileCount": 50, "default": "trivial"}},
                        session={"ceremony": {"heavyFileCount": 0, "revisionRounds": None}})
        cer = res["config"]["ceremony"]
        self.assertEqual(res["errors"], [])
        self.assertEqual(cer["heavySignals"][-1], "schema")
        self.assertIn("delete", cer["heavySignals"])
        self.assertEqual((cer["heavyFileCount"], cer["default"]), (8, "standard"))
        self.assertEqual(cer["revisionRounds"], {"standard": 1, "heavy": 2})
        joined = "\n".join(res["warnings"])
        self.assertIn("project ceremony.heavySignals: entries not removed: delete", joined)
        self.assertIn("project ceremony.heavyFileCount ignored: it would loosen", joined)
        self.assertIn("project ceremony.default ignored: it would lower the tier", joined)
        self.assertIn("session ceremony.heavyFileCount ignored: below the minimum 1", joined)
        self.assertIn("session ceremony.revisionRounds ignored: not an object", joined)
        res = self.load(proj={"ceremony": None}, session={"ceremony": {"heavyFileCount": 3, "default": "heavy"}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(len(res["config"]["ceremony"]["heavySignals"]), 7)
        self.assertEqual((res["config"]["ceremony"]["heavyFileCount"], res["config"]["ceremony"]["default"]), (3, "heavy"))
        self.assertIn("project ceremony ignored: not an object", "\n".join(res["warnings"]))

    def test_trivial_bound_lower_only(self):
        res = self.load(proj={"ceremony": {"trivialBound": {"files": 5, "lines": 10}}},
                        session={"ceremony": {"trivialBound": {"newFiles": 1, "files": -1}}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["ceremony"]["trivialBound"], {"files": 2, "lines": 10, "newFiles": 0})
        joined = "\n".join(res["warnings"])
        self.assertIn("project ceremony.trivialBound.files ignored: it would loosen", joined)
        self.assertIn("session ceremony.trivialBound.newFiles ignored: it would loosen", joined)
        self.assertIn("session ceremony.trivialBound.files ignored: below the minimum 0", joined)
        res = self.load(l2={"ceremony": {"trivialBound": {"files": 9}}}, proj={"ceremony": {"trivialBound": 3}}, session={})
        self.assertEqual(res["config"]["ceremony"]["trivialBound"]["files"], 9)
        self.assertIn("project ceremony.trivialBound ignored: not an object", "\n".join(res["warnings"]))

    def test_frugality_keys_tighten_only(self):
        res = self.load(proj={"ceremony": {"foremanReads": {"before": {"warn": 9, "deny": 5}}, "recheckBudget": 9,
                                            "launchWait": "detach", "dedupeNotify": False}},
                        session={"ceremony": {"foremanReads": {"after": {"warn": 0}}, "recheckBudget": 0}})
        c = res["config"]["ceremony"]
        self.assertEqual(res["errors"], [])
        self.assertEqual(c["foremanReads"], {"before": {"warn": 6, "deny": 5}, "after": {"warn": 4, "deny": 8}})
        self.assertEqual((c["recheckBudget"], c["launchWait"], c["dedupeNotify"]), (0, "block", True))
        joined = "\n".join(res["warnings"])
        self.assertIn("project ceremony.foremanReads.before.warn ignored: it would loosen", joined)
        self.assertIn("session ceremony.foremanReads.after.warn ignored: below the minimum 1", joined)
        self.assertIn("project ceremony.recheckBudget ignored: it would loosen", joined)
        self.assertIn("project ceremony.launchWait ignored: it would loosen", joined)
        self.assertIn("project ceremony.dedupeNotify ignored: it would loosen", joined)
        res = self.load(l2={"ceremony": {"launchWait": "detach"}}, proj={"ceremony": {"launchWait": "block"}}, session={})
        self.assertEqual(res["config"]["ceremony"]["launchWait"], "block")

    def test_non_object_foreman_reads_dropped(self):
        strict = {"before": {"warn": 2, "deny": 3}, "after": {"warn": 4, "deny": 8}}
        for proj in ["x", None, {"before": "x"}, {"before": None}]:
            res = self.load(l2={"ceremony": {"foremanReads": {"before": {"warn": 2, "deny": 3}}}},
                            proj={"ceremony": {"foremanReads": proj}}, session={})
            self.assertEqual(res["config"]["ceremony"]["foremanReads"], strict, proj)
            self.assertEqual(res["errors"], [], proj)
            self.assertIn("ignored: not an object", "\n".join(res["warnings"]), proj)

    def test_foreman_edits_ordered_tighten_only(self):
        res = self.load(proj={"ceremony": {"foremanEdits": "bounded"}}, session={})
        self.assertEqual(res["config"]["ceremony"]["foremanEdits"], "scratchpad")
        self.assertIn("project ceremony.foremanEdits ignored: it would loosen", "\n".join(res["warnings"]))
        res = self.load(proj={"ceremony": {"foremanEdits": "readonly"}}, session={"ceremony": {"foremanEdits": "scratchpad"}})
        self.assertEqual(res["config"]["ceremony"]["foremanEdits"], "readonly")
        self.assertIn("session ceremony.foremanEdits ignored: it would loosen", "\n".join(res["warnings"]))
        res = self.load(l2={"ceremony": {"foremanEdits": "bounded"}}, proj={"ceremony": {"foremanEdits": "free"}}, session={})
        self.assertEqual(res["config"]["ceremony"]["foremanEdits"], "scratchpad")
        self.assertIn("project ceremony.foremanEdits 'free' invalid: not one of readonly, scratchpad, bounded", "\n".join(res["errors"]))

    def test_malformed_user_layer_cannot_let_project_loosen(self):
        for value in ["free", "READONLY", 5]:
            res = self.load(l2={"ceremony": {"foremanEdits": value, "scratchDir": 5}},
                            proj={"ceremony": {"foremanEdits": "bounded", "scratchDir": "src"}},
                            session={"ceremony": {"foremanEdits": "bounded"}})
            self.assertEqual(res["config"]["ceremony"]["foremanEdits"], "scratchpad", value)
            self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch", value)
            errors = "\n".join(res["errors"])
            self.assertIn("L2 ceremony.foremanEdits", errors)
            self.assertIn("L2 ceremony.scratchDir 5 invalid", errors)

    def test_review_before_pr_true_only(self):
        res = self.load(proj={"ceremony": {"reviewBeforePr": False}}, session={"ceremony": {"reviewBeforePr": False}})
        self.assertIs(res["config"]["ceremony"]["reviewBeforePr"], True)
        self.assertIn("session ceremony.reviewBeforePr ignored", "\n".join(res["warnings"]))
        res = self.load(l2={"ceremony": {"reviewBeforePr": False}}, proj={}, session={})
        self.assertIs(res["config"]["ceremony"]["reviewBeforePr"], False)

    def test_scratch_dir_narrow_only(self):
        res = self.load(proj={"ceremony": {"scratchDir": ".workflow/scratch/notes"}}, session={"ceremony": {"scratchDir": ".workflow"}})
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch/notes")
        self.assertIn("session ceremony.scratchDir ignored: it may only narrow", "\n".join(res["warnings"]))
        res = self.load(proj={"ceremony": {"scratchDir": "src"}}, session={})
        self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch")
        self.assertIn("project ceremony.scratchDir ignored", "\n".join(res["warnings"]))
        for value in ["../x", "/tmp/x", ".", 5]:
            res = self.load(proj={"ceremony": {"scratchDir": value}}, session={})
            self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch", value)
            self.assertIn("project ceremony.scratchDir", "\n".join(res["errors"]))
        res = self.load(l2={"ceremony": {"scratchDir": "notes"}}, proj={}, session={})
        self.assertEqual(res["config"]["ceremony"]["scratchDir"], "notes")

    def test_scratch_dir_must_stay_in_workspace(self):
        values = ["../outside", str(self.outside), "./", "a/../.."]
        try:
            os.symlink(str(self.outside), str(self.project / "escape"), target_is_directory=True)
            values.append("escape/x")
        except OSError:  # Windows without symlink rights
            pass
        for value in values:
            res = self.load(l2={"ceremony": {"scratchDir": value}}, proj={}, session={})
            self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch", value)
            self.assertIn("ceremony.scratchDir", "\n".join(res["errors"]), value)

    def test_scratch_dir_through_symlink_is_config_error(self):
        (self.project / "src").mkdir()
        (self.project / ".workflow").mkdir()
        try:
            os.symlink(os.path.join("..", "src"), str(self.project / ".workflow" / "scratch"), target_is_directory=True)
        except OSError:  # Windows without symlink rights
            self.skipTest("no symlink rights")
        res = self.load(l2={"ceremony": {"scratchDir": ".workflow/scratch/x"}}, proj={}, session={})
        self.assertEqual(res["config"]["ceremony"]["scratchDir"], ".workflow/scratch")
        self.assertIn("must not pass through a symlink", "\n".join(res["errors"]))

    def test_required_steps_add_only(self):
        res = self.load(proj={"ceremony": {"required": {"standard": ["reviewer", "finalizer"], "heavy": ["deployer"]}}},
                        session={"ceremony": {"required": {"standard": []}}})
        self.assertEqual(res["errors"], [])
        req = res["config"]["ceremony"]["required"]
        self.assertEqual(req["standard"], ["builder", "reviewer", "finalizer"])
        self.assertEqual(req["heavy"], ["planner", "builder", "reviewer", "finalizer"])
        joined = "\n".join(res["warnings"])
        self.assertIn("project ceremony.required.standard: entries not removed: builder", joined)
        self.assertIn("project ceremony.required.heavy: unknown steps dropped: deployer", joined)
        self.assertIn("session ceremony.required.standard: entries not removed: builder, reviewer, finalizer", joined)
        res = self.load(l2={"ceremony": {"required": {"standard": []}}}, proj={"ceremony": {"required": None}}, session={})
        self.assertEqual(res["config"]["ceremony"]["required"]["standard"], [])
        self.assertIn("project ceremony.required ignored: not an object", "\n".join(res["warnings"]))

    def test_pin_role_model_settable_review_ignored(self):
        res = self.load(session={"providers": {"p1": {"roles": {"builder": {"model": "p1/s"}},
                                                      "review": {"model": "p1/r"}}}})
        p1 = res["config"]["providers"]["p1"]
        self.assertEqual(p1["roles"]["builder"]["model"], "p1/s")
        self.assertNotIn("review", p1)
        self.assertIn("session providers.p1.review ignored", "\n".join(res["warnings"]))


if __name__ == "__main__":
    unittest.main()
