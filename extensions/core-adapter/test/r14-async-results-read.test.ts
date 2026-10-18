// R14 item 4 addendum (chair ruling 4): a recorded own async run's results file joins the own-read set for read-only verbs and the python inline read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchLocations } from "../budget.ts";
import { readBaseline } from "../permoverlay.ts";
import { ForemanReview } from "../review.ts";
import type { RegistryLike, ReviewSession } from "../review.ts";
import { asyncResultReads, asyncRunDirs } from "../roundsurface.ts";
import { bashRules } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = bashRules(readBaseline(pkgRoot)!, {});
const posix = process.platform !== "win32";
const inBash = (p: string): string => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r14-async-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const main = path.join(base, "repo");
const uidDir = path.join(base, "pi-subagents-uid-501");
fs.mkdirSync(path.join(main, ".git"), { recursive: true });
const reg: RegistryLike = { find: () => { throw new Error("model called"); }, complete: async () => ({}) };
const session = (extra: Partial<ReviewSession>): ReviewSession => ({ isChild: false, cwd: main, provider: "a", config: () => ({}), registry: reg, intent: "", bashRules: () => rules, ...extra });
const ask = (r: ForemanReview, value: string) => r.authorize("s", { requestId: "r", surface: "bash", agentName: "foreman", value, toolName: "bash" });
const LAUNCH = "Async: builder [abc123]\n\nThe async run is detached and running in the background.";
const res = (run: string) => inBash(path.join(uidDir, "async-subagent-results", `${run}.json`));
const PY = (p: string) => `python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(str(d.get('output') or d.get('results') or d)[-5000:])" ${p}; git log --oneline -8`;

const owned = (text: string) => {
  const files = launchLocations(text, undefined, uidDir);
  return session({ readOnlyRoots: () => [...files, ...asyncRunDirs(files, "linux")], ownReads: () => asyncResultReads(files, "linux") });
};

test("async results json, before: an unrecorded run's python read asks", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", session({ readOnlyRoots: () => [] }));
  assert.notEqual((await ask(r, PY(res("abc123")))).kind, "allow");
});

test("async results json, after: the recorded own run's python read line and cat pass", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", owned(LAUNCH));
  assert.deepEqual(await ask(r, PY(res("abc123"))), { kind: "allow" });
  assert.deepEqual(await ask(r, `cat ${res("abc123")}`), { kind: "allow" });
});

test("async results json: output-archives/<run>.json of the recorded run passes, another run id still asks", { skip: !posix }, async () => {
  const r = new ForemanReview();
  r.upsert("s", owned(LAUNCH));
  const arch = inBash(path.join(uidDir, "async-subagent-results", "output-archives", "abc123.json"));
  assert.deepEqual(await ask(r, `cat ${arch}`), { kind: "allow" });
  assert.notEqual((await ask(r, PY(res("other")))).kind, "allow");
  assert.notEqual((await ask(r, `cat ${inBash(path.join(uidDir, "async-subagent-results", "output-archives", "other.json"))}`)).kind, "allow");
});
