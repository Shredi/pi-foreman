import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CORE_KEY, READY_EVENT, claimCore, emitReady, installInert, missingBundled, readVersion, setupInvocation } from "../registry.ts";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-registry-")));
const checkout = path.join(tmp, "checkout");
const pkg = path.join(tmp, "agent", "git", "github.com", "o", "pi-foreman");
fs.mkdirSync(checkout, { recursive: true });
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "pi-foreman", version: "1.2.3" }));
fs.writeFileSync(path.join(pkg, "package.json"), "{not json");
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

test("version comes from package.json, 0.0.0 when unreadable", () => {
  assert.equal(readVersion(checkout), "1.2.3");
  assert.equal(readVersion(pkg), "0.0.0");
  assert.equal(readVersion(path.join(tmp, "missing")), "0.0.0");
});

test("first copy claims; a copy from another root is inert and names both roots", () => {
  const g: Record<symbol, unknown> = {};
  const a = claimCore(checkout, g);
  assert.ok(a.active);
  assert.deepEqual(g[CORE_KEY], { version: "1.2.3", pkgRoot: checkout, api: 1 });
  const b = claimCore(pkg, g);
  assert.equal(b.active, false);
  if (b.active) return;
  assert.equal(b.activeRoot, checkout);
  assert.ok(b.notice.includes(checkout) && b.notice.includes(pkg));
  assert.match(b.notice, /docs\/install\.md#developing/);
  assert.match(b.notice, /foreman setup --develop/);
  assert.equal((g[CORE_KEY] as { pkgRoot: string }).pkgRoot, checkout); // claim unchanged
});

test("the same root re-claims (reload re-runs the factory); release frees the key for the next owner", () => {
  const g: Record<symbol, unknown> = {};
  const a = claimCore(checkout, g);
  const again = claimCore(path.join(checkout, "."), g);
  assert.ok(again.active);
  if (a.active) a.release(); // stale owner: does not drop the new claim
  assert.ok(g[CORE_KEY]);
  if (again.active) again.release();
  assert.equal(g[CORE_KEY], undefined);
  assert.ok(claimCore(pkg, g).active);
});

test("inert copy registers one session_start handler that notifies once", async () => {
  const handlers: Record<string, (e: unknown, ctx: unknown) => Promise<void>> = {};
  const notes: [string, string][] = [];
  installInert({ on: ((name: string, h: (e: unknown, ctx: unknown) => Promise<void>) => { handlers[name] = h; }) as never }, "N");
  assert.deepEqual(Object.keys(handlers), ["session_start"]);
  const ctx = { ui: { notify: (m: string, l: string) => notes.push([m, l]) } };
  await handlers.session_start({}, ctx);
  await handlers.session_start({}, ctx);
  assert.deepEqual(notes, [["N", "warning"]]);
});

test("foreman:ready carries version, pkgRoot and api", () => {
  const sent: [string, unknown][] = [];
  emitReady({ emit: (c, d) => sent.push([c, d]), on: () => undefined }, { version: "1.2.3", pkgRoot: checkout, api: 1 });
  assert.deepEqual(sent, [[READY_EVENT, { version: "1.2.3", pkgRoot: checkout, api: 1 }]]);
  assert.equal(READY_EVENT, "foreman:ready");
});

test("/foreman setup runs this node on the package's setup.mjs with the session agent dir", () => {
  const inv = setupInvocation(pkg, "  --dry-run   --no-intercom ", path.join(tmp, "agent"), { PATH: "p", PI_CODING_AGENT_DIR: "other" }, "/n/node");
  assert.equal(inv.command, "/n/node");
  assert.deepEqual(inv.args, [path.join(pkg, "setup.mjs"), "--dry-run", "--no-intercom"]);
  assert.deepEqual(inv.env, { PATH: "p", PI_CODING_AGENT_DIR: path.join(tmp, "agent"), PI_FOREMAN_PICKER: "off" });
  assert.deepEqual(setupInvocation(pkg, "", "a", {}, "n").args, [path.join(pkg, "setup.mjs")]);
});

test("/foreman setup switches the picker off in the child, even when the parent env says force", () => {
  const inv = setupInvocation(pkg, "--profile standard", "a", { PI_FOREMAN_PICKER: "force" }, "n");
  assert.equal(inv.env.PI_FOREMAN_PICKER, "off");
});

test("missingBundled names the bundled packages without a package.json under node_modules", () => {
  const root = path.join(tmp, "bundle");
  assert.deepEqual(missingBundled(root), ["pi-subagents", "pi-intercom"]);
  for (const name of ["pi-subagents"]) {
    fs.mkdirSync(path.join(root, "node_modules", ...name.split("/")), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", ...name.split("/"), "package.json"), "{}");
  }
  assert.deepEqual(missingBundled(root), ["pi-intercom"]);
});

test("missingBundled also checks every ./node_modules manifest entry", () => {
  const root = path.join(tmp, "manifest");
  for (const name of ["pi-subagents", "pi-intercom"]) {
    fs.mkdirSync(path.join(root, "node_modules", ...name.split("/")), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", ...name.split("/"), "package.json"), "{}");
  }
  fs.writeFileSync(path.join(root, "node_modules", "pi-subagents", "index.js"), "");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ pi: { extensions: ["./extensions/core-adapter/index.ts", "./node_modules/pi-subagents/index.js", "./node_modules/pi-intercom/index.ts"], subagents: { agents: ["./agents"] }, skills: ["./node_modules/pi-subagents/skills"] } }),
  );
  assert.deepEqual(missingBundled(root), ["./node_modules/pi-intercom/index.ts", "./node_modules/pi-subagents/skills"]);
});
