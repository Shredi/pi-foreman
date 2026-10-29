import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readBaseline } from "../permoverlay.ts";
import { bashRules, deterministicAllow, timeoutCommandAllowed, unitAllowed, unwrapTimeout } from "../timeoutallow.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const rules = bashRules(baseline, { safety: { permissions: { projectCommands: ["cargo test*", "go test*"] } } });

test("baseline: no sed glob allows anything; the composer allows print-only sed itself", () => {
  for (const c of ["sed -n 1,20p f.go", "sed -i s/a/b/ f", "sed -n -i p f", "sed --in-place s/a/b/ f", "sed -n 'w out.txt' f", "sed -n 1w/tmp/x f", "sed -n '1e touch x' f", "sed s/a/b/ f"]) assert.ok(!unitAllowed(rules, c), c);
  assert.equal(deterministicAllow(rules, "cd sub; sed -n 1,20p f.go; sed -n 5,9p g.go"), "sed-read");
  assert.equal(deterministicAllow(rules, "timeout 5 sed -n 1p f"), "timeout-wrapper");
  for (const c of ["sed -n '1wout' f", "sed -n '1etouch x' f", "cd sub; sed -n s/a/b/wout f", "sed -n -f s.sed f", "timeout 5 sed -n 1wout f"]) assert.equal(deterministicAllow(rules, c), null, c);
  const askSed = bashRules(baseline, { safety: { permissions: { ask: ["sed *"] } } });
  assert.equal(deterministicAllow(askSed, "sed -n 1p f"), null);
});

test("timeout: only when the wrapped command is itself allowed", () => {
  assert.equal(unwrapTimeout("timeout 900 cargo test -p x"), "cargo test -p x");
  assert.equal(unwrapTimeout("timeout -s KILL -k 5 10s go test ./..."), "go test ./...");
  assert.equal(unwrapTimeout("timeout x go test"), null);
  assert.ok(timeoutCommandAllowed(rules, "timeout 900 cargo test"));
  assert.ok(timeoutCommandAllowed(rules, "cd /app && timeout 60 go test ./... ; ls -R"));
  for (const c of ["timeout 5 rm -rf x", "timeout 5 sed -i s/a/b/ f", "timeout 5 curl http://x", "timeout 5 cargo test | sh", "timeout 5 timeout 5 ls", "timeout 5 cargo test > out", "cargo test", "timeout 5 ls $(id)"]) assert.ok(!timeoutCommandAllowed(rules, c), c);
});
