// readPlan turns a converter throw into a refusal naming the page (checkpoint.ts): the converter is swapped for a throwing stub by a resolve hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";
import { rmTestTmp } from "./_tmpbase.ts";

const STUB = "data:text/javascript," + encodeURIComponent("export const htmlToMarkdown = () => { throw new RangeError('boom'); };");

test("html plan: a converter throw is a readPlan error naming the page, not an exception", async (t) => {
  const h = registerHooks({
    resolve: (specifier, context, next) => (specifier === "./htmlmd.ts" && String(context.parentURL).includes("/checkpoint.ts?") ? { url: STUB, shortCircuit: true } : next(specifier, context)),
  });
  t.after(() => h.deregister());
  const { readPlan } = (await import(String("../checkpoint.ts?converter-throws"))) as typeof import("../checkpoint.ts");
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-html-throw-")));
  t.after(() => rmTestTmp(root));
  const ws = path.join(root, "ws");
  for (const d of [".git", ".workflow/scratch"]) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.writeFileSync(path.join(ws, ".workflow/scratch/plan-widget.html"), "<html><body><h1>W</h1></body></html>");
  const opts = { cwd: ws, home: root, platform: process.platform, scratchDir: ".workflow/scratch" };
  for (const name of ["plan-widget.html", "plan-widget.md"]) {
    const r = readPlan(`.workflow/scratch/${name}`, opts);
    assert.ok("error" in r, "no plan");
    assert.match(r.error, /plan-widget\.html/);
    assert.match(r.error, /boom/);
  }
});
