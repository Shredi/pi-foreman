// A variable command word with a literal path tail (`$V/bin/pip`, `"$X/v/bin/ruff"`) is that program, not an unknown one: no delete-unknown-target hit.
// A bare variable command word with a recursive flag, and `$V/bin/rm -rf "$Y"`, stay judge-first hits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";
import { unknownTargetDelete, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const SHAPES = [
  `python3 -m venv "$FOREMAN_SCRATCH/v" && "$FOREMAN_SCRATCH/v/bin/pip" -q install -r requirements.txt 2>&1 | tail -2; "$FOREMAN_SCRATCH/v/bin/ruff" --version; "$FOREMAN_SCRATCH/v/bin/ruff" check .`,
  `V=~/.pi/agent/pi-foreman/v; python3 -m venv $V && $V/bin/pip -q install -r req.txt 2>&1|tail -2; $V/bin/ruff check .`,
  `python3 - <<'E'\nprint(1)\nE\nV=~/.pi/agent/pi-foreman/v; python3 -m venv $V && $V/bin/pip -q install -r req.txt 2>&1|tail -2; $V/bin/ruff check .`,
  `python3 -m venv .venv .venv2 && .venv/bin/pip install -q -r req.txt | tail -2`,
  `$V/bin/pip -q install -r req.txt`,
  `"$FOREMAN_SCRATCH/v/bin/ruff" check .`,
  `.venv/bin/python -m pip install -q -r req.txt`,
  `./v/bin/python -m pip install -q -r req.txt | tail -2`,
  `cd sub && .venv/bin/python -m pip install -r req.txt`,
];
// a variable path in front of the program name: the literal basename (unquoted as the program lookup does) is the program, wrappers behind it unwrap
const BYPASS = [`$V/bin/r"m" -rf /etc`, `$V/bin/'rm' -rf $Y`, `$V/bin/r\\m -rf $Y`, `$V/bin/env rm -rf $Y`, `$V/bin/xargs rm -rf < l`, `$V/bin/nohup rm -rf $Y`];
const STILL = [`$RM -rf x`, `"$CMD" -r d`, `$V/bin/rm -rf "$Y"`];

const env: FloorEnv = { cwd: "/w", home: "/h", agentDir: "/h/.pi/agent", writeRoots: ["/w"], scratch: ["/s"] };
const parse = (line: string) => parseShell(line, { cwd: "/w", env: { FOREMAN_SCRATCH: "/s" } });
const hit = (line: string) => unknownTargetDelete(line, parseShell(line, { cwd: "/w", env: { FOREMAN_SCRATCH: "/s" } }), env);

const config = { providers: { fake: { roles: { review: { model: "m" } } } }, presence: { enabled: false } };
async function rig(t: Parameters<typeof r11Rig>[0], child: boolean) {
  const calls: string[] = [];
  const registry = {
    find: () => ({ id: "m" }),
    getProviderAuthStatus: () => ({ configured: false }),
    complete: async (_m: never, ctx: { messages: { content: string }[] }) => {
      calls.push(ctx.messages[0].content);
      return { content: [{ type: "text", text: JSON.stringify({ verdict: "clear", reason: "t" }) }], stopReason: "stop", usage: { input: 1, output: 1 } };
    },
  };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => undefined, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, hasUI: true }, config, child });
  return { ...r, calls };
}

test("a variable command word with a literal tail is no unknown-target delete", () => {
  for (const line of SHAPES) assert.equal(hit(line), null, line);
});

test("a bare variable command word with a recursive flag, and a variable-prefixed rm, still hit", () => {
  for (const line of STILL) assert.equal(hit(line)?.name, "danger-delete-unknown-target", line);
});

test("a variable path in front of a quoted or escaped program name, or of a wrapper, is that program: the delete hit stays", () => {
  for (const line of BYPASS.filter((l) => !l.includes("/etc"))) assert.equal(hit(line)?.name, "danger-delete-unknown-target", line);
  assert.equal(parse(BYPASS[0])[0].program, "rm");
  assert.equal(parse(BYPASS[3])[0].program, "rm");
  assert.deepEqual(parse(BYPASS[3])[0].wrappers, ["env"]);
});

test("a variable path in front of an interpreter is that interpreter (inline code is read by name)", () => {
  assert.equal(parse(`$V/bin/python -c 1`)[0].program, "python");
  assert.equal(parse(`$V/rm$S -rf x`)[0].program, "$V/rm$S");
});

for (const child of [false, true]) {
  const who = child ? "child" : "foreman";
  test(`the venv shapes run with no judge call (${who})`, async (t) => {
    // the python heredoc is inline code, judge-first on its own kind; the venv tail adds no delete-unknown-target call
    for (const line of SHAPES.filter((l) => !l.startsWith("python3 - <<"))) {
      const r = await rig(t, child);
      await r.call("bash", { command: line });
      assert.equal(r.calls.length, 0, `${who}: ${line}`);
    }
  });
  test(`the still-hit forms keep the judge call (${who})`, async (t) => {
    for (const line of STILL) {
      const r = await rig(t, child);
      await r.call("bash", { command: line });
      if (child) assert.equal(r.calls.length, 1, `${who}: ${line}`);
    }
  });
}

for (const child of [false, true]) {
  test(`the bypass forms keep a judge call or a refusal, an inline interpreter behind a variable path is judged (${child ? "child" : "foreman"})`, async (t) => {
    for (const line of [...BYPASS, `$V/bin/python -c 1`]) {
      const r = await rig(t, child);
      const res = await r.call("bash", { command: line });
      assert.ok(r.calls.length === 1 || res?.block, `${line}: judged or refused`);
    }
  });
  test(`the heredoc shape's judge call is for inline code, not a delete (${child ? "child" : "foreman"})`, async (t) => {
    const r = await rig(t, child);
    await r.call("bash", { command: SHAPES[2] });
    assert.ok(r.calls.every((c) => !/delete-unknown-target|unknown target/.test(c)), r.calls.join("\n").slice(0, 300));
  });
}
