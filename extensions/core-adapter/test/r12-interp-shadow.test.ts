// R12 item 3: a same-line shell function or alias named like an interpreter (python, python3, python3.x, pypy, node) may run its -c/-e body as
// shell: the body is then checked as shell by the HOME-binding and protected-path (guarded literal) checks. A plain `python3 -c` body stays code.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rules = buildOverlayRules(readBaseline(PKG)!, {}, {}, "/nonexistent/agent", "/nonexistent/pkg");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r12is-")));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const cwd = path.join(root, "ws");
const home = path.join(root, "home");
for (const d of [cwd, home]) fs.mkdirSync(d, { recursive: true });

const child = (command: string): { kind: string; reason?: string } => {
  const d = checkToolCall(rules, "bash", { command }, { cwd, home, platform: process.platform, role: "child" });
  return { kind: d?.kind ?? "pass", reason: (d as { reason?: string } | null)?.reason };
};
const BIND = /the line binds HOME and uses it/;
const SSH = /\.ssh/;

test("interp_python_c_plain_still_allowed", () => {
  assert.equal(child("python3 -c 'x=1'").kind, "pass");
  // without a shadowing definition the body stays code: its HOME= and ~ bind nothing, its bare words are no paths
  for (const c of ["python3 -c 'HOME=1; print(HOME)'", "python3 -c 'x = 1 ; print(x)' && node -e 'const HOME=1'"]) {
    assert.doesNotMatch(child(c).reason ?? "", BIND, c);
  }
});

// the shell joins `.ss""h` to `.ssh`: only a shell parse of the body names the protected path (the raw body text does not)
const sshBody = (base: string): string => `cat ${base}/.ss""h/id_rsa`;

test("interp_python_function_shadow_checked_as_shell", () => {
  for (const c of [
    "python3(){ sh \"$@\"; }; python3 -c 'HOME=/x; cat ~/y'",
    "python3 () { sh \"$@\"; }\npython3 -c 'HOME=/x; cat ~/y'",
    "function python3 { sh \"$@\"; }; python3 -c 'HOME=/x; cat ~/y'",
    "function python3.12() { sh \"$@\"; } && python3.12 -c 'HOME=/x; cat ~/y'",
    "pypy(){ sh \"$@\"; }; pypy -c 'HOME=/x; cat ~/y'",
    "python(){ sh \"$@\"; }\n\npython -c 'HOME=/x; cat ~/y'",
  ]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
  // a function definition already binds every trusted name (boundNames), so these name the home dir literally
  for (const c of [`python3(){ sh "$@"; }; python3 -c '${sshBody(home)}'`, `python3(){ sh "$@"; }\npython3 -c '${sshBody(home)}'`]) {
    const d = child(c);
    assert.notEqual(d.kind, "pass", c);
    assert.match(d.reason!, SSH, c);
  }
});

test("interp_read_code_names_only_real_pythons", { skip: process.platform === "win32" }, () => {
  // readCode (the read-only python exemption) holds for python[0-9.]* and pypy[0-9.]* only; `python_x` / `python3-x` are other
  // programs (inlineCode's INTERPRETERS is anchored the same way), so their protected operands are checked like any program's
  const ws = path.join(root, "selfhost");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "package.json"), "{}\n");
  const own = buildOverlayRules(readBaseline(PKG)!, {}, {}, path.join(root, "agent"), ws, undefined, false);
  const sh = (command: string): string => checkToolCall(own, "bash", { command }, { cwd: ws, home, platform: process.platform, role: "child" })?.kind ?? "pass";
  const code = `"print(open('package.json').read())"`;
  for (const p of ["python3", "python", "python3.12"]) assert.equal(sh(`${p} -c ${code}`), "pass", p);
  for (const p of ["python_x", "python3-x", "pypy_x", "python3.12-x"]) assert.notEqual(sh(`${p} -c ${code} package.json`), "pass", p);
});

test("interp_node_alias_shadow_checked_as_shell", () => {
  for (const c of [
    "alias node=sh; node -e 'HOME=/x; cat ~/y'",
    "alias node='sh'\nnode -e 'HOME=/x; cat ~/y'",
    "alias ll='ls -l' python3=sh; python3 -c 'HOME=/x; cat ~/y'",
    "node(){ sh \"$@\"; }; node -e 'HOME=/x; cat ~/y'",
  ]) {
    const d = child(c);
    assert.equal(d.kind, "deny", c);
    assert.match(d.reason!, BIND, c);
  }
  for (const c of [`alias node=sh; node -e '${sshBody("~")}'`, `alias node=sh\nnode -e '${sshBody(home)}'`]) {
    const d = child(c);
    assert.notEqual(d.kind, "pass", c);
    assert.match(d.reason!, SSH, c);
  }
});
