// R46 item 1: the identity of an opened session (child intercom id, parent, label, model, handoff dir) is written to a
// `pi-foreman-identity` session entry and restored at session_start after a plain restart (no env), so the session keeps
// its intercom id, its parent and its model. A fork, another session id, a child mismatch, a live.json naming another
// session and a subagent child restore nothing.
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import coreAdapter from "../index.ts";
import { rmTestTmp, waitQuiet } from "./_tmpbase.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
const IDENTITY_KEYS = ["PI_FOREMAN_HANDOFF_DIR", "PI_FOREMAN_PARENT_INTERCOM", "PI_INTERCOM_STABLE_ID", "PI_FOREMAN_PARENT_LABEL", "PI_FOREMAN_SESSION_MODEL", "PI_FOREMAN_REMOTE_PARENT"];
const KEYS = [...IDENTITY_KEYS, "PI_CODING_AGENT_DIR", "PI_SUBAGENT_CHILD", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_PYTHON", "PI_FOREMAN_STATE_DIR", "PI_FOREMAN_PRESSURE_FIXTURE", "HERDR_PANE_ID", "HERDR_ENV"];
const CHILD = "fm-demo-abc123";
let n = 0;

function rig(t: TestContext) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r46-id-")));
  const downs: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const d of downs) {
      try { await d(); } catch { /* best effort */ }
    }
    await waitQuiet(path.join(root, "agent", "pi-foreman", "state"));
    rmTestTmp(root);
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });
  const project = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const ps = path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system");
  fs.mkdirSync(path.join(ps, "src"), { recursive: true });
  fs.writeFileSync(path.join(ps, "package.json"), JSON.stringify({ name: "@gotgenes/pi-permission-system" }));
  fs.writeFileSync(path.join(ps, "src", "index.ts"), "export default () => undefined;\n");
  fs.writeFileSync(path.join(agentDir, "foreman.json"), JSON.stringify({ providers: { fake: { roles: { foreman: { model: "fake/foreman-role" } } } }, trace: { enabled: true } }));
  const handoff = path.join(agentDir, "pi-foreman", "handoffs", "demo-abc123");
  fs.mkdirSync(handoff, { recursive: true });
  fs.writeFileSync(path.join(handoff, "child"), `${CHILD}\n`);
  fs.writeFileSync(path.join(handoff, "parent"), "parent-id\n");
  const sessionId = `r46id-${++n}`;
  const entries: { type: "custom"; customType: string; data: unknown }[] = [];
  const models: string[] = [];
  const names: { value: string | undefined } = { value: undefined };
  const setEnv = (on: boolean) => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    for (const k of ["PI_SUBAGENT_CHILD", "PI_INTERCOM_SESSION_ID", "PI_FOREMAN_PRESSURE_FIXTURE", "HERDR_PANE_ID", "HERDR_ENV", ...IDENTITY_KEYS]) delete process.env[k];
    if (!on) return;
    process.env.PI_FOREMAN_HANDOFF_DIR = handoff;
    process.env.PI_FOREMAN_PARENT_INTERCOM = "parent-id";
    process.env.PI_INTERCOM_STABLE_ID = CHILD;
    process.env.PI_FOREMAN_PARENT_LABEL = "boss";
    process.env.PI_FOREMAN_SESSION_MODEL = "fake/session-model";
  };

  /** One adapter start over the same session file (`entries`); `id` overrides the Pi session id (a fork, a copied file). */
  async function start(reason: string, id = sessionId) {
    const handlers = new Map<string, Handler>();
    const pi = {
      events: { on: () => undefined, emit: () => undefined },
      on: (name: string, h: Handler) => void handlers.set(name, h),
      registerCommand: () => undefined,
      registerTool: () => undefined,
      appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
      getActiveTools: () => [] as string[],
      getAllTools: () => [{ name: "bash" }],
      setActiveTools: () => undefined,
      setModel: async (m: { provider: string; id: string }) => (models.push(`${m.provider}/${m.id}`), true),
      setThinkingLevel: () => undefined,
      sendMessage: () => undefined,
      getSessionName: () => names.value,
      setSessionName: (v: string) => void (names.value = v),
    };
    coreAdapter(pi as never, { pressureNow: () => Date.now(), pressureRun: async () => ({ ok: true, text: "" }) });
    const ctx = {
      sessionManager: { getSessionId: () => id, getSessionFile: () => path.join(agentDir, "sessions", "--project--", `${id}.jsonl`), getEntries: () => entries, getBranch: () => entries },
      cwd: project,
      model: { provider: "fake", id: "default" },
      mode: "tui",
      hasUI: true,
      isProjectTrusted: () => false,
      isIdle: () => true,
      modelRegistry: { find: (provider: string, mid: string) => ({ provider, id: mid }), getProviderAuthStatus: () => ({ configured: false }) },
      ui: { notify: () => undefined, confirm: async () => false, select: async () => undefined, input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    };
    await handlers.get("session_start")!({ reason }, ctx);
    const down = async () => handlers.get("session_shutdown")?.({}, ctx);
    downs.push(down);
    return { down };
  }
  const identityEntries = () => entries.filter((e) => e.customType === "pi-foreman-identity");
  const envNow = () => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, process.env[k]]));
  /** The first start of an opened session (env set by `foreman session open`), then a restart with the env gone. */
  async function opened() {
    setEnv(true);
    const a = await start("startup");
    await a.down();
    models.length = 0;
    setEnv(false);
    return a;
  }
  const liveFile = path.join(handoff, "live.json");
  return { start, setEnv, opened, entries, identityEntries, envNow, models, names, handoff, liveFile, sessionId };
}

