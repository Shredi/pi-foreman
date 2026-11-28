// remote-asks plan D10 / rulings R-1..R-3: a protected host in a remote-runner line gets the protected check (per mode and per shape), a protected allow goes on to the
// main judge (fixed limits), an unprotected host goes the normal way, the away flag refuses. Placeholders only (`rt`, `prod-1.example.net`, `host-a`).
process.env.PI_OFFLINE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { r11Rig, RIG_PERMISSIONS } from "./_r11rig.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { effectCtx } from "../effects.ts";
import { matchProtected } from "../protected.ts";
import type { ProtectedMatch } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import { parseShell } from "../shellast.ts";
import type { RuleCall } from "../rulecall.ts";
import { judgeSystemPrompt } from "../classifier.ts";
import { posixOnly } from "./_platform.ts";

type T = Parameters<typeof r11Rig>[0];
const HOST = "prod-1.example.net";
const PERMS = { protected: [{ host: "prod-*.example.net" }] };
const reply = (o: Record<string, unknown>): string => JSON.stringify(o);
const WRITE_ALLOW = reply({ verdict: "allow", effect: "write", confidence: "high", entry: null, reason: "restarts the service" });
const READ_ALLOW = reply({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "only reads" });
const CLEAR = reply({ verdict: "clear", reason: "asked for by the task" });
const REFUSE = reply({ verdict: "refuse", reason: "deletes outside the work folder" });
const OWNER = reply({ verdict: "owner", class: "outside-write", reason: "deletes outside the work folder" });
const text = (t: string) => ({ content: [{ type: "text", text: t }], stopReason: "stop", usage: { input: 1, output: 1 } });

interface Opts {
  mode?: "model" | "read-only" | "ask";
  prot?: string;
  main?: string;
  child?: boolean;
  noRoute?: boolean;
  hasUI?: boolean;
}
async function rig(t: T, o: Opts = {}) {
  const prot: string[] = [];
  const main: string[] = [];
  const mainSystem: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, c: { systemPrompt?: string; messages: { content: string }[] }) => {
      if (c.systemPrompt?.includes("protected-target check")) {
        prot.push(c.messages[0].content);
        return text(o.prot ?? WRITE_ALLOW);
      }
      main.push(c.messages[0].content);
      mainSystem.push(c.systemPrompt ?? "");
      return text(o.main ?? CLEAR);
    },
  };
  const isChild = o.child !== false;
  const askDir = !isChild || o.noRoute ? null : fs.mkdtempSync(path.join(os.tmpdir(), "pf-rapr-ask-"));
  const prev = process.env[BINDINGS_ENV];
  if (isChild) process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-s", workspace: "", role: "builder", launchId: "L9", kind: "first", model: null, ...(askDir ? { askDir } : {}) } });
  else delete process.env[BINDINGS_ENV];
  t.after(() => {
    if (prev === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = prev;
    if (askDir) fs.rmSync(askDir, { recursive: true, force: true });
  });
  const roles = ["explorer", "builder", "reviewer"];
  const config = { providers: { fake: { review: { model: "m" }, roles: Object.fromEntries(roles.map((r) => [r, { model: `fake/${r}` }])) } }, presence: { enabled: false }, gate: { ...(o.mode ? { protected: { check: o.mode } } : {}) } };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ...(o.hasUI !== undefined ? { hasUI: o.hasUI } : {}), [RIG_PERMISSIONS]: PERMS }, config, child: isChild });
  const asked = (): boolean => !!askDir && fs.existsSync(path.join(askDir, "ask.md"));
  /** The call, the owner question answered with a deny when one is raised; the result and whether it was asked. */
  const run = async (command: string): Promise<{ res: { block?: boolean; reason?: string } | undefined; asked: boolean }> => {
    const p = r.call("bash", { command }) as Promise<{ block?: boolean; reason?: string } | undefined>;
    let wasAsked = false;
    const watch = (async () => {
      for (let i = 0; i < 200 && !wasAsked; i++) {
        if (asked()) {
          wasAsked = true;
          fs.writeFileSync(path.join(askDir as string, "ruling-1.md"), "DENY\nnot this one\n");
        } else await new Promise((res) => setTimeout(res, 10));
      }
    })();
    const res = await p;
    wasAsked = wasAsked || asked();
    await watch;
    return { res, asked: wasAsked };
  };
  const pc = () => r.events("protected_check") as Record<string, unknown>[];
  return { ...r, prot, main, mainSystem, run, pc };
}

