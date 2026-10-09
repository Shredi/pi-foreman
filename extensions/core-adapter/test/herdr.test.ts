import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlockedTracker, blockedConfirm, installBlockedShim, permissionLabel, withBlocked } from "../herdr.ts";

type Sent = { active: boolean; label?: string };

/** A fake `pi`: `on` for Pi events, `events` for the shared bus; `fire` delivers a Pi event. */
function fakePi() {
  const handlers = new Map<string, ((d: unknown) => void)[]>();
  const piHandlers = new Map<string, ((e: unknown) => unknown)[]>();
  const sent: Sent[] = [];
  const events = {
    emit(ch: string, d: unknown) {
      if (ch === "herdr:blocked") sent.push(d as Sent);
      for (const h of handlers.get(ch) ?? []) h(d);
    },
    on(ch: string, h: (d: unknown) => void) {
      handlers.set(ch, [...(handlers.get(ch) ?? []), h]);
      return () => handlers.set(ch, []);
    },
  };
  const pi = {
    events,
    on(ev: string, h: (e: unknown) => unknown) {
      piHandlers.set(ev, [...(piHandlers.get(ev) ?? []), h]);
    },
  };
  const fire = async (ev: string, e: unknown = {}) => {
    for (const h of piHandlers.get(ev) ?? []) await h(e);
  };
  return { pi, events, sent, fire, piHandlers };
}

const ON = { env: { HERDR_ENV: "1" }, agentDir: path.join(os.tmpdir(), "no-such-pi-agent-dir") };
const actives = (s: Sent[]) => s.map((x) => x.active);

function install(opts: Parameters<typeof installBlockedShim>[1] = ON) {
  const f = fakePi();
  const tracker = installBlockedShim(f.pi as never, opts);
  return { ...f, tracker };
}

test("another extension's dialog blocks and unblocks with its title (else kind)", async () => {
  const { fire, sent } = install();
  await fire("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick\none" });
  await fire("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "select" });
  await fire("ui_prompt_start", { kind: "input" });
  await fire("ui_prompt_end", { kind: "input" });
  assert.deepEqual(sent, [{ active: true, label: "Pick one" }, { active: false }, { active: true, label: "input" }, { active: false }]);
});

test("permission ask overlapping a ui prompt (end before decision) emits exactly one true and one false", async () => {
  const { fire, events, sent } = install();
  events.emit("permissions:ui_prompt", { requestId: "r1", surface: "bash", value: "git push origin", agentName: "foreman", request: { toolName: "bash" }, forwarding: { requesterAgentName: "builder" } });
  await fire("ui_prompt_start", { kind: "custom" });
  await fire("ui_prompt_end", { kind: "custom" });
  events.emit("permissions:decision", { requestId: "r1" });
  assert.deepEqual(sent, [{ active: true, label: "builder · bash git" }, { active: false }]);
});

test("an own ask nested inside a ui prompt stays one block", async () => {
  const { fire, events, sent } = install();
  await fire("ui_prompt_start", { kind: "confirm", title: "outer" });
  assert.equal(await blockedConfirm(events, async (t, m) => t === "T" && m === "M")("T", "M"), true);
  await assert.rejects(withBlocked(events, "x", async () => { throw new Error("boom"); }), /boom/);
  assert.deepEqual(actives(sent), [true]);
  await fire("ui_prompt_end", {});
  assert.deepEqual(sent, [{ active: true, label: "outer" }, { active: false }]);
});

test("typed input releases an orphaned dialog (no ui_prompt_end) but not a permission ask", async () => {
  const { fire, events, sent } = install();
  await fire("ui_prompt_start", { kind: "select", title: "lost" });
  await fire("input", { text: "x", source: "extension" });
  assert.deepEqual(actives(sent), [true]);
  await fire("input", { text: "go on", source: "interactive" });
  assert.deepEqual(actives(sent), [true, false]);
  events.emit("permissions:ui_prompt", { requestId: "r9", surface: "bash", value: "ls" });
  await fire("input", { text: "y", source: "interactive" });
  assert.deepEqual(actives(sent), [true, false, true]);
});