test("an opened session writes its identity entry and live.json at session_start, once", async (t) => {
  const r = rig(t);
  r.setEnv(true);
  const a = await r.start("startup");
  assert.equal(r.identityEntries().length, 1);
  const d = r.identityEntries()[0].data as Record<string, unknown>;
  assert.deepEqual(d, { v: 1, piSessionId: r.sessionId, child: CHILD, parentLabel: "boss", handoff: r.handoff, model: "fake/session-model", remoteParent: null, sessionName: null });
  const live = JSON.parse(fs.readFileSync(r.liveFile, "utf8")) as Record<string, unknown>;
  assert.equal(live.intercomId, CHILD);
  assert.equal(live.piSessionId, r.sessionId);
  await a.down();
  const b = await r.start("reload"); // unchanged: no second entry
  assert.equal(r.identityEntries().length, 1);
  await b.down();
});

test("startup without env restores env and the intercom id; the model comes back (main case)", async (t) => {
  const r = rig(t);
  await r.opened();
  assert.deepEqual(r.envNow(), Object.fromEntries(IDENTITY_KEYS.map((k) => [k, undefined])));
  await r.start("startup");
  assert.deepEqual(r.envNow(), { PI_FOREMAN_HANDOFF_DIR: r.handoff, PI_FOREMAN_PARENT_INTERCOM: "parent-id", PI_INTERCOM_STABLE_ID: CHILD, PI_FOREMAN_PARENT_LABEL: "boss", PI_FOREMAN_SESSION_MODEL: "fake/session-model", PI_FOREMAN_REMOTE_PARENT: undefined });
  assert.deepEqual(r.models, ["fake/session-model"]);
});

test("resume without env restores the same; the model comes back on resume", async (t) => {
  const r = rig(t);
  await r.opened();
  await r.start("resume");
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, CHILD);
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, r.handoff);
  assert.deepEqual(r.models, ["fake/session-model"]);
});

test("the parent id is re-read from the handoff parent file, not from the entry", async (t) => {
  const r = rig(t);
  await r.opened();
  fs.writeFileSync(path.join(r.handoff, "parent"), "new-parent\n");
  await r.start("startup");
  assert.equal(process.env.PI_FOREMAN_PARENT_INTERCOM, "new-parent");
});

test("the session name comes back when it is empty", async (t) => {
  const r = rig(t);
  r.setEnv(true);
  r.names.value = "My session";
  const a = await r.start("startup");
  await a.down();
  r.setEnv(false);
  r.names.value = undefined;
  await r.start("startup");
  assert.equal(r.names.value, "My session");
});

test("a fork restores nothing", async (t) => {
  const r = rig(t);
  await r.opened();
  await r.start("fork");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, undefined);
  assert.deepEqual(r.models, []);
});

test("an entry naming another Pi session id (a copied session file) restores nothing", async (t) => {
  const r = rig(t);
  await r.opened();
  await r.start("startup", "some-other-session");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, undefined);
  assert.ok(!r.models.includes("fake/session-model"));
});

test("a handoff whose child file differs restores nothing", async (t) => {
  const r = rig(t);
  await r.opened();
  fs.writeFileSync(path.join(r.handoff, "child"), "fm-other-ffffff\n");
  await r.start("startup");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, undefined);
});

test("a handoff whose live.json names another session restores nothing", async (t) => {
  const r = rig(t);
  await r.opened();
  fs.writeFileSync(r.liveFile, JSON.stringify({ intercomId: CHILD, piSessionId: "someone-else", at: "2026-01-01T00:00:00Z" }));
  await r.start("startup");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, undefined);
  assert.equal(JSON.parse(fs.readFileSync(r.liveFile, "utf8")).piSessionId, "someone-else", "and live.json is not overwritten");
});

test("a handoff without live.json restores nothing", async (t) => {
  const r = rig(t);
  await r.opened();
  fs.rmSync(r.liveFile);
  await r.start("startup");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
});

test("a subagent child neither writes nor restores an identity", async (t) => {
  const r = rig(t);
  await r.opened();
  process.env.PI_SUBAGENT_CHILD = "1";
  const before = r.identityEntries().length;
  await r.start("startup");
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.equal(process.env.PI_INTERCOM_STABLE_ID, undefined);
  assert.equal(r.identityEntries().length, before);
  assert.deepEqual(r.models, []);
});

test("a session that was not opened (no handoff env, no entry) is untouched", async (t) => {
  const r = rig(t);
  r.setEnv(false);
  await r.start("startup");
  assert.equal(r.identityEntries().length, 0);
  assert.equal(process.env.PI_FOREMAN_HANDOFF_DIR, undefined);
  assert.deepEqual(r.models, ["fake/foreman-role"], "the foreman role model still applies on startup");
});
