// D3b items 14 and 15: the caller path (the real tool_call handler of a child session). A line the parser no longer binds to the harness folder is a judge-first danger class;
// a read-only reviewer's call of that class is refused (no ask dir: denied at once), a builder's call goes to the judge (an `unsure` answer asks the parent, here nobody: denied).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { r11Rig } from "./_r11rig.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { posixOnly } from "./_platform.ts";

// pi-subagents resolves the global npm root with `npm root -g` on the first skill lookup; PI_OFFLINE makes that return null without starting npm.
const savedOffline = process.env.PI_OFFLINE;
before(() => {
  process.env.PI_OFFLINE = "1";
});
after(() => {
  if (savedOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedOffline;
});

type T = Parameters<typeof r11Rig>[0];
const ASK = JSON.stringify({ verdict: "unsure", reason: "cannot tell" });
const registry = () => ({ find: () => ({ id: "m" }), getProviderAuthStatus: () => ({ configured: false }), complete: async () => ({ content: [{ type: "text", text: ASK }], stopReason: "stop", usage: { input: 1, output: 1 } }) });
const config = { gate: { askTimeoutMs: 600000 }, presence: { enabled: false }, providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(["explorer", "builder", "reviewer"].map((r) => [r, { model: `fake/${r}` }])) } } };

async function childOf(t: T, role: string) {
  const dir = fs.realpathSync(mkTestTmp("pf-d3b-caller-"));
  t.after(() => rmTestTmp(dir));
  const scratch = path.join(dir, "scratch");
  const out = path.join(dir, "out");
  for (const d of [scratch, out]) fs.mkdirSync(d, { recursive: true });
  const prev = process.env[BINDINGS_ENV];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role, launchId: "L9", kind: "first", model: null, scratch, out } });
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
  });
  return r11Rig(t, {}, { ctx: { modelRegistry: registry() }, config, child: true });
}

const clearing = (n: string): string[] => [`env -i sh -c 'rm -rf $${n}/x'`, `env - sh -c 'rm -rf $${n}/x'`, `env -i -- bash -c 'rm -rf $${n}/x'`, `exec -c bash -c 'rm -rf $${n}/x'`, `env -u ${n} sh -c 'rm -rf $${n}/x'`];
const quoted = (n: string): string[] => [`printf -v ${n.slice(0, -1)}'${n.slice(-1)}' %s ~; rm -rf $${n}/Documents`, `${n.slice(0, -1)}\\${n.slice(-1)}=/etc; rm -rf $${n}/x`, `sh -c 'printf -v ${n.slice(0, -1)}'"'"'${n.slice(-1)}'"'"' %s ~; rm -rf $${n}/x'`];

for (const role of ["reviewer", "builder"]) {
  test(`caller path (${role}): env-clearing wrapper and quoted rebind shapes are not run`, { skip: posixOnly }, async (t) => {
    const child = await childOf(t, role);
    for (const n of ["FOREMAN_OUT", "FOREMAN_SCRATCH"]) {
      for (const command of [...clearing(n), ...quoted(n)]) {
        const res = await child.call("bash", { command });
        assert.equal(res?.block, true, `${role}: ${command}`);
      }
    }
  });
}

test("caller path (builder): a plain $FOREMAN_OUT delete still runs", { skip: posixOnly }, async (t) => {
  const child = await childOf(t, "builder");
  assert.equal(await child.call("bash", { command: "rm -rf $FOREMAN_OUT/x" }), undefined);
  assert.equal(await child.call("bash", { command: "env FOO=1 sh -c 'rm -rf $FOREMAN_OUT/x'" }), undefined);
});
