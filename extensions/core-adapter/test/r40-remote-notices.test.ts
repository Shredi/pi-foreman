import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeChildren } from "../closechildren.ts";
import { applyRemoteNotice, parseRemoteNotice, remoteOrigin, UNVERIFIED_PREFIX } from "../remotesession.ts";
import type { RemoteNotice } from "../remotesession.ts";
import { applyInbound, parseInbound, parseSessionArgs, readRegistry, registerSession, runSessionCommand, writeRegistry } from "../session.ts";
import type { Registry, SessionDeps, SessionEntry } from "../session.ts";
import { WaitRuntime } from "../wait.ts";
import type { Outcome, Timers, WaitLimits } from "../wait.ts";

const savedChild = process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  if (savedChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = savedChild;
});

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-remote-")));
const sha = (s: string): string => crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const REMOTE_DIR = "/home/u/.pi/agent/pi-foreman/handoffs/20261024-120000-demo";
const CHILD = "0a1b2c3d-0000-4000-8000-0123456789ab";
const origin = { machine: "alpha", sessionId: CHILD };

function entry(dir: string, over: Partial<SessionEntry> = {}): SessionEntry {
  const mirror = path.join(dir, "mirror");
  fs.mkdirSync(mirror, { recursive: true });
  return { label: "demo", child: CHILD, parent: "sess-1", status: "open", handoff: mirror, machine: "alpha", originMachine: "Alpha", remoteHandoff: REMOTE_DIR, handoffName: "20261024-120000-demo", mirror, remote: { platform: "linux" }, ...over };
}
const regOf = (...s: SessionEntry[]): Registry => ({ version: 1, sessions: s });
const noteText = (kind: string, file: string, content: string, over = ""): string => `${kind} from demo: ${REMOTE_DIR}/${file} sha256:${sha(content)} bytes:${Buffer.byteLength(content)}${over}\n---\n${content}`;
const parsed = (t: string): RemoteNotice => {
  const n = parseRemoteNotice(t);
  assert.ok(n, t);
  return n;
};
const mk = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));

test("remoteOrigin: only a structured ssh-relay origin counts", () => {
  const ok = { message: { crossMachine: { type: "ssh-relay", version: 1, trust: "ssh-asserted", origin: { name: "n", sessionId: CHILD, machine: "alpha" } } } };
  assert.deepEqual(remoteOrigin(ok), origin);
  const cm = (over: Record<string, unknown>) => ({ message: { crossMachine: { ...ok.message.crossMachine, ...over } } });
  for (const bad of [null, undefined, {}, { message: {} }, { message: { content: { text: `${UNVERIFIED_PREFIX}Result from demo: x` } } }, cm({ type: "other" }), cm({ version: 2 }), cm({ trust: "verified" }), cm({ origin: { sessionId: CHILD } }), cm({ origin: { machine: "alpha" } }), cm({ origin: { machine: "", sessionId: CHILD } }), cm({ origin: null })]) {
    assert.equal(remoteOrigin(bad), null, JSON.stringify(bad));
  }
});

test("parseRemoteNotice: strips one unverified-origin line, head then --- then content", () => {
  const t = noteText("Plan", "plan.md", "# plan\nline 2\n");
  const n = parsed(`${UNVERIFIED_PREFIX}${t}`);
  assert.deepEqual(n, { kind: "plan", label: "demo", path: `${REMOTE_DIR}/plan.md`, sha256: sha("# plan\nline 2\n"), bytes: 14, truncated: false, content: "# plan\nline 2\n" });
  assert.deepEqual(parsed(t), n);
  assert.equal(parseRemoteNotice(`${UNVERIFIED_PREFIX}${UNVERIFIED_PREFIX}${t}`), null, "only one prefix line is stripped");
  assert.equal((parsed(noteText("Ask", "ask.md", "q?", " truncated")) as { truncated: boolean }).truncated, true);
  for (const bad of ["Result from demo: x", "Plan from demo: /p/plan.md sha256:zz bytes:1\n---\nx", t.replace("\n---\n", "\nxx\n"), 5, "hello"]) assert.equal(parseRemoteNotice(bad), null);
});