const SHAPES = (host: string): [string, string][] => [
  ["rt exec", `rt exec --on ${host} -- sudo systemctl restart app`],
  ["rt run", `rt run --on ${host} -- sudo systemctl restart app`],
  ["ssh", `ssh ${host} 'sudo systemctl restart app'`],
];

test("R-3: a service restart on a protected host, mode model: the protected check decides, then the main judge; per runner shape", { skip: posixOnly }, async (t) => {
  for (const [name, line] of SHAPES(HOST)) {
    const r = await rig(t, { mode: "model" });
    const { res, asked } = await r.run(line);
    assert.equal(res, undefined, name);
    assert.equal(asked, false, name);
    assert.equal(r.prot.length, 1, `${name}: one protected check`);
    assert.deepEqual([r.pc()[0].accepted, r.pc()[0].mode], ["allow", "model"], name);
    assert.equal(r.main.length, 1, `${name}: then the main judge (fixed limits)`);
  }
});

test("R-3: the same restart on a protected host in mode read-only and mode ask reaches the owner, no main judge", { skip: posixOnly }, async (t) => {
  for (const mode of ["read-only", "ask"] as const) {
    for (const [name, line] of SHAPES(HOST)) {
      const r = await rig(t, { mode });
      const { res, asked } = await r.run(line);
      assert.equal(asked, true, `${mode} ${name}`);
      assert.equal(res?.block, true, `${mode} ${name}`);
      assert.deepEqual([r.pc()[0].accepted, r.pc()[0].cause], ["ask", mode === "ask" ? "mode" : "read_only"], `${mode} ${name}`);
      assert.equal(r.main.length, 0, `${mode} ${name}`);
    }
  }
});

test("R-3: the same shapes with an unprotected host get no protected check; sudo (or ssh) reaches the main judge, no sudo goes ahead unseen", { skip: posixOnly }, async (t) => {
  for (const [name, line] of SHAPES("host-a")) {
    const r = await rig(t, { mode: "model" });
    const { res, asked } = await r.run(line);
    assert.equal(res, undefined, name);
    assert.equal(asked, false, name);
    assert.equal(r.pc().length, 0, `${name}: no protected check`);
    assert.equal(r.prot.length, 0, name);
    assert.equal(r.main.length, 1, `${name}: the main judge`);
  }
  const r = await rig(t, { mode: "model" });
  assert.equal((await r.run("rt exec --on host-a -- systemctl restart app")).res, undefined);
  assert.equal(r.prot.length + r.main.length, 0, "goes ahead unseen");
});

test("R-1: --on=host matches; a protected host in an unknown-program line is checked first", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "ask" });
  const { asked } = await r.run(`rt exec --on=${HOST} -- sudo systemctl restart app`);
  assert.equal(asked, true);
  assert.equal(r.pc().length, 1);
});

test("a protected allow goes on to the main judge: a refusal refuses, the protected allow is a recorded step", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "model", main: REFUSE });
  const { res, asked } = await r.run(`rt exec --on ${HOST} -- rm -rf /srv/app`);
  assert.equal(r.pc()[0].accepted, "allow");
  assert.equal(r.main.length, 1);
  assert.equal(asked, false, "a refusal asks nobody");
  assert.equal(res?.block, true);
  assert.match(String(res?.reason), /judge/);
});

test("a protected allow goes on to the main judge: an owner answer asks the owner (fixed limit on a protected host)", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "model", main: OWNER });
  const { res, asked } = await r.run(`rt exec --on ${HOST} -- rm -rf /srv/app`);
  assert.equal(r.pc()[0].accepted, "allow");
  assert.equal(r.main.length, 1);
  assert.equal(asked, true);
  assert.equal(res?.block, true);
});

