// Merge condition: dot-leading file names and the operands of a read/exec verb never reach the trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTrace } from "../trace.ts";

test("trace: dot-leading names and extensionless command operands are scrubbed in every field", () => {
  const out = sanitizeTrace({ event: "overlay", decision: "deny", role: "builder", reason: "path rule '**/.env' matched '.env'", command: "cat .env .npmrc Makefile id_rsa .eslintrc.json" });
  // the reason keeps the matched rule pattern (R3, trace.ts scrubReason); the matched word and the command carry no name
  assert.equal(out.reason, "path rule '**/.env' matched '[path]'");
  const text = Object.entries(out).filter(([k]) => k !== "reason").map(([, v]) => v).join("\n");
  for (const name of [".env", ".npmrc", ".eslintrc.json", "Makefile", "id_rsa"]) assert.ok(!text.includes(name), `${name} survived: ${text}`);
  assert.equal(out.command, "cat [path] [path] [path] [path] [path]");
  // exemptions stay: model ids and a finding's base name
  assert.equal(sanitizeTrace({ event: "llm", model: "prov/m-1.5" }).model, "prov/m-1.5");
  assert.equal(sanitizeTrace({ event: "finding", file: "src/.env" }).file, ".env");
});
