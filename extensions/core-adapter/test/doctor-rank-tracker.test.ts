// /foreman doctor: the rank line (a role's normal model the foreman model cannot launch) and the PR tracker line (age of the last poll, no host call).
// The conditions are tested on the pure functions (rankDoctorFindings, lastPollAgeMs, trackerDoctorLine); three rigs prove the wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { rankDoctorFindings } from "../ranks.ts";
import { lastPollAgeMs, trackedStateFile, trackerDoctorLine } from "../prstore.ts";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

const PRESETS = ["claude-bridge", "claude-bridge-sonnet-reviewer"] as const;
const PRESET = (name: string): Record<string, any> => JSON.parse(fs.readFileSync(new URL(`../../../config/presets/${name}.json`, import.meta.url), "utf8"));
const FOREMEN = { opus: "claude-bridge/claude-opus-5-5", sonnet: "claude-bridge/claude-sonnet-5-5", haiku: "claude-bridge/claude-haiku-5-5" };
const SONNET = "claude-bridge/claude-sonnet-5-5";
const FIX = "run the foreman on a model ranked above it, or map the role to a lower-ranked model";

const findings = (config: Record<string, any>, foreman: string | null, provider = "claude-bridge") => rankDoctorFindings(config, foreman, config.providers[provider].roles);

for (const preset of PRESETS) {
  test(`${preset}: Opus foreman no finding; Sonnet explorer and builder, the reviewer passes; Haiku three findings, the reviewer with 'at or above'`, () => {
    const config = PRESET(preset);
    assert.deepEqual(findings(config, FOREMEN.opus), []);
    assert.deepEqual(findings(config, FOREMEN.sonnet), [
      { message: `explorer's normal model ${SONNET} is not launchable under the foreman model ${FOREMEN.sonnet} (rank policy below)`, fix: FIX },
      { message: `builder's normal model ${SONNET} is not launchable under the foreman model ${FOREMEN.sonnet} (rank policy below)`, fix: FIX },
    ]);
    const lines = findings(config, FOREMEN.haiku);
    assert.equal(lines.length, 3);
    assert.ok(lines[0].message.startsWith("explorer's") && lines[0].fix.includes("ranked above it"));
    assert.ok(lines[1].message.startsWith("builder's") && lines[1].fix.includes("ranked above it"));
    assert.ok(lines[2].message.startsWith("reviewer's") && lines[2].message.endsWith("(rank policy at-or-below)") && lines[2].fix.startsWith("run the foreman on a model ranked at or above it"));
  });
}

const fakeCfg = (extra: Record<string, unknown> = {}, ranks: unknown[] = [{ match: "foreman", tier: 1 }, { match: "*", tier: 3 }]): Record<string, any> => ({
  providers: { fake: { roles: { explorer: { model: "fake/explorer" }, builder: { model: "fake/builder" }, reviewer: { model: "fake/reviewer" } }, ranks } },
  ...extra,
});
const UNRANKED = "add a ranks entry for it";

test("no ranks: no finding", () => {
  assert.deepEqual(findings(fakeCfg({}, []), "fake/foreman", "fake"), []);
});

test("policy any for every role: no finding", () => {
  assert.deepEqual(findings(fakeCfg({ ladder: { childPolicy: "any" } }, [{ match: "foreman", tier: 1 }, { match: "*", tier: 1 }]), "fake/foreman", "fake"), []);
});

test("no foreman model: no finding", () => {
  assert.deepEqual(findings(fakeCfg({}, [{ match: "*", tier: 1 }]), null, "fake"), []);
});

test("a role's normal model in no ranks list: the ranks-entry finding for that role", () => {
  const config = fakeCfg({}, [{ match: "foreman", tier: 1 }, { match: "explorer", tier: 3 }, { match: "reviewer", tier: 3 }]);
  assert.deepEqual(findings(config, "fake/foreman", "fake"), [{ message: "builder's normal model fake/builder cannot be rank-checked: fake/builder is in no providers.<p>.ranks list", fix: UNRANKED }]);
});

test("the foreman's model in no ranks list: the ranks-entry finding naming the foreman model", () => {
  const config = fakeCfg({}, [{ match: "explorer", tier: 3 }, { match: "builder", tier: 3 }, { match: "reviewer", tier: 3 }]);
  assert.deepEqual(findings(config, "fake/foreman", "fake"), ["explorer", "builder", "reviewer"].map((r) => ({ message: `${r}'s normal model fake/${r} cannot be rank-checked: fake/foreman is in no providers.<p>.ranks list`, fix: UNRANKED })));
});

