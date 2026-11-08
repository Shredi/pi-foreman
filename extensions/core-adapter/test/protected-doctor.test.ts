// Plan D7: the doctor suggests a protected entry for an ask rule that names a host or path fragment (INFO only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { protectHintLines } from "../permconfig.ts";
import { parseRule } from "../rules.ts";

const ask = (text: string) => {
  const p = parseRule(text);
  if (!p.ok) throw new Error(text);
  return { kind: "ask" as const, rule: p.rule, source: "user" };
};

test("doctor: a Bash(*host*) ask rule gets an INFO hint; plain words, other tools and covered fragments do not", () => {
  const lines = protectHintLines({ entries: [ask("Bash(*prod-1.example.net*)"), ask("Bash(*sudo*)"), ask("Bash(git push*)"), ask("Read(*secret.example*)"), ask("Bash(*stage.example.org*)")], protected: [{ id: "P1", kind: "host", glob: "stage.example.org", source: "user" }] as never });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^INFO Bash\(\*prod-1\.example\.net\*\) .*protected entry/);
});
