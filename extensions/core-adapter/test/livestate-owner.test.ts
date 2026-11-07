// Live state `owner` (present, away, grace, unknown): read from a getter at write time; SelfWarm.ownerPresence() is the source.
// `presence` and `away` stay as they were.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveState, liveDir } from "../livestate.ts";
import { AWAY_GRACE_MS, SelfWarm } from "../selfwarm.ts";
import type { Presence } from "../presence.ts";
import type { CachePolicy } from "../cachepolicy.ts";
import { r11Rig } from "./_r11rig.ts";

const read = (d: string, id: string) => JSON.parse(fs.readFileSync(path.join(liveDir(d), `${id}.json`), "utf8"));

test("the snapshot carries owner from the getter at write time; no getter or a throwing getter leaves it out", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ls-owner-"));
  const l = LiveState.start({ agentDir: d, sessionId: "o", cwd: "/w", mode: "rpc", env: {} }, () => [])!;
  assert.equal("owner" in read(d, "o"), false, "no getter, no field");
  let cur: "present" | "away" | "grace" | "unknown" = "grace";
  l.setOwnerGetter(() => cur);
  assert.equal(l.snapshot().owner, "grace");
  l.write();
  assert.equal(read(d, "o").owner, "grace");
  assert.equal(read(d, "o").presence, "idle", "presence is unchanged");
  cur = "away";
  assert.equal(l.snapshot().owner, "away", "read at write time");
  l.setOwnerGetter(() => {
    throw new Error("boom");
  });
  assert.equal("owner" in l.snapshot(), false);
  l.stop();
  fs.rmSync(d, { recursive: true, force: true });
});

const POLICY: CachePolicy = { active: false, ttlSeconds: 300, billing: "token", intervalSeconds: 0, windowMinutes: 0, effectiveWindowMinutes: 0, warmCompact: true, budgetShare: 0.5, keepaliveOwned: true };

function swith(p: { enabled: boolean; away: boolean; since: number | null; outcome: string | null }, o: { isChild?: boolean; now?: number } = {}): SelfWarm {
  const presence = { enabled: () => p.enabled, away: () => p.away, awaySince: () => p.since, sample: () => (p.outcome ? { outcome: p.outcome } : null), refresh: async () => undefined, disarm: () => undefined, arm: () => undefined } as unknown as Presence;
  return new SelfWarm({
    now: () => o.now ?? 10_000_000,
    isChild: o.isChild ?? false,
    policy: () => POLICY,
    presence,
    signals: () => ({ strongA: null, turn: false, question: false, dialog: false, command: false }),
    queued: () => false,
    rates: () => null,
    compact: () => null,
    trace: () => undefined,
    replayable: () => true,
    replay: async () => null,
    record: () => null,
  });
}

test("ownerPresence: present, unknown (probe failed or unsampled), away, and grace for 15 minutes after the away mark", () => {
  const now = 10_000_000;
  assert.equal(swith({ enabled: false, away: false, since: null, outcome: null }).ownerPresence(), "present", "presence off");
  assert.equal(swith({ enabled: true, away: false, since: null, outcome: "present" }).ownerPresence(), "present");
  assert.equal(swith({ enabled: true, away: false, since: null, outcome: null }).ownerPresence(), "unknown");
  assert.equal(swith({ enabled: true, away: false, since: null, outcome: "unknown" }).ownerPresence(), "unknown");
  assert.equal(swith({ enabled: true, away: true, since: now - AWAY_GRACE_MS + 1, outcome: "away" }).ownerPresence(), "grace");
  assert.equal(swith({ enabled: true, away: true, since: now - AWAY_GRACE_MS, outcome: "away" }).ownerPresence(), "away");
  assert.equal(swith({ enabled: true, away: true, since: null, outcome: "away" }).ownerPresence(), "away");
});

test("a child session's owner is always present", () => {
  assert.equal(swith({ enabled: true, away: true, since: null, outcome: "away" }, { isChild: true }).ownerPresence(), "present");
});

test("the adapter writes owner into the live file of the session", async (t) => {
  const r = await r11Rig(t, {}, {});
  await r.fire("agent_start", {});
  await new Promise((res) => setTimeout(res, 1200)); // the live file is written at most once a second
  await r.fire("agent_settled", {});
  const file = path.join(liveDir(r.agentDir), `${r.sessionId}.json`);
  assert.ok(fs.existsSync(file));
  const live = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(live.owner, "present", "presence is off in the rig");
  assert.equal("away" in live, false);
});
