// Owner allow sentences, step 1 through the real gate: the judge gets the sentences, a cited sentence is logged (trace label, gate-log field, also on a cache
// hit), the fixed limits are decided in code before the judge (no judge call, a sentence changes nothing), and `/foreman perms list` shows A# lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allowHash } from "../permconfig.ts";
import { RIG_PERMISSIONS, gateOutcome, r11Rig } from "./_r11rig.ts";

const SENTENCE = "Restarting services on host.example.net is fine when the task asks for it.";
const config = { providers: { fake: { review: { model: "m" }, roles: { explorer: { model: "fake/e" }, builder: { model: "fake/b" }, reviewer: { model: "fake/r" } } } }, presence: { enabled: false } };

function judge(reply: string) {
  const prompts: { system: string; text: string }[] = [];
  const registry = { find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async (_m: unknown, req: { systemPrompt: string; messages: { content: string }[] }) => { prompts.push({ system: req.systemPrompt, text: req.messages[0].content }); return { content: [{ type: "text", text: reply }], stopReason: "stop", usage: { input: 1, output: 1 } }; } };
  return { prompts, registry };
}
const CITE_A1 = JSON.stringify({ verdict: "clear", reason: "covered by A1", sentence: "A1" });
const gateRows = (agentDir: string): Record<string, unknown>[] => {
  const f = path.join(agentDir, "pi-foreman", "state", "gate", "log.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};
const REMOTE = "ssh host.example.net 'systemctl restart example'";

test("a judge clear that cites A1 runs the call; trace label judge:<danger>:sentence:A1; gate log sentence A1#<hash>; the judge got the sentence", async (t) => {
  const j = judge(CITE_A1);
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry, [RIG_PERMISSIONS]: { classifier: { allow: [SENTENCE] } } }, config });
  const before = r.trace().length;
  assert.equal(await r.call("bash", { command: REMOTE }), undefined);
  assert.equal(j.prompts.length, 1);
  assert.ok(j.prompts[0].text.includes(SENTENCE) && j.prompts[0].text.includes("A1:"));
  assert.match(j.prompts[0].system, /standing approvals/);
  assert.equal(gateOutcome(r.trace().slice(before)), "allowed:judge:danger-remote:sentence:A1");
  const row = gateRows(r.agentDir).find((x) => x.layer === "classifier" && x.verdict === "allow");
  assert.ok(row, "classifier row");
  assert.deepEqual([row.rule, row.sentence], ["judge", `A1#${allowHash(SENTENCE)}`]);
  // the identical call: a cache hit keeps naming the sentence
  const mid = r.trace().length;
  assert.equal(await r.call("bash", { command: REMOTE }), undefined);
  assert.equal(j.prompts.length, 1, "cache hit");
  assert.equal(gateOutcome(r.trace().slice(mid)), "allowed:judge:danger-remote:sentence:A1");
  const hit = gateRows(r.agentDir).filter((x) => x.layer === "cache" && x.verdict === "allow").at(-1);
  assert.equal(hit?.sentence, `A1#${allowHash(SENTENCE)}`);
});

test("without sentences the judge call is as before: no section, no sentence label or log field", async (t) => {
  const j = judge(JSON.stringify({ verdict: "clear", reason: "ok" }));
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry }, config });
  const before = r.trace().length;
  assert.equal(await r.call("bash", { command: REMOTE }), undefined);
  assert.doesNotMatch(j.prompts[0].text, /allow sentences/);
  assert.equal(gateOutcome(r.trace().slice(before)), "allowed:judge:danger-remote");
  assert.equal(gateRows(r.agentDir).some((x) => "sentence" in x), false);
});