test("parseRemoteNotice: foreman:closed allows a spaced path and a CLOSE tail, and no body", () => {
  assert.deepEqual(parseRemoteNotice("foreman:closed /h/a b/result.md CLOSE: ready"), { kind: "closed", path: "/h/a b/result.md", close: "ready" });
  assert.deepEqual(parseRemoteNotice(`${UNVERIFIED_PREFIX}foreman:closed`), { kind: "closed" });
  assert.deepEqual(parseRemoteNotice("foreman:closed CLOSE: open"), { kind: "closed", close: "open" });
  assert.equal(parseRemoteNotice("foreman:closed /x\nmore"), null);
});

test("applyRemoteNotice: a matching result is mirrored, matched on originMachine (not the Herdr label)", () => {
  const dir = mk("ok");
  const e = entry(dir, { status: "pending" });
  const reg = regOf(e);
  const hit = applyRemoteNotice(reg, origin, parsed(noteText("Result", "result.md", "done ✓\n")));
  assert.ok(hit?.changed);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "result.md"), "utf8"), "done ✓\n");
  assert.equal(e.status, "open");
  assert.equal(e.last?.kind, "result");
  assert.equal(e.last?.path, path.join(dir, "mirror", "result.md"));
  assert.equal(hit?.path, e.last?.path);
  assert.equal(e.machine, "alpha", "the Herdr label differs from originMachine, which is what matches");
});

test("applyRemoteNotice: wrong machine or id, closed entry, foreign dir, bad basename are ignored", () => {
  const dir = mk("ign");
  const good = parsed(noteText("Result", "result.md", "x"));
  const run = (o: typeof origin, e: SessionEntry, n: RemoteNotice = good) => applyRemoteNotice(regOf(e), o, n);
  assert.equal(run({ machine: "beta", sessionId: CHILD }, entry(dir)), null);
  assert.equal(run({ machine: "alpha", sessionId: "other" }, entry(dir)), null);
  assert.equal(run(origin, entry(dir, { status: "closed" })), null);
  assert.equal(run(origin, entry(dir, { machine: undefined })), null, "a local entry is not a remote one");
  const other = parsed(noteText("Result", "result.md", "x").replace(REMOTE_DIR, "/etc"));
  const foreign = run(origin, entry(dir), other);
  assert.equal(foreign?.changed, false);
  assert.match(foreign?.message ?? "", /ignored/);
  const badName = run(origin, entry(dir), parsed(noteText("Result", "result.md", "x").replace("result.md", "secret.md")));
  assert.equal(badName?.changed, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "mirror")), []);
});

test("applyRemoteNotice: a hash or size mismatch writes nothing; a truncated notice goes to .partial", () => {
  const dir = mk("hash");
  const e = entry(dir);
  const bad = parsed(noteText("Result", "result.md", "abc").replace(sha("abc"), "0".repeat(64)));
  const miss = applyRemoteNotice(regOf(e), origin, bad);
  assert.equal(miss?.changed, false);
  assert.equal(miss?.message, "remote notice from demo@alpha: hash mismatch, not mirrored");
  const size = applyRemoteNotice(regOf(e), origin, parsed(noteText("Result", "result.md", "abc").replace("bytes:3", "bytes:9")));
  assert.equal(size?.changed, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "mirror")), []);
  assert.equal(e.last, undefined);
  const cut = applyRemoteNotice(regOf(e), origin, parsed(`Plan from demo: ${REMOTE_DIR}/plan.md sha256:${"a".repeat(64)} bytes:900 truncated\n---\nfirst part`));
  assert.ok(cut?.changed);
  assert.match(cut?.message ?? "", /truncated/);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "plan.md.partial"), "utf8"), "first part");
  assert.equal(fs.existsSync(path.join(dir, "mirror", "plan.md")), false);
  assert.equal(e.last?.path, path.join(dir, "mirror", "plan.md.partial"));
});

test("applyRemoteNotice: win32 remote dirs compare case-insensitively with normalized separators", () => {
  const dir = mk("win");
  const e = entry(dir, { remoteHandoff: "C:\\Users\\u\\handoffs\\20261024-120000-demo", remote: { platform: "win32" } });
  const t = `Result from demo: c:\\users\\U\\handoffs\\20261024-120000-demo\\result.md sha256:${sha("w")} bytes:1\n---\nw`;
  assert.ok(applyRemoteNotice(regOf(e), origin, parsed(t))?.changed);
});

