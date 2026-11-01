import { test } from "node:test";
import assert from "node:assert/strict";
import { denyPatterns, globMatch, roleToolDenied } from "../roledeny.ts";

const roles = {
  explorer: { denyTools: ["mcp__*"] },
  reviewer: { denyTools: ["mcp__*"] },
  builder: { tools: ["read"] },
};

test("mcp__fake__probe is denied for explorer and reviewer", () => {
  for (const role of ["explorer", "reviewer"]) {
    const msg = roleToolDenied(roles, role, "mcp__fake__probe");
    assert.equal(msg, `\`mcp__fake__probe\` is denied for role ${role} (roles.${role}.denyTools)`);
  }
});

test("builder and other tools are unaffected", () => {
  assert.equal(roleToolDenied(roles, "builder", "mcp__fake__probe"), undefined);
  assert.equal(roleToolDenied(roles, "explorer", "read"), undefined);
  assert.equal(roleToolDenied(roles, "explorer", "xmcp__a"), undefined);
});

test("an unreadable role binding or config denies mcp__*", () => {
  assert.ok(roleToolDenied(roles, null, "mcp__fake__probe"));
  assert.ok(roleToolDenied(undefined, "builder", "mcp__fake__probe"));
  assert.equal(roleToolDenied(roles, null, "read"), undefined);
  assert.deepEqual(denyPatterns(roles, undefined), ["mcp__*"]);
});

test("glob patterns: * wildcard, rest literal", () => {
  assert.ok(globMatch("mcp__*", "mcp__a__b"));
  assert.ok(globMatch("a.b", "a.b"));
  assert.ok(!globMatch("a.b", "axb"));
  assert.ok(globMatch("*probe", "mcp__x__probe"));
  assert.ok(!globMatch("mcp__*", "mcp_x"));
});
