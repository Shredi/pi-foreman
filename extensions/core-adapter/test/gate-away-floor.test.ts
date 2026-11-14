// PR A (perms-fix) ledger 7: away mode. A deterministic floor decision (deny, or an allow) never probes the owner's presence and is never turned into an
// away-deny; the away text applies only to a real ask (a dialog or a child ask: presencewait.ts, index.ts decideByDialog). The real tool_call handler
// runs with presence on and `presence.command` stubbed to a script that records each probe and reports a long idle time (away).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { OWNER_AWAY_TEXT } from "../presencewait.ts";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

async function awayRig(t: { after(fn: () => void | Promise<void>): void }, child: boolean, ctx?: Record<string, unknown>) {
  const dir = fs.realpathSync(mkTestTmp("pf-away-"));
  t.after(() => rmTestTmp(dir));
  const log = path.join(dir, "probes.log");
  const script = path.join(dir, "probe.cjs"); // node, not sh: the probe also has to run under cmd.exe
  fs.writeFileSync(script, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "probe\\n");\nconsole.log(99999);\n`);
  const command = `"${process.execPath}" "${script}"`;
  const r = await r11Rig(t, {}, { child, ...(ctx ? { ctx } : {}), config: { presence: { enabled: true, awayAfterMinutes: 1, command } } });
  const probes = (): number => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
  return { r, probes };
}

for (const child of [false, true]) {
  const who = child ? "child" : "owner";
  test(`away (${who}): a floor deny runs no presence probe and keeps its own reason`, async (t) => {
    const { r, probes } = await awayRig(t, child);
    const before = probes();
    for (const command of ["git push --force origin main", "sudo id", "cat ~/.ssh/id_rsa"]) {
      const res = await r.call("bash", { command });
      assert.equal(res?.block, true, command);
      assert.ok(!(res?.reason ?? "").includes(OWNER_AWAY_TEXT), `${command}: ${res?.reason}`);
      assert.ok(!/owner is away|no input for a while/.test(res?.reason ?? ""), `${command}: ${res?.reason}`);
    }
    assert.equal(probes(), before, "a deterministic deny never probes");
    assert.deepEqual(r.events("dialog"), []);
  });

  test(`away (${who}): a built-in read allow runs no presence probe and is not blocked`, async (t) => {
    const { r, probes } = await awayRig(t, child);
    const before = probes();
    const res = await r.call("bash", { command: "ls -la" });
    assert.equal(res, undefined);
    assert.equal(probes(), before);
  });
}

test("away (owner): a real ask opens the dialog and the owner's answer applies; the away text is never the deny", async (t) => {
  const opened: string[] = [];
  const answers = ["allow once", undefined];
  const ui = { notify: () => undefined, confirm: async () => false, setStatus: () => undefined, setWidget: () => undefined, select: async (title: string) => (opened.push(title), answers.shift()), input: async () => undefined };
  const { r } = await awayRig(t, false, { ui });
  const keepAlive = setInterval(() => undefined, 50); // the probe child is detached on posix, attached on win32, and unref'd: hold the loop while the gate awaits it
  try {
    assert.equal(await r.call("bash", { command: "npm install left-pad" }), undefined);
    assert.equal(opened.length, 1, "the dialog opened although the sample says away");
    const res = await r.call("bash", { command: "npm install right-pad" });
    assert.equal(res?.block, true, "a dismissed dialog still denies");
    assert.match(res?.reason ?? "", /denied by the user/);
    assert.ok(!(res?.reason ?? "").includes(OWNER_AWAY_TEXT));
  } finally {
    clearInterval(keepAlive);
  }
});
