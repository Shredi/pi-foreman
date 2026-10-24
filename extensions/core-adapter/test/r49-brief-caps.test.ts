// R49: `/foreman session brief` writes the brief to the child's handoff dir as brief-<n>.md (session.ts writeBrief), and
// that parent-written file lifts the review cap through the existing capsReset (index.ts; no adapter change).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionBrief, writeRegistry } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import { r11Rig } from "./_r11rig.ts";

type Rig = Awaited<ReturnType<typeof r11Rig>>;
type Res = { block?: boolean; reason?: string } | undefined;

const review = (n: number) => ({ agent: "reviewer", task: `review items ${n}` });
const capRefused = (r: Res): boolean => r?.block === true && /\[review_cap\]/.test(r.reason ?? "");

/** A rig whose env has no PI_FOREMAN_HANDOFF_DIR (restored afterwards). */
async function rig(t: Parameters<typeof r11Rig>[0], ceremony: Record<string, unknown> = {}): Promise<Rig> {
  const saved = process.env.PI_FOREMAN_HANDOFF_DIR;
  delete process.env.PI_FOREMAN_HANDOFF_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.PI_FOREMAN_HANDOFF_DIR;
    else process.env.PI_FOREMAN_HANDOFF_DIR = saved;
  });
  return r11Rig(t, ceremony);
}

/** The parent's deps: the registry of the rig's agent dir, the opener's id, and a sender that records each send. */
function briefDeps(a: Rig, sent: [string, string][]): SessionDeps {
  return {
    isChild: false,
    env: { PI_INTERCOM_STABLE_ID: "opener-r49" },
    agentDir: a.agentDir,
    cwd: a.project,
    piSessionId: "sess-r49",
    pkgRoot: "/pkg",
    python: null,
    spawner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    send: async (to, text) => (sent.push([to, text]), "sent"),
  };
}

test("r49: session briefs write brief-1 and brief-2, and the parent's brief-2.md lifts the review cap", async (t) => {
  const a = await rig(t, { reviewRuns: 1 });
  const dir = a.handoff("round", "child");
  writeRegistry(a.agentDir, { version: 1, sessions: [{ label: "demo", child: "fm-demo-r49", status: "open", handoff: dir }] });
  assert.equal((await a.launch(review(1))).res, undefined);
  assert.ok(capRefused((await a.launch(review(2))).res), "capped before the brief");

  const sent: [string, string][] = [];
  const d = briefDeps(a, sent);
  fs.writeFileSync(path.join(a.project, "note.md"), "APPROVED\n");
  assert.equal((await sessionBrief(d, "demo", "go on with B")).ok, true);
  assert.equal((await sessionBrief(d, "demo", "note.md")).ok, true);
  assert.deepEqual(sent, [
    ["fm-demo-r49", `Brief from opener-r49: read ${path.join(dir, "brief-1.md")} and act on it`],
    ["fm-demo-r49", `Brief from opener-r49: read ${path.join(dir, "brief-2.md")} and act on it`],
  ]);
  assert.equal(fs.readFileSync(path.join(dir, "brief-1.md"), "utf8"), "go on with B\n");
  assert.equal(fs.readFileSync(path.join(dir, "brief-2.md"), "utf8"), "APPROVED\n");

  assert.equal((await a.launch(review(2))).res, undefined, "the review cap is lifted");
  assert.deepEqual(a.events("cap_reset").map((r) => r.by), ["brief"]);
  assert.ok(capRefused((await a.launch(review(3))).res), "the counter restarted at zero: one run, then capped again");
});
