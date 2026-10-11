// Dormant features: unit cases plus a cross-check against scripts/foreman_docs.py on the defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dormantDoctorLine, dormantFeatures } from "../features.ts";
import type { FeatureMap } from "../features.ts";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });

test("predicates, * fan-out and missing keys", () => {
  const map: FeatureMap = { features: [
    { id: "always", switch: null },
    { id: "flag", switch: { key: "a.flag", on: "true" } },
    { id: "list", switch: { key: "a.list", on: "nonempty" } },
    { id: "strong", switch: { key: "p.*.roles.*.strong", on: "nonnull" } },
    { id: "ranks", switch: { key: "p.*.ranks", on: "nonempty" } },
    { id: "gone", switch: { key: "x.y.z", on: "true" } },
  ] };
  const cfg = { a: { flag: "true", list: [] }, p: { one: { ranks: {}, roles: { b: { strong: null } } }, two: { roles: { b: { strong: "m" } } } } };
  assert.deepEqual(dormantFeatures(map, cfg), ["flag", "list", "ranks", "gone"]);
  assert.deepEqual(dormantFeatures(map, { a: { flag: true, list: [1] }, p: { one: { ranks: { r: 1 } } } }), ["strong", "gone"]);
});

test("doctor line: none, list and unreadable features.json", () => {
  const line = dormantDoctorLine(ROOT, {});
  assert.match(line, /^INFO dormant: \S/);
  assert.match(dormantDoctorLine(path.join(ROOT, "no-such-dir"), {}), /^WARN /);
});

test("matches foreman_docs.py dormant and features.json state on the defaults", { skip: !py.ok && "python not found" }, () => {
  const cfgPath = path.join(ROOT, "config", "foreman.defaults.json");
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "features.json"), "utf8")) as { features: (FeatureMap["features"][number] & { state: string })[] };
  const got = dormantFeatures(map as FeatureMap, JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  const r = spawnSync(py.ok ? py.info.executable : "python", [path.join(ROOT, "scripts", "foreman_docs.py"), "dormant", "--config-json", cfgPath], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(got, r.stdout.split(/\r?\n/).filter(Boolean));
  assert.deepEqual(got, map.features.filter((f) => f.switch && f.state !== "on").map((f) => f.id));
});
