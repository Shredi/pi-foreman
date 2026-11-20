// PR C step 3: the text floors read parsed structure, not words inside data. Heredoc bodies of an interpreter, quoted arguments of a data program, inline interpreter code
// and `${NAME}` inside double quotes carry the trigger words of the floors (steward lines, redacted); none of them runs a shell, so no floor fires. The same words as real
// commands keep their floor or judge-first label.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { baseFloorEnv, gateEvaluate } from "../gate.ts";
import type { GateRoots } from "../pathrules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const base = fs.realpathSync(mkTestTmp("pf-databodies-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
for (const d of [wt, scr]) fs.mkdirSync(d, { recursive: true });
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots = (child: boolean): GateRoots => ({ worktree: wt, scratch: [scr], tmp: [path.join(base, "tmp")], scratchBase: path.join(base, "tmp", "pi-foreman-scratch"), owned: [], install: [], roundFlow: [], handoffs: [], child, role: child ? "builder" : "foreman", tmpAccess: true });
const run = (command: string, child: boolean) => gateEvaluate("bash", { command }, wt, { env: (cwd) => baseFloorEnv(cwd, child ? { child: true } : {}), roots: () => roots(child) });
const verdict = (command: string, child: boolean): string => {
  const o = run(command, child);
  const r = o.result as { rule?: string } | undefined;
  // an allow rule (`default-git-read`...) is a run
  return r === undefined || /^(default|builtin)-/.test(r.rule ?? "") ? (o.danger?.name ?? "run") : (r.rule ?? JSON.stringify(r));
};

const T = [
  "python3 - <<EOF\nimport subprocess\n# never run mkfs /dev/sda or dd of=/dev/sda\nprint(subprocess.run(['git', 'diff', 'docs'], capture_output=True).stdout)\nEOF\ngit diff docs | grep -c foo | cut -d: -f1",
  "python3 - <<EOF\nprint('dd of=/dev/sda; mkfs.ext4 /dev/sdb; sudo ls')\nEOF\nnpm run typecheck | tail -5",
  "python3 -I - <<EOF\ntext = 'git config remote.origin.url x; sudo ls; npm publish'\nprint(text)\nEOF\ngrep -c foo file.txt",
  "python3 - <<E\n# git push --force origin main\nprint(1)\nE\nnpm run typecheck | tail; env -u FOO true",
  "python3 -c \"print('git push --force origin main; sudo ls; mkfs /dev/sda; npm publish')\" | paste -sd, - | sed 's/a/b/'",
  "node -e \"console.log('git push origin main --force; git config remote.origin.url x')\" | sed 's/a/b/'",
  "git diff main --stat | grep -c 'npm publish'",
  "python3 - <<EOF\nprint('rm -rf /etc')\nEOF\nls",
  "printf '%s\\n' a b c d e f g h i j k 'sudo rm' \"su ${HOME}\" > out.txt;",
  "python3 - <<EOF\nopen('x.bak', 'w').write('probe: rm foo.orig *~ .swp')\nEOF",
  "grep -c 'git config' notes.txt; grep -n \"mkfs ${X}\" notes.txt",
  "echo \"${HOME}/sudo reboot\" | wc -c",
];

test("trigger words in interpreter heredocs, inline code and quoted arguments of data programs fire no floor (inline code is judge-first), for the foreman and a child", () => {
  for (const l of T) for (const child of [false, true]) assert.match(verdict(l, child), /^(run|danger-inline-code)$/, `${child ? "child" : "foreman"}: ${JSON.stringify(l)}`);
});

test("a publish word in a later statement of an unparsed line is no publish; the package program at a command position still is", () => {
  const opaque = (tail: string) => `for f in $L; do ${tail}; done`;
  assert.equal(verdict(opaque("grep -c yarn $f; echo push"), true), "run");
  assert.equal(verdict(opaque("npm publish"), true), "floor-publish");
  assert.equal(verdict(opaque("env NPM_X=1 npm publish"), false), "floor-publish");
});

test("child: $FOREMAN_SCRATCH resolves beside a pass-through wrapper; a runner or another directory does not", () => {
  const ok = [
    "cd $FOREMAN_SCRATCH && sed -i s/a/b/ f.txt && env -u A true",
    "cd $FOREMAN_SCRATCH && sed -i s/a/b/ f.txt; nohup ls",
    "S=$FOREMAN_SCRATCH; cat > $S/f <<E\nhello rm -rf x\nE\ncp $S/f $S/g",
  ];
  for (const l of ok) assert.equal(verdict(l, true), "run", l);
  // an interpreter fed on stdin is judge-first (danger-inline-code), not a child-write-outside
  assert.equal(verdict("S=$FOREMAN_SCRATCH; python3 - <<E\nprint('sudo rm -rf /')\nE\ncp $S/f $S/g", true), "danger-inline-code");
  assert.equal(verdict("cd /etc && sed -i s/a/b/ f.txt && env -u A true", true), "child-write-outside");
  assert.notEqual(verdict("cd $FOREMAN_SCRATCH && sed -i s/a/b/ f.txt; env sh -c 'cd /etc; sed -i s/a/b/ f'", true), "run");
});

test("controls: the same words as real commands keep their floor or judge-first label", () => {
  const both: [string, string][] = [
    ["sudo ls", "floor-privilege"],
    ["mkfs.ext4 /dev/sda", "floor-disk"],
    ["dd if=/dev/zero of=/dev/sda", "floor-disk"],
    ["npm publish", "floor-publish"],
    ["bash <<EOF\nsudo ls\nEOF", "floor-privilege"],
    ["sh <<< 'mkfs /dev/sda'", "floor-disk"],
    ["cat <<EOF | sh\nsudo ls\nEOF", "floor-privilege"],
    ["sh -c 'mkfs /dev/sda'", "floor-disk"],
    ["env sh -c 'sudo ls'", "floor-privilege"],
    ["at now <<EOF\nreboot\nEOF", "floor-shutdown"],
    ["python3 - <<EOF\nprint(1)\nEOF\nsudo ls", "floor-privilege"],
    ["python3 -c 'print(1)'; mkfs /dev/sda", "floor-disk"],
    ["git config remote.origin.url x", "danger-git-config"],
  ];
  for (const [l, rule] of both) for (const child of [false, true]) assert.equal(verdict(l, child), rule, `${child ? "child" : "foreman"}: ${JSON.stringify(l)}`);
  assert.equal(verdict("git push --force origin main", false), "floor-git-push-force");
  assert.equal(verdict("git push --force origin main", true), "floor-git-push-child");
});
