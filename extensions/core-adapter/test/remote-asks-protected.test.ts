// remote-asks: the protected host match for a program the gate does not model (D10), the tolerant verdict parse and the retry (D5), the model-mode remote write (E1). Neutral fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { effectCtx } from "../effects.ts";
import { matchProtected } from "../protected.ts";
import type { ProtectedMatch } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import { parseShell } from "../shellast.ts";
import type { RuleCall } from "../rulecall.ts";
import { extractVerdictBlock, parseJudgeVerdict, retryRequestText } from "../classifier.ts";
import { posixOnly } from "./_platform.ts";

const cwd = process.cwd();
const env = { home: path.join(cwd, "pf-ra", "home"), platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entries: ProtectedEntry[] = [{ id: "P1", kind: "host", glob: "prod-*.example.net", source: "user" }];
const sh = (line: string): ProtectedMatch | null => {
  const segments = parseShell(line, { cwd });
  return matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
};

test("an unmodelled runner that names a protected host as a whole word matches; a read line and a word that only contains the host do not", { skip: posixOnly }, () => {
  assert.ok(sh("rt exec --on prod-1.example.net -- ls /work/repo"), "host as an option value word");
  assert.ok(sh("rt exec --on=prod-1.example.net -- ls /work/repo"), "host after the first =");
  assert.equal(sh("rt exec --on host-a -- ls /work/repo"), null);
  assert.equal(sh("rt exec --on xprod-1.example.net.evil -- ls"), null);
  assert.equal(sh("echo prod-1.example.net"), null, "a read line names the host and does not match");
});

const CLEAR = '{"verdict":"clear","reason":"reads"}';

test("the verdict is read after prose; two verdicts, text after the block and no JSON stay errors", () => {
  assert.ok(!("error" in parseJudgeVerdict(`I looked at it.\n${CLEAR}`)));
  assert.ok("error" in parseJudgeVerdict(`${CLEAR}\nthanks`));
  assert.ok("error" in parseJudgeVerdict(`${CLEAR}\n${CLEAR}`));
  assert.ok("error" in parseJudgeVerdict("I would say clear."));
  const r = extractVerdictBlock(`an unbalanced { in prose\n${CLEAR}`, () => true);
  assert.ok("block" in r && r.block === CLEAR);
});

test("the retry request holds the request, the problem and the answer shape in one message", () => {
  const t = retryRequestText("REQUEST", "reply is not JSON", "SHAPE");
  assert.ok(t.startsWith("REQUEST"));
  assert.match(t, /Problem: reply is not JSON/);
  assert.match(t, /SHAPE/);
  assert.match(t, /no text before or after it/);
});
