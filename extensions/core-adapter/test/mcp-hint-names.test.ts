// The missing-`mcp` hint matcher: a server name counts as a whole word, also inside an `mcp__server__tool` name or `server/tool`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { namedCeilingServers } from "../mcplaunch.ts";

const roles = { builder: { mcp: ["ha"] } };
const named = (task: string) => namedCeilingServers(roles, "builder", task);

test("namedCeilingServers: a short server name inside another word gives no hint", () => {
  assert.deepEqual(named("check that light"), []);
  assert.deepEqual(named("the hazard list"), []);
});

test("namedCeilingServers: the server as a whole word gives the hint", () => {
  assert.deepEqual(named("turn on the light through ha"), ["ha"]);
  assert.deepEqual(named("ha."), ["ha"]);
});

test("namedCeilingServers: the server inside mcp__server__tool or server/tool gives the hint", () => {
  assert.deepEqual(named("call mcp__ha__light now"), ["ha"]);
  assert.deepEqual(named("call `mcp__ha__light`"), ["ha"]);
  assert.deepEqual(named("call ha/light"), ["ha"]);
});

test("namedCeilingServers: another server's tool name that starts with the name gives no hint", () => {
  assert.deepEqual(named("call mcp__hazard__x"), []);
});
