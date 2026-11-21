// servedUrl null for a non-loopback bind without baseUrl; bracketed Host parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostAllowed, servedUrl } from "../pageserver.ts";
import type { ServerRecord } from "../pageserver.ts";

const rec = (bind: string): ServerRecord => ({ pid: 1, port: 47317, configPort: 47317, bind, version: "1", startedAt: 0, healthKey: "k" });
const id = "a".repeat(26);

test("servedUrl: non-loopback bind and empty baseUrl gives a file link", () => {
  assert.equal(servedUrl(rec("0.0.0.0"), { baseUrl: "" }, id, "plan.html"), null);
  assert.equal(servedUrl(rec("100.64.0.5"), { baseUrl: "" }, id, "plan.html"), null);
  assert.equal(servedUrl(rec("100.64.0.5"), { baseUrl: "http://h.example:47317/" }, id, "plan.html"), `http://h.example:47317/${id}/plan.html`);
  assert.equal(servedUrl(rec("127.0.0.1"), { baseUrl: "" }, id, "plan.html"), `http://127.0.0.1:47317/${id}/plan.html`);
  assert.equal(servedUrl(rec("::1"), { baseUrl: "" }, id, "plan.html"), `http://127.0.0.1:47317/${id}/plan.html`);
});

test("Host: bracketed hosts accept only [ipv6] with an optional :digits", () => {
  const rules = { bind: "127.0.0.1", baseHost: null };
  assert.equal(hostAllowed("[::1]", rules), true);
  assert.equal(hostAllowed("[::1]:47317", rules), true);
  for (const bad of ["[::1]evil", "[::1]evil.example:80", "[::1]:", "[::1]:80x", "[::1", "[]", "[::1]]"]) assert.equal(hostAllowed(bad, rules), false, bad);
});
