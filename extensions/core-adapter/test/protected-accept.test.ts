// acceptProtected: what a model's verdict may do (allow / ask / deny), every row of the table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptProtected } from "../protected.ts";
import type { ProtectedFacts, ProtectedVerdict } from "../protected.ts";

const facts = (o: Partial<ProtectedFacts> = {}): ProtectedFacts => ({ classes: ["unknown"], remoteClasses: ["read"], opaque: false, remoteOpaque: false, away: false, mode: "model", denyEntryExists: false, ...o });
const v = (o: Partial<ProtectedVerdict> = {}): ProtectedVerdict => ({ verdict: "allow", effect: "read", confidence: "high", entry: "P1", ...o });

test("mode ask always asks", () => {
  assert.equal(acceptProtected(v(), facts({ mode: "ask" })), "ask");
  assert.equal(acceptProtected(v({ verdict: "deny" }), facts({ mode: "ask", denyEntryExists: true })), "ask");
});

test("read, high confidence, nothing writing: allow, present or away, in model and read-only mode", () => {
  assert.equal(acceptProtected(v(), facts()), "allow");
  assert.equal(acceptProtected(v(), facts({ away: true })), "allow");
  assert.equal(acceptProtected(v(), facts({ mode: "read-only" })), "allow");
});

test("a read verdict with a write-out, write-in or build-test class (local or remote) asks", () => {
  for (const c of ["write-out", "write-in", "build-test"] as const) {
    assert.equal(acceptProtected(v(), facts({ classes: [c] })), "ask", c);
    assert.equal(acceptProtected(v(), facts({ remoteClasses: [c] })), "ask", `remote ${c}`);
  }
});

test("a write-out segment with model verdict read asks; a trailing unknown does not hide it", () => {
  assert.equal(acceptProtected(v({ effect: "read" }), facts({ classes: ["write-out"] })), "ask");
  assert.equal(acceptProtected(v({ effect: "read" }), facts({ classes: ["write-out", "unknown"] })), "ask");
});

test("opaque local or remote asks even for a read", () => {
  assert.equal(acceptProtected(v(), facts({ opaque: true })), "ask");
  assert.equal(acceptProtected(v(), facts({ remoteOpaque: true })), "ask");
});

test("low confidence asks", () => {
  assert.equal(acceptProtected(v({ confidence: "low" }), facts()), "ask");
  assert.equal(acceptProtected(v({ effect: "write", confidence: "low" }), facts()), "ask");
});

test("write / deploy / network: allow only in model mode with the owner present", () => {
  for (const effect of ["write", "deploy", "network"] as const) {
    assert.equal(acceptProtected(v({ effect }), facts()), "allow", effect);
    assert.equal(acceptProtected(v({ effect }), facts({ away: true })), "ask", `${effect} away`);
    assert.equal(acceptProtected(v({ effect }), facts({ mode: "read-only" })), "ask", `${effect} read-only`);
    assert.equal(acceptProtected(v({ effect }), facts({ opaque: true })), "ask", `${effect} opaque`);
  }
  assert.equal(acceptProtected(v({ effect: "unknown" }), facts()), "ask");
});

test("deny stands only with a deny entry", () => {
  assert.equal(acceptProtected(v({ verdict: "deny" }), facts({ denyEntryExists: true })), "deny");
  assert.equal(acceptProtected(v({ verdict: "deny" }), facts({ denyEntryExists: false })), "ask");
  assert.equal(acceptProtected(v({ verdict: "deny" }), facts({ denyEntryExists: true, away: true })), "deny");
});

test("an ask verdict asks", () => {
  assert.equal(acceptProtected(v({ verdict: "ask" }), facts()), "ask");
});

test("empty classes (defensive) ask", () => {
  assert.equal(acceptProtected(v(), facts({ classes: [] })), "ask");
});
