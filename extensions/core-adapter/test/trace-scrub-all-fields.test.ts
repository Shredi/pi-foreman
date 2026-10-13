// Merge condition: no path, home path or bare file name reaches the trace through any string field.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openTrace, sanitizeTrace } from "../trace.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-trace-all-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("trace: every string field is scrubbed, secrets stay redacted", () => {
  const home = os.homedir();
  const lines: string[] = [];
  const w = openTrace({ enabled: true, dir, stateDir: dir, sessionId: "all" })!;
  w.emit({ event: "overlay", decision: "deny", role: "builder", reason: `denied ${home}/work/notes.md`, command: `cat ${home}/.ssh/id_rsa /etc/hosts http://x/secret b.txt token=abcdef123456`, runId: "r1" });
  w.emit({ event: "tool_error", tool: "read", message: `ENOENT: /srv/app/a.ts and c.json`, reason: "see /var/log/x.log" });
  w.emit({ event: "friction", kind: "prompt", note: "open ./src/a.ts or ../b.py" });
  lines.push(...fs.readFileSync(w.file, "utf8").trim().split("\n"));
  const text = lines.join("\n");
  assert.equal(lines.length, 3);
  assert.doesNotMatch(text, /\/(?:srv|var|etc|work|Users|home|tmp)\b|~\/|\.ssh|\w\.(?:txt|ts|py|json|md|log)\b|http:/);
  assert.ok(!text.includes(home));
  assert.ok(!text.includes("abcdef123456"));
  assert.deepEqual(sanitizeTrace({ event: "overlay", decision: "deny", command: "curl http://x/secret" }), { event: "overlay", decision: "deny", command: "curl [path]" });
});