test("a protected allow and a main judge that clears runs the call; the main judge reads no files", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "model", main: CLEAR });
  assert.equal((await r.run(`rt exec --on ${HOST} -- rm -rf /srv/app`)).res, undefined);
  assert.equal(r.main.length, 1);
  assert.equal(r.mainSystem[0], judgeSystemPrompt(false), "the prompt without the file-reading rule");
});

test("a remote write that the protected check rates as a read asks the owner (remote_write)", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "model", prot: READ_ALLOW });
  const { res, asked } = await r.run(`rt exec --on ${HOST} -- touch /srv/app/x`);
  assert.equal(asked, true);
  assert.equal(res?.block, true);
  assert.deepEqual([r.pc()[0].accepted, r.pc()[0].cause], ["ask", "remote_write"]);
  assert.equal(r.main.length, 0);
});

test("away: a child with no route to its parent and a session with no window are refused on a write allow", { skip: posixOnly }, async (t) => {
  const child = await rig(t, { mode: "model", noRoute: true });
  const a = await child.run(`rt exec --on ${HOST} -- sudo systemctl restart app`);
  assert.deepEqual([child.pc()[0].away, child.pc()[0].cause], [true, "away"]);
  assert.equal(a.res?.block, true);
  const owner = await rig(t, { mode: "model", child: false, hasUI: false });
  const b = await owner.run(`rt exec --on ${HOST} -- sudo systemctl restart app`);
  assert.deepEqual([owner.pc()[0].away, owner.pc()[0].cause], [true, "away"]);
  assert.equal(b.res?.block, true);
  assert.equal(owner.main.length, 0);
});

test("an owner session with a window: the protected allow, then the normal path (the main judge clears)", { skip: posixOnly }, async (t) => {
  const r = await rig(t, { mode: "model", child: false, hasUI: true });
  const { res } = await r.run(`rt exec --on ${HOST} -- sudo systemctl restart app`);
  assert.equal(res, undefined);
  assert.deepEqual([r.pc()[0].away, r.pc()[0].accepted], [false, "allow"]);
  assert.equal(r.main.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The match itself (R-1..R-3 shapes)

const cwd = process.cwd();
const env = { home: path.join(cwd, "pf-rapr", "home"), platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entries: ProtectedEntry[] = [{ id: "P1", kind: "host", glob: "prod-*.example.net", source: "user" }];
const sh = (line: string): ProtectedMatch | null => {
  const segments = parseShell(line, { cwd });
  return matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
};

test("a known program is not searched: a commit message, a folder and a remote named like the host do not match", { skip: posixOnly }, () => {
  assert.equal(sh(`git commit -m 'note about ${HOST}'`), null);
  assert.equal(sh(`mkdir ${HOST}`), null);
  assert.equal(sh(`git push ${HOST} feature`), null);
});

test("an unreadable payload behind the runner: a variable payload is local_opaque, a payload fed from a file is remote_opaque, a quoted one goes to the check", { skip: posixOnly }, () => {
  const v = sh(`rt exec --on ${HOST} -- bash -c "$X"`);
  assert.equal(v?.opaque, true);
  const f = sh(`rt exec --on ${HOST} -- sh -s < x.sh`);
  assert.equal(f?.remoteOpaque, true);
  const q = sh(`rt exec --on ${HOST} -- 'bash -c "$X"'`);
  assert.ok(q);
  assert.deepEqual([q.opaque, q.remoteOpaque], [false, false]);
  const s = sh(`ssh ${HOST} 'bash -c "$X"'`);
  assert.ok(s);
  assert.deepEqual([s.opaque, s.remoteOpaque], [false, false]);
});

test("a path that starts with the host name matches, even behind another host", { skip: posixOnly }, () => {
  const m = sh(`rt exec --on host-a -- ls ${HOST}/logs`);
  assert.ok(m);
  assert.ok(m.remoteClasses.includes("read"));
});

test("a remote write is seen as a write class", { skip: posixOnly }, () => {
  assert.ok(sh(`rt exec --on ${HOST} -- touch /srv/app/x`)?.remoteClasses.includes("write-out"));
});
