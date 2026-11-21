// D130 for the two guard dialogs of the adapter (the session's own, and the approval for a child run's call): the open-dialog file written while the
// dialog is open keeps the tool and the call summary; an aborted own dialog stores `lastAnswer` outcome dismissed, never answered; the re-ask after the
// restart names the tool. The real adapter over the r11 rig.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { liveDir } from "../livestate.ts";
import { openDialogFile, readOpenDialogs, reAskText } from "../opendialog.ts";
import { childAskDir, writeChildAsk } from "../childask.ts";

type T = Parameters<typeof r11Rig>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<X>(f: () => X | undefined | false, ms = 4000): Promise<X> {
  for (let i = 0; i < ms / 10; i++) {
    const v = f();
    if (v) return v;
    await sleep(10);
  }
  throw new Error("timed out");
}
const ESCALATE = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });
const registry = (reply: string) => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const config = { presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: { builder: { model: "fake/builder" } } } } };
/** A select that never answers: it ends only through the abort signal (`undefined`, a dismissal). */
const hanging = (opened: string[]) => (title: string, _o: string[], opts?: { signal?: AbortSignal }) => {
  opened.push(title);
  return new Promise<string | undefined>((res) => opts?.signal?.addEventListener("abort", () => res(undefined), { once: true }));
};
const ui = (select: unknown) => ({ notify: () => undefined, confirm: async () => false, select, input: async () => undefined, setStatus: () => undefined, setWidget: () => undefined });
const stored = (agentDir: string, id: string) => readOpenDialogs(agentDir, id);
const lastAnswer = (agentDir: string): { kind?: string; outcome?: string } | undefined => {
  const dir = liveDir(agentDir);
  const f = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  return (JSON.parse(fs.readFileSync(path.join(dir, f[0]), "utf8")) as { lastAnswer?: { kind?: string; outcome?: string } }).lastAnswer;
};

test("the session's own guard dialog, aborted by the call: the file keeps tool and summary while open; lastAnswer is dismissed, not answered", async (t: T) => {
  const opened: string[] = [];
  const r = await r11Rig(t, {}, { ctx: { ui: ui(hanging(opened)), modelRegistry: registry(ESCALATE) }, config });
  const ac = new AbortController();
  (r.ctx as { signal?: AbortSignal }).signal = ac.signal;
  const pending = r.call("bash", { command: "git branch -D old-branch" });
  const open = await until(() => stored(r.agentDir, r.sessionId)[0]);
  assert.equal(open.kind, "approval");
  assert.equal(open.tool, "bash");
  assert.match(open.summary ?? "", /git branch -D old-branch/);
  ac.abort();
  await pending;
  assert.equal(fs.existsSync(openDialogFile(r.agentDir, r.sessionId)), false, "the dismissal ends the record");
  await until(() => lastAnswer(r.agentDir));
  assert.equal(lastAnswer(r.agentDir)?.outcome, "dismissed");
});

test("the approval dialog for a child run's call: the file keeps tool and summary; the shutdown keeps it and the re-ask names the tool", async (t: T) => {
  const opened: string[] = [];
  const r = await r11Rig(t, {}, { ctx: { ui: ui(hanging(opened)), modelRegistry: registry(ESCALATE) }, config });
  const input: Record<string, unknown> = { agent: "builder", task: "go" };
  await r.launch(input);
  const bindings = input.extensionBindings as Record<string, { askDir?: string; launchId?: string }>;
  const askDir = Object.values(bindings).find((b) => b?.askDir)?.askDir ?? childAskDir(r.agentDir, r.sessionId, "L9");
  writeChildAsk(askDir, { tool: "bash", payload: "pip install requests", cwd: "/w", session: "child-s", cause: "ask", reason: "r", role: "builder", run: "L9" });
  const open = await until(() => stored(r.agentDir, r.sessionId)[0]);
  assert.equal(open.tool, "bash");
  assert.match(open.summary ?? "", /pip install requests/);
  await r.fire("session_shutdown", {});
  await sleep(50);
  const kept = stored(r.agentDir, r.sessionId);
  assert.equal(kept.length, 1, "a dialog cut off by the shutdown stays for the restart");
  assert.equal(kept[0].tool, "bash");
  assert.match(reAskText(kept), /call to bash \(pip install requests\)/);
});