// the tracker line
const NOW = 1_700_000_000_000;
const DOWN = "WARN no PR tracker running: PR watches get no reports and pr_create opens no draft; herdr-app belongs to the pi-foreman setup (without it not the whole feature set) — fix: run herdr-app, or foreman prs poll on a timer";
const writeState = (agentDir: string, body: Record<string, unknown>): void => {
  const file = trackedStateFile(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
};

test("tracker live: OK with the age of the last poll", (t) => {
  const dir = mkTestTmp("pf-doctor-tracker-");
  t.after(() => rmTestTmp(dir));
  writeState(dir, { v: 1, trackedAt: NOW - 12_000, prs: {} });
  const age = lastPollAgeMs(dir, NOW);
  assert.equal(age, 12_000);
  assert.equal(trackerDoctorLine(true, undefined, age), "OK   PR tracker: last poll 12s ago");
});

test("tracker down: no state file, a poll older than 10 minutes, a state marked off", (t) => {
  const dir = mkTestTmp("pf-doctor-tracker-");
  t.after(() => rmTestTmp(dir));
  assert.equal(lastPollAgeMs(dir, NOW), null);
  assert.equal(trackerDoctorLine(true, undefined, lastPollAgeMs(dir, NOW)), DOWN);
  writeState(dir, { v: 1, trackedAt: NOW - 11 * 60_000, prs: {} });
  assert.equal(trackerDoctorLine(true, undefined, lastPollAgeMs(dir, NOW)), DOWN);
  writeState(dir, { v: 1, off: true, trackedAt: NOW, prs: {} });
  assert.equal(lastPollAgeMs(dir, NOW), null);
  assert.equal(trackerDoctorLine(true, undefined, lastPollAgeMs(dir, NOW)), DOWN);
});

test("PR feed off: the INFO line, whatever the state file says", () => {
  assert.equal(trackerDoctorLine(false, undefined, 1_000), "INFO PR tracking is off (radar.openPrs.enabled or tools.prHost)");
});

test("hosts config error: the not-checked WARN with the error", () => {
  assert.equal(trackerDoctorLine(true, "tools.prGithubHosts: is empty", 1_000), "WARN PR tracker not checked: tools.prGithubHosts: is empty");
});

// the wiring: real /foreman doctor output
interface Opts {
  config: Record<string, unknown>;
  model: { provider: string; id: string } | undefined;
  child?: boolean;
}
/** A rig whose `run()` returns the doctor's lines; the registry knows every model, so the rank and tracker lines are the only ones that vary. */
async function doctor(t: Parameters<typeof r11Rig>[0], o: Opts) {
  const commands = new Map<string, { handler: (a: string, c: unknown) => Promise<void> }>();
  const notes: string[] = [];
  const reg = { find: (p: string, id: string) => ({ provider: p, id }), getProviderAuthStatus: () => ({ configured: true }), getAll: () => [] };
  const r = await r11Rig(t, {}, {
    config: o.config,
    child: o.child,
    ctx: { model: o.model, modelRegistry: reg, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => "approve", setStatus: () => undefined, setWidget: () => undefined } },
    piExtra: { registerCommand: (n: string, c: { handler: (a: string, c: unknown) => Promise<void> }) => void commands.set(n, c), appendEntry: () => undefined },
  });
  const run = async (): Promise<string[]> => {
    notes.length = 0;
    await commands.get("foreman")!.handler("doctor", r.ctx);
    return notes.join("\n").split("\n");
  };
  return { run, noticeTurn: r.noticeTurn, ctx: r.ctx };
}
const rankLines = (lines: string[]): string[] => lines.filter((l) => /normal model/.test(l));
const trackerLines = (lines: string[]): string[] => lines.filter((l) => /PR tracker|PR tracking/.test(l));
const PR = { tools: { pr: true, prGithubHosts: ["github.com"] }, radar: { openPrs: { enabled: true } } };
const failing = (extra: Record<string, unknown>): Record<string, unknown> => {
  const config = PRESET("claude-bridge");
  config.providers["claude-bridge"].roles.foreman = { model: FOREMEN.sonnet, thinking: "high", idle: { model: FOREMEN.haiku, thinking: "low" } };
  return { ...config, ...extra };
};
const SONNET_ID = { provider: "claude-bridge", id: "claude-sonnet-5-5" };

test("doctor output: a rank FAIL line and the tracker WARN line; the idle downshift is judged on the base model", async (t) => {
  const d = await doctor(t, { config: failing(PR), model: SONNET_ID });
  await d.noticeTurn();
  assert.equal((d.ctx.model as { id: string }).id, "claude-haiku-5-5");
  const lines = await d.run();
  // judged on the base model (Sonnet): two lines; the idle Haiku would give three
  assert.deepEqual(rankLines(lines), [
    `FAIL explorer's normal model ${SONNET} is not launchable under the foreman model ${FOREMEN.sonnet} (rank policy below) — fix: ${FIX}`,
    `FAIL builder's normal model ${SONNET} is not launchable under the foreman model ${FOREMEN.sonnet} (rank policy below) — fix: ${FIX}`,
  ]);
  assert.deepEqual(trackerLines(lines), [DOWN]);
});

test("a child session: no rank line and no tracker line", async (t) => {
  const d = await doctor(t, { config: failing(PR), model: SONNET_ID, child: true });
  const lines = await d.run();
  assert.deepEqual(rankLines(lines), []);
  assert.deepEqual(trackerLines(lines), []);
});

test("no model and PR tools off: no rank line and no tracker line", async (t) => {
  const d = await doctor(t, { config: failing({ tools: { pr: false, prGithubHosts: ["github.com"] }, radar: { openPrs: { enabled: true } } }), model: undefined });
  const lines = await d.run();
  assert.deepEqual(rankLines(lines), []);
  assert.deepEqual(trackerLines(lines), []);
});
