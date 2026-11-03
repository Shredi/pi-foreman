// A10 (perms-fix): the nine logged gate-error decisions (shapes redacted into tests/fixtures/gate-error-lines.json). Each line carries a
// grep/sed pattern word with an unbalanced `[` inside a for loop, `$(...)` or pipeline. The logged failures came from floors.ts `globRe`
// (a command word compiled into a RegExp), replaced by glob.ts before this round; this pins the bash tool handler path (the catch in
// index.ts tool_call that logs `gate-error`), as an owner session and as a child, so a command word never reaches `new RegExp` again.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { r11Rig, reviewAllowOpts } from "./_r11rig.ts";

const LINES: string[] = JSON.parse(fs.readFileSync(new URL("../../../tests/fixtures/gate-error-lines.json", import.meta.url), "utf8"));

for (const child of [false, true]) {
  test(`gate-error shapes: the bash handler logs no gate-error (${child ? "child" : "owner"})`, async (t) => {
    const r = await r11Rig(t, {}, { ...reviewAllowOpts(), child });
    const Real = globalThis.RegExp;
    const bad: string[] = [];
    globalThis.RegExp = new Proxy(Real, {
      construct(tg, args, nt) {
        try {
          return Reflect.construct(tg, args, nt);
        } catch (e) {
          bad.push(`${String(args[0])}: ${(e as Error).message}`);
          throw e;
        }
      },
    });
    try {
      for (const command of LINES) await r.call("bash", { command });
    } finally {
      globalThis.RegExp = Real;
    }
    assert.deepEqual(bad, []);
    assert.deepEqual(r.trace().filter((x) => x.rule === "gate-error"), []);
  });
}
