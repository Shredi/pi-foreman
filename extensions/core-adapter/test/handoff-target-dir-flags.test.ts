// `cp` / `mv` into an existing dir is read as `dest/<name>` only when every option word is a known-safe flag of the program. Any other option spelling
// (-t attached or clustered, --target-directory and its abbreviations, --backup, -S, -b) may move the real destination, so the result is main's:
// refused for the child kinds (subagent: child-write-outside; session-level child and parent: danger-write-outside).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const posix = process.platform !== "win32";
const base = fs.realpathSync(mkTestTmp("pf-htdf-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const H = path.join(base, "agent", "handoffs", "h1");
const O = path.join(base, "agent", "handoffs", "opened");
const X = path.join(base, "elsewhere");
for (const d of [wt, scr, path.join(H, "work"), O, path.join(O, "work"), X]) fs.mkdirSync(d, { recursive: true });
const mkSrc = (): void => { for (const n of ["a", "b"]) fs.writeFileSync(path.join(wt, n), n); };
mkSrc();
after(() => fs.rmSync(base, { recursive: true, force: true }));

const mk = (o: Partial<GateRoots>): GateRoots => ({ worktree: wt, scratch: [], tmp: [], owned: [], install: [], roundFlow: [], handoffs: [], child: false, role: "builder", tmpAccess: false, ...o });
const KINDS: Record<string, GateRoots> = {
  sub: mk({ scratch: [scr], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), child: true, childHandoff: H }),
  own: mk({ ownHandoff: H }),
  parent: mk({ openedHandoffs: [O] }),
};
const seen = (kind: string, command: string): string => {
  const r = KINDS[kind];
  const out = gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, { child: r.child }), roots: () => r });
  const res = out.result as { allow?: boolean; block?: boolean; rule?: string } | undefined;
  return res?.block ? `block:${res.rule}` : out.danger?.name ?? (res?.allow ? `allow:${res.rule}` : "none");
};
const REFUSED: Record<string, string> = { sub: "block:child-write-outside", own: "danger-write-outside", parent: "danger-write-outside" };
const work = (kind: string): string => path.join(kind === "parent" ? O : H, "work");

test("any option other than the known-safe flags gives main's result (the real write may land in X)", { skip: !posix }, () => {
  const forms = [
    `cp --target=${X} ${wt}/a W`, `cp --t=${X} ${wt}/a W`, `cp --targ ${X} ${wt}/a W`, `cp -t${X} ${wt}/a W`, `cp -vt${X} ${wt}/a W`, `cp -t../x ${wt}/a W`,
    `cp --target-directory=${X} ${wt}/a W`, `cp --target-directory ${X} ${wt}/a W`, `cp -t ${X} ${wt}/a W`, `cp --backup -S ${X} ${wt}/a W`, `cp -b ${wt}/a W`,
    `cp -S ${X} ${wt}/a W`, `cp -r ${wt}/a W`, `cp -T ${wt}/a W`,
    `mv -t${X} ${wt}/a W`, `mv -vt${X} ${wt}/a W`, `mv --targ=${X} ${wt}/a W`, `mv --target=${X} ${wt}/a W`, `mv --target-directory=${X} ${wt}/a W`,
    `mv --target-directory ${X} ${wt}/a W`, `mv -t ${X} ${wt}/a W`, `mv --backup -S ${X} ${wt}/a W`, `mv -b ${wt}/a W`, `mv -T ${wt}/a W`,
  ];
  for (const kind of Object.keys(KINDS)) {
    for (const f of forms) {
      const got = seen(kind, f.replace(/\bW$/, work(kind)));
      // a recursive cp is also caught by the hard floor when the temp dir lies outside the floor's write roots (Linux CI: under home), which fires first
      if (f.startsWith("cp -r ")) assert.ok([REFUSED[kind], "block:floor-overwrite-outside"].includes(got), `${kind}: ${f}: ${got}`);
      else assert.equal(got, REFUSED[kind], `${kind}: ${f}`);
      mkSrc();
    }
  }
});

// pinned as they were before the option whitelist: only an mv into work/ is an allow (a cp into the dir is judged by the write-effect check, as before)
test("the plain into-dir forms keep their results", { skip: !posix }, () => {
  const want: Record<string, string> = { sub: "allow:default-write-in", own: "allow:default-write-in", parent: REFUSED.parent };
  for (const kind of Object.keys(KINDS)) {
    for (const l of [`mv -n ${wt}/a ${work(kind)}`, `mv -f ${wt}/a ${work(kind)}/`]) {
      assert.equal(seen(kind, l), want[kind], `${kind}: ${l}`);
      mkSrc();
    }
    for (const l of [`cp ${wt}/a ${work(kind)}/`, `cp -f ${wt}/a ${wt}/b ${work(kind)}`]) {
      assert.equal(seen(kind, l), REFUSED[kind], `${kind}: ${l}`);
      mkSrc();
    }
  }
});
