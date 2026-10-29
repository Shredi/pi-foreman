// Structural guard (R41): the whole path-class table of pathrules (worktree, scratch, tmp, handoff, agent dir, sibling checkout, outside)
// and the auth-file floor run once as POSIX and once through a simulated win32 (stubbed resolver, drive letter, 8.3 short names, case and
// separator variants); every win32 spelling must give the decision of the POSIX run. Runs on any host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathFloors, type FloorEnv } from "../floors.ts";
import { pathDecide, type GateRoots } from "../pathrules.ts";

interface Layout {
  platform: "posix" | "win32";
  /** The logical dir `name` in this layout. */
  at: (...p: string[]) => string;
  roots: GateRoots;
  floorEnv: FloorEnv;
  cwd: string;
}

const POSIX_ROOT = "/r";
const WIN_LONG = "C:\\Users\\runneradmin";
const WIN_SHORT = "C:\\Users\\RUNNER~1";

function build(platform: "posix" | "win32"): Layout {
  const win = platform === "win32";
  const top = win ? WIN_LONG : POSIX_ROOT;
  const sep = win ? "\\" : "/";
  const at = (...p: string[]): string => [top, ...p].join(sep);
  // the stubbed file system: every logical dir exists; on win32 the 8.3 alias of the home dir resolves to the long name
  const dirs = ["", "wt", "tmp", "tmp/pi-foreman-scratch", "tmp/pi-foreman-scratch/mine", "handoff", "agent", "other", "outside"].map((d) => at(...d.split("/").filter(Boolean)));
  const table = new Map<string, string>();
  for (const d of dirs) {
    table.set(d.toLowerCase(), d);
    if (win) table.set(d.toLowerCase().replace(WIN_LONG.toLowerCase(), WIN_SHORT.toLowerCase()), d);
  }
  const realpath = (p: string): string | null => (win ? (table.get(p.replace(/\//g, "\\").toLowerCase()) ?? null) : (table.get(p) ?? null));
  const roots: GateRoots = {
    worktree: at("wt"),
    scratch: [at("tmp", "pi-foreman-scratch", "mine")],
    tmp: [at("tmp")],
    scratchBase: at("tmp", "pi-foreman-scratch"),
    owned: [],
    install: [],
    roundFlow: [],
    handoffs: [at("handoff")],
    child: false,
    role: "foreman",
    tmpAccess: true,
    agentDir: at("agent"),
    realpath,
  };
  const floorEnv: FloorEnv = { platform: win ? "win32" : "linux", cwd: at("wt"), home: at("home"), agentDir: at("agent"), resolver: realpath };
  return { platform, at, roots, floorEnv, cwd: at("wt") };
}

/** The spellings of one logical path: the layout's own, and on win32 the short-name, upper-case and forward-slash variants. */
function spellings(l: Layout, ...p: string[]): string[] {
  const own = l.at(...p);
  if (l.platform === "posix") return [own];
  return [own, own.replace(WIN_LONG, WIN_SHORT), own.toUpperCase(), own.toLowerCase(), own.replace(/\\/g, "/"), own.replace(WIN_LONG, WIN_SHORT).replace(/\\/g, "/").toUpperCase()];
}

// [logical path, dir, expected rule or undefined]. The decisions are the POSIX ones; the win32 run must reproduce each.
const TABLE: Array<{ name: string; path: string[]; tool: string; rule: string | undefined }> = [
  { name: "worktree read", path: ["wt", "src", "a.ts"], tool: "read", rule: "path-read-worktree" },
  { name: "worktree write", path: ["wt", "src", "a.ts"], tool: "write", rule: "path-write-worktree" },
  { name: "scratch write", path: ["tmp", "pi-foreman-scratch", "mine", "f"], tool: "write", rule: "path-write-scratch" },
  { name: "tmp write", path: ["tmp", "x.txt"], tool: "write", rule: "path-write-tmp" },
  { name: "tmp read", path: ["tmp", "x.txt"], tool: "read", rule: "path-read-tmp" },
  { name: "handoff read", path: ["handoff", "plan.md"], tool: "read", rule: "path-read-handoff" },
  { name: "handoff write plan.md", path: ["handoff", "plan.md"], tool: "write", rule: "path-write-handoff" },
  { name: "handoff write other", path: ["handoff", "other.md"], tool: "write", rule: undefined },
  { name: "agent dir read", path: ["agent", "settings.json"], tool: "read", rule: undefined },
  { name: "sibling checkout read", path: ["other", "main", "index.ts"], tool: "read", rule: undefined },
  { name: "outside read", path: ["outside", "f"], tool: "read", rule: undefined },
  { name: "outside write", path: ["outside", "f"], tool: "write", rule: undefined },
];

const posix = build("posix");
const win = build("win32");

test("win32 sim: every class of the path table decides as the POSIX run, in every spelling", () => {
  for (const row of TABLE) {
    const want = pathDecide(row.tool, { path: posix.at(...row.path) }, posix.cwd, posix.roots, "linux");
    assert.equal(want?.allow ? want.rule : undefined, row.rule, `posix ${row.name}`);
    for (const s of spellings(win, ...row.path)) {
      const got = pathDecide(row.tool, { path: s }, win.cwd, win.roots, "win32");
      assert.equal(got?.allow ? got.rule : undefined, row.rule, `win32 ${row.name}: ${s}`);
    }
  }
});

test("win32 sim: a relative path and a dot-dot climb decide as POSIX", () => {
  for (const l of [posix, win]) {
    const plat = l.platform === "win32" ? "win32" : "linux";
    assert.equal(pathDecide("read", { path: "src/a.ts" }, l.cwd, l.roots, plat)?.rule, "path-read-worktree", l.platform);
    assert.equal(pathDecide("read", { path: "../outside/f" }, l.cwd, l.roots, plat), undefined, l.platform);
  }
});

test("win32 sim: the auth file floor is the same decision in every spelling", () => {
  assert.equal(pathFloors({ path: posix.at("agent", "auth.json") }, posix.floorEnv)?.rule, "floor-secret-path");
  assert.equal(pathFloors({ path: posix.at("agent", "other.json") }, posix.floorEnv), null);
  for (const s of spellings(win, "agent", "auth.json")) assert.equal(pathFloors({ path: s }, win.floorEnv)?.rule, "floor-secret-path", s);
  for (const s of spellings(win, "agent", "other.json")) assert.equal(pathFloors({ path: s }, win.floorEnv), null, s);
});