test("a sentence file edited between calls: the next identical call goes to the judge again", async (t) => {
  const j = judge(CITE_A1);
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry, [RIG_PERMISSIONS]: { classifier: { allow: [SENTENCE] } } }, config });
  await r.call("bash", { command: REMOTE });
  fs.writeFileSync(path.join(r.agentDir, "pi-foreman", "permissions.json"), JSON.stringify({ classifier: { allow: [SENTENCE, "Another sentence."] } }));
  await r.call("bash", { command: REMOTE });
  assert.equal(j.prompts.length, 2);
  assert.ok(j.prompts[1].text.includes("A2:"));
});

test("a credential read and a push to the default branch are denied by the floors with a sentence present: no judge call", async (t) => {
  const j = judge(CITE_A1);
  const broad = "Reading credentials and pushing to main is fine.";
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry, [RIG_PERMISSIONS]: { classifier: { allow: [broad] } } }, config });
  for (const command of ["cat ~/.ssh/id_rsa", "cat ~/.aws/credentials", "git push --force origin feature", "git push origin main"]) {
    const res = await r.call("bash", { command });
    assert.ok(res?.block, `${command}: blocked`);
  }
  assert.equal(j.prompts.length, 0, "no judge call for a fixed limit");
});

test("the permission files stay protected from agent writes with sentences configured", async (t) => {
  const j = judge(CITE_A1);
  const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry, [RIG_PERMISSIONS]: { classifier: { allow: [SENTENCE] } } }, config });
  const user = path.join(r.agentDir, "pi-foreman", "permissions.json");
  const project = path.join(r.project, ".workflow", "permissions.json");
  for (const file of [user, project]) {
    assert.ok((await r.call("write", { path: file, content: '{"classifier":{"allow":["Anything."]}}' }))?.block, `write ${file}`);
    assert.ok((await r.call("edit", { path: file, edits: [{ oldText: "a", newText: "b" }] }))?.block, `edit ${file}`);
    assert.ok((await r.call("bash", { command: `echo '{}' > ${file}` }))?.block, `redirect ${file}`);
  }
});

test("in the main session a plain overwrite outside the session's folders runs without a judge call, with and without sentences (today's default)", async (t) => {
  const outside = path.join(os.homedir(), "pf-allow-sentences-outside.txt").split(path.sep).join("/");
  for (const perms of [{}, { classifier: { allow: [SENTENCE] } }]) {
    const j = judge(JSON.stringify({ verdict: "refuse", reason: "never reached" }));
    const r = await r11Rig(t, {}, { ctx: { hasUI: false, modelRegistry: j.registry, [RIG_PERMISSIONS]: perms }, config });
    const res = await r.call("bash", { command: `echo hi > '${outside}'` });
    assert.equal(res, undefined, JSON.stringify(perms));
    assert.equal(j.prompts.length, 0);
  }
});

test("/foreman perms list shows A# lines before the D# lines; without sentences the output has no A line", async (t) => {
  let command: ((a: string, c: unknown) => Promise<void> | void) | undefined;
  const run = async (perms: unknown): Promise<string> => {
    const notes: string[] = [];
    const r = await r11Rig(t, {}, {
      ctx: { [RIG_PERMISSIONS]: perms, ui: { notify: (m: string) => void notes.push(m), confirm: async () => false, select: async () => undefined, setStatus: () => undefined, setWidget: () => undefined } },
      config: { presence: { enabled: false } },
      piExtra: { registerCommand: (name: string, def: { handler: (a: string, c: unknown) => Promise<void> | void }) => { if (name === "foreman") command = def.handler; } },
    });
    notes.length = 0;
    await command!("perms list", r.ctx);
    return notes.join("\n");
  };
  const withBoth = await run({ classifier: { allow: [SENTENCE, "Second one."], deny: ["Never touch prod."] } });
  const lines = withBoth.split("\n");
  assert.deepEqual(lines.slice(0, 3), [`A1: ${SENTENCE} (user)`, "A2: Second one. (user)", "D1: Never touch prod. (user)"]);
  const none = await run({ classifier: { deny: ["Never touch prod."] } });
  assert.equal(none, "D1: Never touch prod. (user)");
});
