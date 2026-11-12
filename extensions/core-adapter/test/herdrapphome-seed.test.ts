// Ledger item 5: the in-process doctor's app home takes HERDR_APP_HOME from the env first, then the test preload's seed, then the default.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { doctorAppHome } from "../profiles.mjs";

const SLOT = Symbol.for("pi-foreman.herdr-app-home");

test("doctorAppHome: HERDR_APP_HOME in the env wins over the seed, and the seed wins over the default", () => {
  const g = globalThis as unknown as Record<symbol, { seed?: string } | undefined>;
  const saved = g[SLOT];
  try {
    g[SLOT] = { seed: "/seed" };
    assert.equal(doctorAppHome({ HERDR_APP_HOME: "/env" }, "/home/u"), "/env");
    assert.equal(doctorAppHome({}, "/home/u"), "/seed");
    g[SLOT] = undefined;
    assert.equal(doctorAppHome({}, "/home/u"), path.join("/home/u", ".config", "herdr-app"));
  } finally {
    g[SLOT] = saved;
  }
});