test("permission label skips env assignments and never shows a value after =", () => {
  assert.equal(permissionLabel({ agentName: "builder", request: { toolName: "bash" }, value: "GITHUB_TOKEN=ghp_FAKE gh pr create" }), "builder · bash gh");
  assert.equal(permissionLabel({ request: { toolName: "bash" }, value: "env A=1 B=secret make deploy" }), "bash make");
  assert.equal(permissionLabel({ request: { toolName: "bash" }, value: "--token=secret" }), "bash --token");
  assert.equal(permissionLabel({ request: { toolName: "bash" }, value: "SECRET=only" }), "bash");
});

test("a decision without a prompt and an end without a start emit nothing", async () => {
  const { fire, events, sent } = install();
  events.emit("permissions:decision", { requestId: "nope" });
  await fire("ui_prompt_end", {});
  events.emit("permissions:ui_prompt", { requestId: "r1", surface: "read", value: "/a/b/notes.txt" });
  events.emit("permissions:ui_prompt", { requestId: "r1", surface: "read", value: "x" });
  events.emit("permissions:decision", { requestId: "r2" });
  events.emit("permissions:decision", { requestId: "r1" });
  events.emit("permissions:decision", { requestId: "r1" });
  assert.deepEqual(sent, [{ active: true, label: "read notes.txt" }, { active: false }]);
});

test("clear releases everything once; agent_end keeps an open Pi dialog", async () => {
  const { fire, events, sent, tracker } = install();
  events.emit("permissions:ui_prompt", { requestId: "a" });
  events.emit("permissions:ui_prompt", { requestId: "b" });
  tracker.clear();
  tracker.clear();
  events.emit("permissions:decision", { requestId: "a" });
  assert.deepEqual(actives(sent), [true, false]);
  await fire("ui_prompt_start", { kind: "select" });
  events.emit("permissions:ui_prompt", { requestId: "c" });
  await fire("agent_end", {});
  assert.deepEqual(actives(sent), [true, false, true], "the dialog is still open");
  await fire("ui_prompt_end", {});
  events.emit("permissions:ui_prompt", { requestId: "d" });
  await fire("session_shutdown", {});
  assert.deepEqual(actives(sent), [true, false, true, false, true, false]);
});

test("steps aside when the installed Herdr integration is version 10 or newer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-shim-"));
  try {
    fs.mkdirSync(path.join(dir, "extensions"));
    const file = path.join(dir, "extensions", "herdr-agent-state.ts");
    for (const [v, want] of [[10, 0], [9, 4]] as const) {
      fs.writeFileSync(file, `// HERDR_INTEGRATION_VERSION=${v}\nexport default function () {}\n`);
      const { fire, events, sent, piHandlers } = install({ env: { HERDR_ENV: "1" }, agentDir: dir });
      await fire("ui_prompt_start", { kind: "select" });
      await fire("ui_prompt_end", {});
      await withBlocked(events, "own", async () => 1);
      assert.equal(sent.length, want, `version ${v}`);
      if (v === 10) assert.equal(piHandlers.size, 0, "nothing subscribed");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no emits without HERDR_ENV=1 or with herdr.blockedShim false", async () => {
  for (const opts of [{ env: {}, agentDir: ON.agentDir }, { ...ON, enabled: () => false }]) {
    const { fire, events, sent } = install(opts);
    await fire("ui_prompt_start", { kind: "select" });
    events.emit("permissions:ui_prompt", { requestId: "r" });
    await withBlocked(events, "own", async () => 1);
    await fire("ui_prompt_end", {});
    assert.deepEqual(sent, []);
  }
});

test("the permission label never carries the full command", () => {
  const label = permissionLabel({ requestId: "r", surface: "bash", value: "rm -rf /secret/x", agentName: null, request: { toolName: "bash" }, forwarding: null });
  assert.equal(label, "bash rm");
  assert.equal(permissionLabel({ value: "/usr/bin/curl https://x/y?token=1" }), "permission curl");
  assert.ok(permissionLabel({ agentName: "a".repeat(200), value: "ls" }).length <= 80);
});

test("onChange fires on the same transitions as herdr:blocked", () => {
  const seen: boolean[] = [];
  const t = new BlockedTracker(undefined);
  t.onChange((a) => seen.push(a));
  const r1 = t.own("a");
  const r2 = t.own("b");
  r1();
  r2();
  assert.deepEqual(seen, [true, false]);
});