test("applyRemoteNotice: foreman:closed closes the entry and stores the mirror result path, never the remote one", () => {
  const dir = mk("closed");
  const e = entry(dir);
  const closed = parsed("foreman:closed /remote/with space/result.md CLOSE: ready");
  const none = applyRemoteNotice(regOf(e), origin, closed);
  assert.equal(none?.entry.status, "closed");
  assert.equal(none?.path, "");
  assert.equal(e.last?.path, undefined);
  assert.ok(!JSON.stringify(e).includes("with space"));
  const e2 = entry(mk("closed2"));
  fs.writeFileSync(path.join(e2.mirror as string, "result.md.partial"), "p");
  assert.equal(applyRemoteNotice(regOf(e2), origin, closed)?.path, path.join(e2.mirror as string, "result.md.partial"));
  const e3 = entry(mk("closed3"));
  fs.writeFileSync(path.join(e3.mirror as string, "result.md"), "r");
  fs.writeFileSync(path.join(e3.mirror as string, "result.md.partial"), "p");
  const done = applyRemoteNotice(regOf(e3), origin, closed);
  assert.equal(done?.path, path.join(e3.mirror as string, "result.md"));
  assert.equal(e3.last?.path, done?.path);
  assert.equal(e3.status, "closed");
  assert.equal(applyRemoteNotice(regOf(e3), origin, closed), null, "a closed entry takes no further notice");
});

test("a notice in the exact format of the Python `remote notice` command is parsed and mirrored", () => {
  const dir = mk("py");
  const e = entry(dir);
  const content = "# Result\nok — 完了\n";
  const abs = `${REMOTE_DIR}/result.md`;
  // scripts/foreman_session.py: "%s from %s: %s sha256:%s bytes:%d" then "\n---\n" then the content
  const text = `${UNVERIFIED_PREFIX}Update from demo: ${abs} sha256:${sha(content)} bytes:${Buffer.byteLength(content)}\n---\n${content}`;
  const n = parsed(text);
  assert.equal(n.kind, "update");
  const hit = applyRemoteNotice(regOf(e), origin, n);
  assert.equal(fs.readFileSync(path.join(dir, "mirror", "result.md"), "utf8"), content);
  assert.equal(hit?.kind, "update");
  assert.equal(e.result, path.join(dir, "mirror", "result.md"));
});

test("the local route never touches an entry with machine", () => {
  const e = entry(mk("local"));
  const reg = regOf(e);
  const msg = parseInbound("Result from demo: /x/result.md");
  assert.ok(msg);
  assert.equal(applyInbound(reg, CHILD, msg, new Date()), null);
  assert.equal(applyInbound(reg, CHILD, { kind: "closed", path: "/x" }, new Date()), null);
  assert.equal(e.status, "open");
  assert.equal(e.last, undefined);
});

function runtime() {
  const wakes: Outcome[][] = [];
  const timers: Timers = { set: () => 1, clear: () => undefined };
  const limits: WaitLimits = { batchWindowSeconds: 0, maxSeconds: 86400, maxActive: 4, ci: true };
  const rt = new WaitRuntime({ timers, now: () => 0, limits: () => limits, stat: () => null, alive: () => true, gh: () => Promise.reject(new Error("unused")), wake: (o) => wakes.push(o), trace: () => undefined });
  return { rt, wakes };
}

test("foreman_wait kind child wakes for a remote label with the mirror path", () => {
  const { rt, wakes } = runtime();
  for (const kind of ["plan", "result", "ask", "closed"]) {
    rt.start({ kind: "child", label: "demo", note: "" });
    assert.equal(rt.childNotice("demo", kind, `/m/${kind}.md`), true);
  }
  assert.deepEqual(wakes.map((w) => w[0].outcome), ["child demo: plan /m/plan.md", "child demo: result /m/result.md", "child demo: ask /m/ask.md", "child demo: closed /m/closed.md"]);
  rt.start({ kind: "child", label: "demo", note: "" });
  rt.childNotice("demo", "closed", "");
  assert.equal(wakes[4][0].outcome, "child demo: closed");
});

