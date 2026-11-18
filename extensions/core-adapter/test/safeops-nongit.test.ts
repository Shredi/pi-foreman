// D33 (b): foreman_move and foreman_copy work in a workspace that is not a git repository, limited to the session working folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerSafeOps, SAFE_OP_TOOLS } from "../safeops.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { rmTestTmp } from "./_tmpbase.ts";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "safe_ops.py");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown>; isError?: boolean }> };

test("safeops: the move and copy descriptions name the non-git working folder", () => {
  for (const name of ["foreman_move", "foreman_copy"]) assert.match(SAFE_OP_TOOLS.find((t) => t.name === name)!.description, /session working folder without git/);
});

test("safeops: foreman_move and foreman_copy in a non-git folder work inside it and refuse a destination outside", { skip: !py.ok ? "no Python >= 3.13" : false }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-safeops-nogit-")));
  try {
    const cwd = path.join(tmp, "plain");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "a.txt"), "x");
    const tools = new Map<string, Tool>();
    registerSafeOps({ registerTool: (t: unknown) => void tools.set((t as Tool).name, t as Tool) } as never, {
      isChild: false,
      session: async () => ({ python: py.ok ? py.info.executable : null, isChild: false, opsConfig: {}, trace: () => undefined }),
      script: SCRIPT,
      spawner: defaultSpawner,
      env: () => ({ PATH: process.env.PATH ?? "" }),
    } as never);
    const call = (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id1", params, undefined, undefined, { cwd });
    const moved = await call("foreman_move", { src: "a.txt", dst: "b.txt" });
    assert.equal(moved.isError, undefined, moved.content[0].text);
    assert.equal(fs.readFileSync(path.join(cwd, "b.txt"), "utf8"), "x");
    const copied = await call("foreman_copy", { src: "b.txt", dst: "c.txt" });
    assert.equal(copied.isError, undefined, copied.content[0].text);
    assert.equal(fs.readFileSync(path.join(cwd, "c.txt"), "utf8"), "x");
    const out = await call("foreman_copy", { src: "b.txt", dst: "../escaped.txt" });
    assert.equal(out.isError, true);
    assert.equal(out.details.precondition, "outside_workspace");
    assert.equal(fs.existsSync(path.join(tmp, "escaped.txt")), false);
  } finally {
    rmTestTmp(tmp);
  }
});
