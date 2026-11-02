import { test } from "node:test";
import assert from "node:assert/strict";
import { compile } from "@earendil-works/pi-schema";
import { GIT_PACK_TOOLS, PR_TOOLS } from "../gitpack.ts";
import { SAFE_OP_TOOLS } from "../safeops.ts";
import { BG_PARAMS } from "../bg.ts";

// Pi 1.5 validates tool arguments with pi-schema (JSON Schema, with coercion). Every schema we register must compile
// there, accept a minimal valid call and report a missing required property the pi-schema way.
type Schema = { type?: string; properties?: Record<string, { type?: string; enum?: unknown[]; minimum?: number; minLength?: number }>; required?: string[] };

const SCHEMAS: [string, Schema][] = [
  ...GIT_PACK_TOOLS.map((t) => [t.name, t.parameters as Schema] as [string, Schema]),
  ...PR_TOOLS.map((t) => [t.name, t.parameters as Schema] as [string, Schema]),
  ...SAFE_OP_TOOLS.map((t) => [t.name, t.parameters as Schema] as [string, Schema]),
  ["foreman_bg", BG_PARAMS as unknown as Schema],
];

function sample(p: NonNullable<Schema["properties"]>[string]): unknown {
  if (p.enum) return p.enum[0];
  if (p.type === "integer" || p.type === "number") return p.minimum ?? 1;
  if (p.type === "boolean") return true;
  if (p.type === "array") return [];
  return "x".repeat(Math.max(p.minLength ?? 1, 1));
}

test("every registered tool schema compiles under pi-schema and accepts a minimal call", () => {
  assert.ok(SCHEMAS.length > 10);
  for (const [name, schema] of SCHEMAS) {
    const v = compile(schema as never, { coerce: true });
    const args: Record<string, unknown> = {};
    for (const k of schema.required ?? []) args[k] = sample(schema.properties![k]!);
    const r = v.parse(args);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r)}`);
  }
});

test("a missing required property is reported by path, and numeric strings are coerced", () => {
  for (const [name, schema] of SCHEMAS) {
    const v = compile(schema as never, { coerce: true });
    if (schema.required?.length) {
      const r = v.parse({});
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.ok(r.errors.some((e) => e.path === `/${schema.required![0]}` || /missing|required/i.test(e.message)), `${name}: ${JSON.stringify(r.errors)}`);
    }
  }
  const pr = PR_TOOLS.find((t) => t.name === "pr_status")!;
  const r = compile(pr.parameters as never, { coerce: true }).parse({ number: "42" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.value as { number: number }).number, 42);
});
