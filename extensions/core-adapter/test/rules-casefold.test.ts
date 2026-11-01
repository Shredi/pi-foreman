// r79 revision (I): user deny/ask/allow path rules fold case on darwin and win32 like the floors (pathnorm comparableFs); linux compares as spelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRules, parseRule } from "../rules.ts";
import type { RuleCall, RuleSets } from "../rules.ts";

const rule = (t: string) => {
  const r = parseRule(t);
  if ("error" in r) throw new Error(r.error);
  return r.rule;
};
const sets = (o: { allow?: string[]; deny?: string[] }): RuleSets => ({ allow: (o.allow ?? []).map(rule), ask: [], deny: (o.deny ?? []).map(rule) });
const read = (p: string): RuleCall => ({ tool: "read", paths: [p] });
const env = (platform: string) => ({ cwd: "/co/wt", home: "/Users/me", platform, checkout: "/co" });

test("a deny path rule matches another spelling of the case on darwin and win32, not on linux", () => {
  const s = sets({ deny: ["Read(~/Secrets/**)"] });
  assert.equal(matchRules(s, read("/Users/me/secrets/a.txt"), env("darwin")).verdict, "deny");
  assert.equal(matchRules(s, read("/users/ME/SECRETS/a.txt"), env("darwin")).verdict, "deny");
  assert.equal(matchRules(s, read("/Users/me/secrets/a.txt"), env("linux")).verdict, "none");
  assert.equal(matchRules(s, read("/Users/me/Secrets/a.txt"), env("linux")).verdict, "deny");
});

test("an allow path rule folds the same way (and still does not widen to a sibling name)", () => {
  const s = sets({ allow: ["Read(~/Notes/**)"] });
  assert.equal(matchRules(s, read("/Users/me/notes/a.md"), env("darwin")).verdict, "allow");
  assert.equal(matchRules(s, read("/Users/me/notes2/a.md"), env("darwin")).verdict, "none");
});
