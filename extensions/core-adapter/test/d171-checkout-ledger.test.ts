// D171: a reviewer launched in its own checkout uses that checkout's ledger (a ledger named in the task wins, else the session-bound one when it lies in
// that checkout, else the only live ledger there, else the session-bound one). The route of the launch keeps it, so a reload does not lose it.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { resolvePython } from "../python.ts";
import { defaultSpawner } from "../spawn.ts";
import { taskLedger } from "../ledgerpath.ts";
import { end, launch, setup, tick, worktree } from "./_hsrig.ts";
import type { World } from "./_hsrig.ts";

const py = await resolvePython({ envPath: process.env.PI_FOREMAN_PYTHON, platform: process.platform, spawner: defaultSpawner });
const skip = !py.ok ? "no Python >= 3.13" : false;

const BOUND = "# Ledger: bound\nTier: standard\n\n- [ ] 1. bound item\n- [ ] V. fresh-eyes verification passed\n";
const OTHER = "# Ledger: other\nTier: standard\n\n- [ ] 1. other item\n- [ ] V. fresh-eyes verification passed\n";
const PASS1 = "Overall verdict: PASS\n1. PASS covered\n";
const read = (f: string): string => fs.readFileSync(f, "utf8");
const done = (f: string): boolean => /- \[x\] 1\. /.test(read(f));
const until = async (ok: () => boolean, what: () => string): Promise<void> => {
  const stop = Date.now() + 10_000;
  while (!ok()) {
    assert.ok(Date.now() < stop, `timed out: ${what()}`);
    await tick(50);
  }
};

/** Session in checkout 2 (the project, ledger bound), checkout 1 = a worktree with its own ledger. */
async function two(t: Parameters<typeof setup>[0], other: string | null = OTHER) {
  const s = await setup(t);
  s.w.state.answer = "allow once";
  const wt = worktree(s.w, "wt1");
  const own = path.join(wt, ".workflow", "LEDGER-other.md");
  if (other !== null) {
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, other);
  }
  await s.a.writeLedger(BOUND);
  const bound = path.join(s.w.project, ".workflow", "LEDGER-x.md");
  return { ...s, wt, own, bound };
}
const routes = (w: World) => w.entries.filter((e) => (e as { customType?: string }).customType === "pi-foreman-ledger-route").map((e) => (e as { data: { run: string; paths: (string | null)[] } }).data);

test("pure: the checkout ledger rule of taskLedger", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "pf-d171-"));
  try {
    const mk = (root: string, ...names: string[]): string[] => names.map((n) => {
      const f = path.join(root, ".workflow", n);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "# x\n");
      return fs.realpathSync(f);
    });
    const [bound] = mk(path.join(dir, "two"), "LEDGER-bound.md");
    const [one] = mk(path.join(dir, "one"), "LEDGER-one.md");
    mk(path.join(dir, "many"), "LEDGER-a.md", "LEDGER-b.md", "LEDGER-old-archive.md");
    fs.mkdirSync(path.join(dir, "none"));
    const at = (checkout: string | null, task = "review it") => taskLedger(task, dir, bound, [dir], checkout);
    assert.deepEqual(at(path.join(dir, "one")), { path: one, named: false, viaCheckout: true }, "the only live ledger of the checkout");
    assert.deepEqual(at(path.join(dir, "two")), { path: bound, named: false }, "the bound ledger lies in the checkout");
    assert.deepEqual(at(path.join(dir, "many")), { path: bound, named: false }, "two live ledgers: the bound one");
    assert.deepEqual(at(path.join(dir, "none")), { path: bound, named: false }, "no ledger in the checkout");
    assert.deepEqual(at(null), { path: bound, named: false });
    assert.deepEqual(at(path.join(dir, "one"), `review ${bound}`), { path: bound, named: true }, "a named ledger wins");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a review in checkout 1 marks checkout 1's ledger only; the route entry names it", { skip }, async (t) => {
  const { a, w, wt, own, bound } = await two(t);
  const r = await launch(a, "reviewer", "[item] review item 1", { cwd: wt, items: [1] });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.match(String(r.input.task), /other item/, "the items block comes from the checkout's ledger");
  assert.doesNotMatch(String(r.input.task), /bound item/);
  assert.ok(routes(w).some((x) => x.run === `run-${r.id}` && x.paths[0] !== null && fs.realpathSync(x.paths[0]) === fs.realpathSync(own)), "the route entry names the checkout ledger");
  await end(a, r, "reviewer", PASS1, wt);
  await until(() => done(own), () => `${read(own)}\n---\n${read(bound)}`);
  assert.equal(done(bound), false, "the session-bound ledger is not marked");
});

test("a task naming a ledger wins over the checkout's; without a ledger in the checkout the bound one is used", { skip }, async (t) => {
  const named = await two(t);
  const r = await launch(named.a, "reviewer", `[item] review item 1 of ${named.bound}`, { cwd: named.wt, items: [1] });
  assert.equal(r.blocked, null, String(r.blocked));
  assert.match(String(r.input.task), /bound item/);
  assert.doesNotMatch(String(r.input.task), /other item/);
  const none = await two(t, null);
  const q = await launch(none.a, "reviewer", "[item] review item 1", { cwd: none.wt, items: [1] });
  assert.equal(q.blocked, null, String(q.blocked));
  assert.match(String(q.input.task), /bound item/);
});