function register(agent: string) {
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown>>();
  const pi = { on: (n: string, h: (e: unknown, c: unknown) => Promise<unknown>) => void handlers.set(n, h) };
  const woke: string[][] = [];
  registerSession(pi as never, { spawner: async () => { throw new Error("no spawn"); }, pkgRoot: "/pkg", session: async () => ({ id: "sess-1", isChild: false, cwd: root, agentDir: agent, python: null }), onChildNotice: (_s, label, kind, p) => void woke.push([label, kind, p]) });
  const notes: string[] = [];
  const ctx = { ui: { notify: (t: string) => void notes.push(t) }, sessionManager: { getBranch: () => [] } };
  const send = (details: unknown) => handlers.get("message_end")!({ message: { role: "custom", customType: "intercom_message", details } }, ctx);
  return { send, notes, woke };
}
const relayed = (text: string, id: string, from = "broker-id", cross: Record<string, unknown> = { type: "ssh-relay", version: 1, trust: "ssh-asserted", origin: { name: "n", sessionId: CHILD, machine: "ALPHA" } }) => ({ from: { id: from }, message: { id, content: { text: `${UNVERIFIED_PREFIX}${text}` }, crossMachine: cross } });

test("registerSession: a relayed notice mirrors, updates the registry once and wakes the wait", async () => {
  const agent = mk("agent");
  const e = entry(agent);
  writeRegistry(agent, regOf(e));
  const r = register(agent);
  const t = noteText("Result", "result.md", "all done");
  await r.send(relayed(t, "m1"));
  await r.send(relayed(t, "m1"));
  const got = readRegistry(agent).sessions[0];
  assert.equal(got.last?.kind, "result");
  assert.equal(fs.readFileSync(path.join(agent, "mirror", "result.md"), "utf8"), "all done");
  assert.deepEqual(r.woke, [["demo", "result", path.join(agent, "mirror", "result.md")]]);
  assert.equal(r.notes.length, 1);
  // no crossMachine metadata: the same text from a local sender is not a remote notice and changes nothing
  await r.send({ from: { id: CHILD }, message: { id: "m2", content: { text: noteText("Plan", "plan.md", "p") } } });
  await r.send({ from: { id: CHILD }, message: { id: "m3", content: { text: "foreman:closed /x/result.md" } } });
  assert.equal(readRegistry(agent).sessions[0].status, "open");
  assert.equal(r.woke.length, 1);
  await r.send(relayed("foreman:closed /remote/result.md CLOSE: ready", "m4"));
  assert.equal(readRegistry(agent).sessions[0].status, "closed");
  assert.deepEqual(r.woke[1], ["demo", "closed", path.join(agent, "mirror", "result.md")]);
});

test("registerSession: a forged cross-machine notice from the wrong machine changes nothing", async () => {
  const agent = mk("agent2");
  writeRegistry(agent, regOf(entry(agent)));
  const r = register(agent);
  await r.send(relayed(noteText("Result", "result.md", "x"), "f1", "b", { type: "ssh-relay", version: 1, trust: "ssh-asserted", origin: { name: "n", sessionId: CHILD, machine: "beta" } }));
  assert.equal(readRegistry(agent).sessions[0].last, undefined);
  assert.equal(r.woke.length, 0);
  assert.equal(r.notes.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(agent, "mirror")), []);
});

test("parseSessionArgs: --machine and --trust are set only when given", () => {
  assert.deepEqual(parseSessionArgs("open demo b.md --cwd /home/u/p"), { sub: "open", label: "demo", brief: "b.md", cwd: "/home/u/p", planFirst: false, focus: false, dryRun: false });
  assert.deepEqual(parseSessionArgs("open demo b.md --cwd /home/u/p --machine alpha --trust"), { sub: "open", label: "demo", brief: "b.md", cwd: "/home/u/p", planFirst: false, focus: false, dryRun: false, machine: "alpha", trust: true });
  assert.ok("error" in parseSessionArgs("open demo b.md --machine"));
});

