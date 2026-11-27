// convertBriefPage turns a converter throw into brief_unconvertible naming the page: the converter is swapped for a throwing stub by a resolve hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerHooks } from "node:module";
import { trackedTmp } from "./_tmpbase.ts";

const STUB = "data:text/javascript," + encodeURIComponent("export const htmlToMarkdown = () => { throw new RangeError('boom'); }; export const mermaidPres = () => [];");

test("a converter throw is brief_unconvertible, not an exception", async (t) => {
  const h = registerHooks({
    resolve: (specifier, context, next) => (specifier === "./htmlmd.ts" && String(context.parentURL).includes("/briefpage.ts?") ? { url: STUB, shortCircuit: true } : next(specifier, context)),
  });
  t.after(() => h.deregister());
  const { convertBriefPage } = (await import(String("../briefpage.ts?converter-throws"))) as typeof import("../briefpage.ts");
  const file = path.join(fs.realpathSync.native(trackedTmp("pf-briefpage-throw-")), "x.html");
  fs.writeFileSync(file, "<h1>X</h1>");
  const r = await convertBriefPage(file);
  assert.ok("error" in r);
  assert.equal(r.error, "brief_unconvertible");
  assert.match(r.message, /x\.html/);
  assert.match(r.message, /boom/);
});
