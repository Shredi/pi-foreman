// A child whose launch role is an overlay-style name (not a built-in role): its `foreman_report` row is stored with that role, and the row passes the import
// (the role is checked by shape, reportsimport.ts, not by a list). The rig is the one of reports-tool.test.ts; the temp project has no repository, so the stored
// row gets one before it goes through the import, as a remote child's row would carry its own.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readRows, storeFor } from "../reports.ts";
import { importText } from "../reportsimport.ts";
import { realPath } from "../workspacekey.ts";
import { BINDINGS_ENV, BINDING_NS } from "../usage.ts";
import { r11Rig } from "./_r11rig.ts";

process.env.PI_OFFLINE = "1";

const CACHE = Symbol.for("pi-foreman.launch-binding");
type Res = { content: { text: string }[]; isError?: boolean };
type Tool = { execute: (...a: unknown[]) => Promise<Res> };

test("a planner child's report is stored with role planner and the row passes the import", async (t) => {
  const savedBinding = process.env[BINDINGS_ENV];
  t.after(() => {
    if (savedBinding === undefined) delete process.env[BINDINGS_ENV];
    else process.env[BINDINGS_ENV] = savedBinding;
    delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  });
  delete (globalThis as unknown as Record<symbol, unknown>)[CACHE];
  process.env[BINDINGS_ENV] = JSON.stringify({ [BINDING_NS]: { foremanSession: "parent-session", role: "planner", launchId: "run-1", kind: "first", workspace: "", model: null } });
  const tools = new Map<string, Tool>();
  const r = await r11Rig(t, {}, {
    child: true,
    config: { presence: { enabled: false } },
    piExtra: {
      registerTool: (d: { name: string } & Tool) => void tools.set(d.name, d),
      registerCommand: () => undefined,
      getActiveTools: () => ["foreman_report", "read"],
      setActiveTools: () => undefined,
    },
  });
  const res = await tools.get("foreman_report")!.execute("id", { kind: "rule", subject: "guard x", what: "it blocked a read", effect: "blocked" }, undefined, undefined, r.ctx);
  assert.ok(!res.isError, res.content.map((c) => c.text).join("\n"));
  const [stored] = readRows(storeFor(r.project).file);
  assert.equal(stored.role, "planner");
  assert.equal(stored.session, "parent-session");

  const dir = realPath(fs.mkdtempSync(path.join(os.tmpdir(), "pf-overlay-role-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = storeFor(dir);
  const text = JSON.stringify({ ...stored, repo: "acme/app" }) + "\n";
  const c = importText(store, "acme/app", text, Date.now());
  assert.equal(c.added, 1, JSON.stringify(c));
  assert.equal(readRows(store.file)[0].role, "planner");
});
