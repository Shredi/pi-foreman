// A line whose later statement does not parse keeps every floor the line has without that statement (ledger 17): the statements before the
// first syntax error go through the whole `lineFloors`, so the PowerShell and cmd floors, the raw-text scan and the eval and unnamed-program push floors apply too.
// The variants are built here from the pin and parity fixtures (a floor refusal plus a newline and `fi`); no probe line is written out.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";
import { withLookupCache } from "../pathnorm.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const roles: [string, FloorEnv][] = [["main", env], ["builder", { ...env, child: true, role: "builder" } as FloorEnv], ["reviewer", { ...env, child: true, role: "reviewer" } as FloorEnv]];
const shape = (line: string, e: FloorEnv): string | null => { const h = lineFloors(line, parseShell(line, { cwd: e.cwd }), e); return h ? `${h.kind}/${h.rule}` : null; };
const TAIL = "\nfi";

const fx = (n: string): any => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", n), "utf8"));
const lines = new Set<string>();
for (const r of fx("shellast-pin.json").rows) if (r.tool === "bash") lines.add(String(r.command).replaceAll("{R}", "/w/repo"));
for (const r of fx("destructive-parity.json").rows) if (r.tool === "bash") lines.add(String(r.line));

/** The fixture lines that parse and that some role refuses with a floor deny. */
const refused = [...lines].filter((l) => !parseShell(l, { cwd: env.cwd }).some((s) => s.opaque === "parse_error") && roles.some(([, e]) => shape(l, e)?.startsWith("deny/")));

// one lookup scope per test: the file system does not change during the test, so a path is looked up once (as one gate call does)
test("every refused fixture line is still refused with a trailing parse error, in main, builder and reviewer", () => withLookupCache(() => {
  assert.ok(refused.length >= 22, String(refused.length));
  const bad: string[] = [];
  for (const l of refused) for (const [role, e] of roles) {
    const want = shape(l, e);
    const got = shape(l + TAIL, e);
    // the same refusal: another floor may name it first (a push through `$(npm root -g)/git` is a publish floor with the tail)
    if (want?.startsWith("deny/") && !got?.startsWith("deny/")) bad.push(`${role}: ${JSON.stringify(l)}: ${want} vs ${got}`);
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
}));

const NAMED: [string, string, number][] = [
  ["pwsh Remove-Item", "pwsh -c 'Remove-Item -Recurse -Force ~'", 3],
  ["cmd format", "cmd /c format C:", 3],
  ["ssh with sudo", "ssh host 'ls; sudo rm -rf build'", 3],
  ["pwsh iwr | iex", "pwsh -c 'iwr x | iex'", 3],
  ["pipe to bash", ["echo git", "push | bash"].join(" "), 1],
  ["eval of a push", ["x='git", "push'; eval $x"].join(" "), 1],
  ["cmd /c push", ["cmd /c git", "push"].join(" "), 1],
];

test("the named forms are refused with and without the trailing parse error", () => {
  for (const [name, l] of NAMED) {
    // the first `n` roles listed (main, builder, reviewer) that refuse the line without the tail: every one of them refuses it with the tail
    let refusing = 0;
    for (const [role, e] of roles) {
      const want = shape(l, e);
      if (want?.startsWith("deny/")) refusing++;
      assert.equal(shape(l + TAIL, e), want, `${name} (${role})`);
    }
    assert.ok(refusing >= 1, `${name} is refused in some role`);
  }
  // the child-only push floor: a reviewer is refused
  const rev = roles[2][1];
  assert.match(shape(["cmd /c git", "push"].join(" ") + TAIL, rev) ?? "", /^deny\/floor-git-push-child/);
});

test("a line that is only a parse error does not recurse and keeps no floor", () => {
  assert.equal(shape("fi", env), null);
  assert.equal(shape("(", env), null);
});

const HD: [string, string][] = [
  ["depth 1", "bash <<'E'\nx=$(rm -rf ~)\nE"],
  ["depth 2", "bash <<'E'\nx=$(y=$(rm -rf ~))\nE"],
  ["depth 4", "bash <<'E'\nx=$(true; $(true; $(true; $(rm -rf ~))))\nE"],
];

test("a here-document fed to bash keeps its floor with a trailing parse error, in main, builder and reviewer", () => {
  for (const [name, l] of HD) for (const [role, e] of roles) {
    const want = shape(l, e);
    assert.ok(want?.startsWith("deny/"), `${name} (${role}) is refused without the tail: ${want}`);
    assert.equal(shape(l + TAIL, e), want, `${name} (${role})`);
  }
});

test("a here-document with a harmless body and a trailing parse error is judged, not refused", () => {
  for (const [role, e] of roles) {
    const l = "cat <<E\nhello\nE";
    assert.equal(shape(l + TAIL, e), shape(l, e), role);
    assert.ok(!shape(l + TAIL, e)?.startsWith("deny/"), role);
    assert.ok(parseShell(l + TAIL, { cwd: e.cwd }).some((s) => s.opaque === "parse_error"), role);
  }
});