function deps(agentDir: string, over: Partial<SessionDeps> = {}): SessionDeps & { sent: [string, string][]; spawned: string[][] } {
  const sent: [string, string][] = [];
  const spawned: string[][] = [];
  return {
    isChild: false,
    env: {},
    agentDir,
    cwd: root,
    piSessionId: "sess-1",
    pkgRoot: "/pkg",
    python: "/usr/bin/python3",
    spawner: async (_c, args) => (spawned.push(args), { code: 0, stdout: "ok", stderr: "", timedOut: false }),
    send: async (to, text) => (sent.push([to, text]), "sent"),
    sent,
    spawned,
    ...over,
  };
}

test("session open --machine: refuses a missing --cwd, passes the remote cwd verbatim, resolves the brief locally", async () => {
  const d = deps(mk("open"));
  const no = await runSessionCommand(d, "open demo b.md --machine alpha");
  assert.equal(no.ok, false);
  assert.match(no.text, /needs --cwd/);
  assert.equal(d.spawned.length, 0);
  const r = await runSessionCommand(d, "open demo b.md --machine alpha --trust --cwd /home/u/p");
  assert.ok(r.ok);
  const argv = d.spawned[0];
  assert.equal(argv[argv.indexOf("--cwd") + 1], "/home/u/p");
  assert.equal(argv[argv.indexOf("open") + 2], path.resolve(root, "b.md"));
  assert.ok(argv.includes("--trust"));
  assert.equal(argv[argv.indexOf("--machine") + 1], "alpha");
  const local = deps(mk("open2"));
  await runSessionCommand(local, "open demo b.md --cwd sub");
  assert.equal(local.spawned[0][local.spawned[0].indexOf("--cwd") + 1], path.resolve(root, "sub"));
  assert.ok(!local.spawned[0].includes("--machine") && !local.spawned[0].includes("--trust"));
});

test("session brief for a remote entry runs the script's brief, no intercom send; a local entry still sends", async () => {
  const agent = mk("brief");
  writeRegistry(agent, regOf(entry(agent), { label: "loc", child: "fm-loc", status: "open" }));
  const d = deps(agent);
  const r = await runSessionCommand(d, "brief demo go ahead with B");
  assert.ok(r.ok);
  assert.equal(d.sent.length, 0);
  const a = d.spawned[0];
  assert.deepEqual(a.slice(a.indexOf("brief")), ["brief", "demo", "go ahead with B"]);
  await runSessionCommand(d, "brief loc hello");
  assert.deepEqual(d.sent, [["fm-loc", "hello"]]);
});

test("session brief resolves the newest entry of a label of any kind: a newer local entry wins over an older remote one", async () => {
  const agent = mk("brief-newest");
  writeRegistry(agent, regOf(entry(agent), { label: "demo", child: "fm-demo-local", status: "open" }));
  const d = deps(agent);
  const r = await runSessionCommand(d, "brief demo hello");
  assert.ok(r.ok);
  assert.equal(d.spawned.length, 0);
  assert.deepEqual(d.sent, [["fm-demo-local", "hello"]]);
  writeRegistry(agent, regOf({ label: "demo", child: "fm-demo-local", status: "open" }, entry(agent)));
  const d2 = deps(agent);
  await runSessionCommand(d2, "brief demo hello");
  assert.equal(d2.sent.length, 0);
  assert.equal(d2.spawned.length, 1);
});

test("session close and closeChildren skip remote entries with the not-closed line", async () => {
  const agent = mk("close");
  const e = entry(agent);
  writeRegistry(agent, regOf(e));
  const d = deps(agent);
  const r = await runSessionCommand(d, "close demo");
  assert.equal(r.ok, false);
  assert.equal(r.text, "demo@alpha: not closed (remote close comes in P2; close it on alpha)");
  assert.equal(d.sent.length, 0);
  assert.equal(readRegistry(agent).sessions[0].status, "open");
  const sent: string[] = [];
  const lines = await closeChildren({ agentDir: agent, opener: "sess-1", send: async (to) => (sent.push(to), "sent"), waitMs: 0, sleep: async () => undefined });
  assert.deepEqual(lines, ["demo@alpha: not closed (remote close comes in P2; close it on alpha)"]);
  assert.equal(sent.length, 0);
  assert.equal(readRegistry(agent).sessions[0].status, "open");
});
