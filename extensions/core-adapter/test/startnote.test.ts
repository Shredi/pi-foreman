// The start note (startnote.ts and its before_agent_start handler): once, at the first prompt of a main session without a parent, when open entries
// with count >= 2 exist. Every test works in its own rig dir; none writes into a real store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { DATA_LINE, recordReport, storeFor } from "../reports.ts";
import { START_NOTE_ENTRY, START_NOTE_TYPE } from "../startnote.ts";

type Msg = { customType: string; content: string; display?: boolean };
type Rig = Awaited<ReturnType<typeof r11Rig>>;

/** One report seen by `sessions` different sessions (count = sessions.length). */
function seed(r: Rig, subject: string, sessions: number, what = "it blocked a read"): void {
  for (let i = 0; i < sessions; i++) {
    recordReport({ cwd: r.project, role: "foreman", session: `seed-${i}`, runId: null, source: "agent", repo: null, workspace: null, branch: null }, { kind: "rule", subject, what, effect: "blocked" }, storeFor(r.project));
  }
}

/** Every before_agent_start handler, the way Pi collects them: one message per handler. */
async function messages(r: Rig, prompt = "go"): Promise<Msg[]> {
  const out: Msg[] = [];
  for (const h of r.handlersOf("before_agent_start")) {
    const res = (await h({ prompt, type: "before_agent_start", systemPrompt: "", systemPromptOptions: { sections: {} } }, r.ctx)) as { message?: Msg } | undefined;
    if (res?.message) out.push(res.message);
  }
  return out;
}

const notes = (ms: Msg[]) => ms.filter((m) => m.customType === START_NOTE_TYPE);

function withEnv(t: { after(fn: () => void): void }, key: string, value: string): void {
  const prev = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

test("start note: sent once at the first prompt with the data line first, quoted text and the foreman_reports hint", async (t) => {
  const appended: [string, unknown][] = [];
  const r = await r11Rig(t, {}, { piExtra: { appendEntry: (n: string, d: unknown) => void appended.push([n, d]) } });
  seed(r, "guard x", 3);
  seed(r, "single", 1);
  const first = notes(await messages(r));
  assert.equal(first.length, 1);
  const lines = first[0].content.split("\n");
  assert.equal(lines[0], DATA_LINE);
  assert.equal(lines.length, 3, "data line, the one entry with count >= 2, the hint");
  assert.match(lines[1], /x3 rule\/blocked subject "guard x"/);
  assert.ok(!first[0].content.includes("single"));
  assert.match(lines[2], /foreman_reports/);
  assert.deepEqual(appended.map((a) => a[0]), [START_NOTE_ENTRY]);
  assert.deepEqual(notes(await messages(r)), [], "not again in the same session");
});

test("start note: texts are cut to 160 characters, at most 5 entry lines, the rest counted", async (t) => {
  const r = await r11Rig(t, {});
  for (let i = 0; i < 7; i++) seed(r, `subject ${i}`, 2, `${"w".repeat(400)}`);
  const [note] = notes(await messages(r));
  const lines = note.content.split("\n");
  assert.equal(lines.length, 1 + 5 + 1);
  assert.match(lines.at(-1)!, /^2 more\. /);
  for (const l of lines.slice(1, 6)) assert.ok(!l.includes("w".repeat(161)), "what is cut");
  assert.ok(lines.slice(1, 6).every((l) => l.includes(`"${"w".repeat(159)}`) || /w{100}/.test(l)));
});

test("start note: the triage hint of the other handler is still delivered in the same turn", async (t) => {
  const r = await r11Rig(t, {}, { piExtra: { appendEntry: () => undefined } });
  seed(r, "guard x", 2);
  const ms = await messages(r, "please check this CI failure of the build, it is flaky");
  assert.equal(notes(ms).length, 1);
  // the handler count: the note's own handler is separate from every other one, so no other message is dropped
  assert.ok(r.handlersOf("before_agent_start").length >= 2);
});

test("start note: absent when nothing qualifies", async (t) => {
  const r = await r11Rig(t, {});
  assert.deepEqual(notes(await messages(r)), [], "no store");
  seed(r, "single", 1);
  assert.deepEqual(notes(await messages(r)), [], "one session only");
});

test("start note: absent with retro.startNote false and with retro.report false", async (t) => {
  for (const retro of [{ startNote: false }, { report: false }]) {
    const r = await r11Rig(t, {}, { config: { retro } });
    seed(r, "guard x", 3);
    assert.deepEqual(notes(await messages(r)), [], JSON.stringify(retro));
  }
});

test("start note: absent in a child session", async (t) => {
  const r = await r11Rig(t, {}, { child: true });
  seed(r, "guard x", 3);
  assert.deepEqual(notes(await messages(r)), []);
});

test("start note: absent in a parent-opened session", async (t) => {
  withEnv(t, "PI_FOREMAN_HANDOFF_DIR", "/nonexistent/handoff");
  const r = await r11Rig(t, {});
  seed(r, "guard x", 3);
  assert.deepEqual(notes(await messages(r)), []);
});

test("start note: not sent again after reload or resume (the session entry exists)", async (t) => {
  const entry = { type: "custom", customType: START_NOTE_ENTRY, data: { v: 1 } };
  const r = await r11Rig(t, {}, { ctx: { sessionManager: { getSessionId: () => "resumed", getSessionFile: () => undefined, getEntries: () => [entry], getBranch: () => [entry] } } });
  seed(r, "guard x", 3);
  assert.deepEqual(notes(await messages(r)), []);
});
