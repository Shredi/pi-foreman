// `foreman pages url` refusals print one stderr line each, nothing on stdout, and exit 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../pages-cli.ts";
import type { CliDeps } from "../pages-cli.ts";

const deps = (): CliDeps => ({
  agentDir: os.tmpdir(),
  pkgRoot: os.tmpdir(),
  now: Date.now,
  loadConfig: async () => ({ ok: true, cfg: { enabled: true, port: 1, bind: "127.0.0.1", baseUrl: "" } as never }),
  ensureDeps: () => { throw new Error("must not start a server"); },
  health: async () => null,
  kill: () => undefined,
  serve: async () => 0,
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, (s) => (out += s), (s) => (err += s), deps);
  return { code, out, err };
}

test("a relative path: one stderr line, exit 1", async () => {
  const r = await run(["url", "relative/plan.html"]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /^page url: .*absolute\n$/);
});

test("an absolute path that is no show page file: one stderr line, exit 1", async () => {
  const r = await run(["url", path.join(os.tmpdir(), "no-such-plan.html")]);
  assert.equal(r.code, 1);
  assert.equal(r.out, "");
  assert.match(r.err, /^page url: not a page file of a show pages\/ folder\n$/);
});
