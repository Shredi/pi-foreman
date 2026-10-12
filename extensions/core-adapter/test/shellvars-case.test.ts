import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShell } from "../permoverlay.ts";
import { resolveVars } from "../shellvars.ts";

const resolvedCount = (cmd: string): number => {
  const p = parseShell(cmd);
  return resolveVars(p.pipelines, p.seps, {}).size;
};

const W = "/ok/work";
const A = "/ok/handoff";

test("control: a plain assignment on its own line resolves", () => {
  assert.equal(resolvedCount(`H=${A}\ncp plan.md $H/plan.md`), 1);
});

test("an assignment in a case arm leaves the line unresolved", () => {
  for (const arm of [`y) H=${A};; esac`, `y) H=${A} ;; esac`, `y) :;; z) H=${A};; esac`, `y) true; H=${A};; esac`]) {
    assert.equal(resolvedCount(`H=${W}/src; case x in ${arm}; cp f $H`), 0, arm);
  }
});

test("a newline after a reserved word or control operator does not make the assignment sole", () => {
  for (const [head, tail] of [
    ["false &&", "\ncp f $H"],
    ["if false; then", "\nfi; cp f $H"],
    ["false ||", "\ncp f $H"],
    ["false |", "\ncp f $H"],
    ["{", "\n} </dev/null; cp f $H"],
    ["if false; then :\nelse", "\nfi; cp f $H"],
  ]) {
    assert.equal(resolvedCount(`H=${W}/src; ${head}\nH=${A}${tail}`), 0, head);
  }
});

test("a trap anywhere on the line stops resolution", () => {
  assert.equal(resolvedCount(`trap 'H=${W}/src' DEBUG; H=${A}; cp f $H`), 0);
});
