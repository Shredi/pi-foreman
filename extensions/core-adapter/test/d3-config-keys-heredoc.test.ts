// PR D3: a settings-file name that only a here-document body holds no longer fires config-keys on an opaque line; keys in a body written to a variable target still do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { blankHeredocBodies, parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => null, child: true, scratch: ["/s/scr"] } as FloorEnv;
const rule = (line: string): string | null => lineFloors(line, parseShell(line, { cwd: env.cwd }), env)?.rule ?? null;

test("blankHeredocBodies blanks the body only, same length", () => {
  const c = "cat <<EOF\nforeman.json gate.x\nEOF\nls foreman.json";
  const b = blankHeredocBodies(c);
  assert.equal(b.length, c.length);
  assert.ok(!b.includes("gate.x"));
  assert.ok(b.endsWith("ls foreman.json"));
  // an unterminated heredoc still parses: its body is blanked too
  assert.equal(blankHeredocBodies("cat <<EOF\nx"), "cat <<EOF\n ");
  // a text that does not parse is returned as it is
  assert.equal(blankHeredocBodies("echo (("), "echo ((");
});

test("a heredoc body naming foreman.json and a gate. key is data on an opaque line", () => {
  const l = "cat > /s/scr/notes.md <<'EOF'\nsee foreman.json: gate.mode\nEOF\n$X && mkdir /s/scr/d";
  assert.notEqual(rule(l), "floor-config-keys");
});

test("a config file named outside the body next to a gate. key still fires", () => {
  const l = "C=/h/me/.pi/agent/foreman.json; cat > \"$C\" <<'EOF'\n{\"gate\":{}}\nEOF\n$X && mkdir d";
  assert.equal(rule(l), "floor-config-keys");
});
