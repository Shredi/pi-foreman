import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_USAGE, formatList, parseSessionArgs } from "../session.ts";

test("session command parsing: pull is gone, the other subcommands parse as before", () => {
  assert.deepEqual(parseSessionArgs("pull"), parseSessionArgs("bogus"));
  assert.ok("error" in parseSessionArgs("pull"));
  assert.ok("error" in parseSessionArgs("pull demo"));
  assert.doesNotMatch(SESSION_USAGE, /pull/);
  assert.deepEqual(parseSessionArgs("list"), { sub: "list" });
  assert.deepEqual(parseSessionArgs("close demo"), { sub: "close", target: "demo" });
  assert.deepEqual(parseSessionArgs("brief demo hello there"), { sub: "brief", target: "demo", body: "hello there" });
  const open = parseSessionArgs("open demo b.md --machine alpha --cwd /p");
  assert.ok("sub" in open && open.sub === "open" && open.machine === "alpha");
});

test("session list rows carry no pull summary", () => {
  const text = formatList({ version: 1, sessions: [{ label: "demo", child: "c1", status: "open", handoff: "/h", machine: "alpha", pulledAt: "2026-01-01T00:00:00Z", returnPath: "pull" }] });
  assert.doesNotMatch(text, /pull/);
  assert.match(text, /^demo {2}- {2}open {2}\/h {2}c1$/m);
});
