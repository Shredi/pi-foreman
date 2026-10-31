// r79 revision round: gh/glab api flag parsing (A), git push of non-own refs (B), shell writes outside the worktree (C), a data write that only
// contains command text (J), brace/glob protected names (F) and the hand-written glob matcher (G).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { dangerMatch, lineDefault } from "../defaults.ts";
import type { DangerEnv, DefaultCtx, GitFacts } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf79-rev-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
for (const d of [path.join(wt, "src"), scr, path.join(base, "sibling"), path.join(base, "outside")]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child = false, cwd = wt): GateRoots => ({ worktree: cwd, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const facts: GitFacts = { currentBranch: () => "round/79-x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => false, ownBranches: () => ["round/79-y"] };
const denv = (cwd = wt, child = false): DangerEnv => ({ roots: roots(child, cwd), platform: process.platform, cwd, facts });
const dctx = (): DefaultCtx => ({ roots: roots(), facts, platform: process.platform, cwd: wt });
const segs = (line: string, cwd = wt) => parseShell(line, { cwd, env: { FOREMAN_SCRATCH: scr } });
const danger = (line: string, cwd = wt, child = false): string | null => dangerMatch({ tool: "bash", input: { command: line }, text: line, segments: segs(line, cwd) }, denv(cwd, child))?.name ?? null;
const deflt = (line: string): string | null => lineDefault(line, segs(line), dctx());
const OUT = shPath(path.join(base, "outside"));
const SIB = shPath(path.join(base, "sibling"));
const WT = shPath(wt);

test("A: gh/glab api: the last method wins, a method override header is a write", () => {
  for (const l of ["gh api -X GET repos/o/r -X DELETE", "gh api --method GET repos/o/r --method POST", "gh api -X DELETE repos/o/r -X GET repos/o/r2", "gh api repos/o/r -H 'X-HTTP-Method-Override: DELETE'", "gh api repos/o/r -H 'x-http-method-override: PATCH'", "glab api projects/1 -X GET -X PUT", "gh api graphql -X PATCH -f query='query{viewer{login}}'"]) {
    if (l.includes("-X DELETE repos/o/r -X GET")) continue; // last wins -> GET: read
    assert.equal(danger(l), "danger-forge", l);
    assert.notEqual(deflt(l), "default-gh-read", l);
  }
  assert.equal(danger("gh api -X DELETE repos/o/r -X GET"), null, "the last -X is GET");
  assert.equal(danger("gh api repos/o/r -H 'X-HTTP-Method-Override: GET'"), null);
  assert.equal(danger("gh api -X GET repos/o/r"), null);
  assert.notEqual(deflt("gh api -X GET repos/o/r --method POST"), "default-gh-read");
  assert.equal(deflt("gh api -X GET repos/o/r"), "default-gh-read");
});

test("B: git push of anything but an own branch is dangerous; an own-branch push stays routine", () => {
  for (const l of ["git push origin other-branch", "git push origin round/79-y:other", "git push origin v1.0", "git push origin tag v1.0", "git push --tags", "git push --mirror", "git push origin --delete round/79-x", "git push origin :round/79-x", "git push --all origin", "git push origin +round/79-x", "git push origin HEAD round/zzz"]) {
    assert.equal(danger(l), "danger-git", l);
  }
  for (const l of ["git push origin HEAD", "git push -u origin round/79-x", "git push origin round/79-y"]) {
    assert.equal(danger(l), null, l);
  }
  assert.equal(deflt("git push origin round/79-x"), "default-git-push");
  assert.notEqual(deflt("git push origin other-branch"), "default-git-push");
});

test("C: a write outside the worktree through the usual tools is danger-write-outside; the same inside is routine", () => {
  const out: string[] = [
    `sed -i s/a/b/ ${OUT}/f`, `sed -i.bak s/a/b/ ${OUT}/f`, `sed --in-place s/a/b/ ${OUT}/f`, `sed -n 'w ${OUT}/f' a.txt`, `truncate -s 0 ${OUT}/f`, `perl -pi -e 's/a/b/' ${OUT}/f`,
    `dd if=a.txt of=${OUT}/f`, `sort -o ${OUT}/f a.txt`, `cp -t ${OUT} a.txt`, `install -m 644 a.txt ${OUT}/f`, `ln -sf a.txt ${OUT}/l`, `awk -i inplace '{print}' ${OUT}/f`,
    `patch ${OUT}/f p.diff`, `git -C ${OUT} commit -m x`, `npm --prefix ${OUT} install`, `cd ${OUT} && git commit -m x`, `rm -r ${SIB}`,
  ];
  for (const l of out) assert.equal(danger(l), "danger-write-outside", l);
  const inside: string[] = [
    `sed -i s/a/b/ ${WT}/a.txt`, `sed -i s/a/b/ a.txt`, `sed -n 'w ${WT}/f' a.txt`, `truncate -s 0 ${WT}/f`, `perl -pi -e 's/a/b/' ${WT}/f`, `dd if=a.txt of=${WT}/f`, `sort -o ${WT}/f a.txt`,
    `cp -t ${WT}/src a.txt`, `install -m 644 a.txt ${WT}/f`, `ln -sf a.txt ${WT}/l`, `git -C ${WT} commit -m x`, `cd ${WT}/src && git commit -m x`, `sed -i s/a/b/ ${shPath(scr)}/f`,
  ];
  for (const l of inside) assert.notEqual(danger(l), "danger-write-outside", l);
});

test("C: an interpreter one-liner is danger-opaque (it may write anywhere)", () => {
  for (const l of [`python3 -c "open('${OUT}/f','w').write('x')"`, `node -e "require('fs').writeFileSync('${OUT}/f','x')"`, `perl -e 'open F,">${OUT}/f"'`, `ruby -e 'File.write(1,2)'`]) assert.equal(danger(l), "danger-opaque", l);
});

test("C: a child's `cd .. && rm -r sibling` is danger-write-outside", () => {
  assert.equal(danger("cd .. && rm -r sibling", wt, true), "danger-write-outside");
  assert.notEqual(danger("cd src && rm -r build"), "danger-write-outside");
});

test("J: data written by heredoc/printf into a worktree or scratch file is not classified as the commands it contains", () => {
  const docs = [`cat > ${WT}/notes.md <<'EOF'\nrm -rf /\ngit push --force origin main\nkubectl delete ns prod\nEOF`, `printf 'rm -rf /\\nsudo reboot\\n' > ${WT}/notes.md`, `printf 'ssh host; git push origin main\\n' > ${shPath(scr)}/n.txt`];
  const fenv: FloorEnv = { cwd: wt, home: "/h/me", writeRoots: [wt, scr], scratch: [scr], protectedBranches: ["main"], currentBranch: () => "round/79-x", remoteHead: () => "main" };
  for (const l of docs) {
    assert.equal(danger(l), null, l);
    assert.equal(lineFloors(l, segs(l), fenv), null, l);
  }
});

test("F: a brace group or glob that could expand to a protected file name is an ask-kind floor", () => {
  const e: FloorEnv = { cwd: wt, home: path.join(base, "home"), writeRoots: [wt, scr], scratch: [scr], protectedBranches: [], currentBranch: () => "round/79-x", remoteHead: () => "main" };
  const wf = path.join(wt, ".workflow");
  fs.mkdirSync(wf, { recursive: true });
  const f = (l: string) => lineFloors(l, segs(l), e);
  for (const l of [`echo x > ${WT}/.workflow/permission{s,x}.json`, `rm ${WT}/.workflow/permission?.json`, `rm ${WT}/.workflow/permissions.js[o]n`, `rm ${WT}/.workflow/{permissions,other}.json`]) assert.ok(f(l), l);
  for (const l of [`echo x > ${WT}/.workflow/notes{1,2}.md`, `rm ${WT}/.workflow/notes?.md`, `echo x > ${WT}/src/permission{s,x}.json`]) assert.equal(f(l), null, l);
});

test("G: a command word is never a RegExp: 40 trailing stars then z against a protected name is fast", () => {
  const e: FloorEnv = { cwd: wt, home: path.join(base, "home"), writeRoots: [wt, scr], scratch: [scr], protectedBranches: [], currentBranch: () => "round/79-x", remoteHead: () => "main" };
  const l = `rm ${WT}/.workflow/${"a*".repeat(40)}z`;
  const t0 = Date.now();
  lineFloors(l, segs(l), e);
  assert.ok(Date.now() - t0 < 50, `${Date.now() - t0} ms`);
  const l2 = `rm ${"*".repeat(40)}z`;
  const t1 = Date.now();
  lineFloors(l2, segs(l2), e);
  assert.ok(Date.now() - t1 < 50, `${Date.now() - t1} ms`);
});
