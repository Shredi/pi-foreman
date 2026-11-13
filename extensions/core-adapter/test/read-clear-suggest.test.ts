// The read question in the decision log as `perms suggest` and `/retro` read it: no read-clear row is costly, a first row the read question cleared is
// not costly, a call it did not clear counts as before. Neutral fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { costlyIn, readClearHint, suggest, suggestHint, SUGGEST_AFTER, type LogRow } from "../permssuggest.ts";
import { gateLogFile } from "../gatelog.ts";

const row = (o: Partial<LogRow>): LogRow => ({ ts: 1, session: "s", tool: "bash", layer: "classifier", verdict: "ask", rule: "model", shape: "grep <v> *.ts", ...o });

test("a first-call row the read question cleared is not costly; a non-clear keeps its first row and its dialog row costly", () => {
  const first = row({ id: "a1" });
  const clear = row({ id: "a2", follows: "a1", verdict: "allow", rule: "read-clear" });
  const first2 = row({ id: "b1" });
  const refuse = row({ id: "b2", follows: "b1", rule: "read-clear:invalid_verdict" });
  const dialog = row({ id: "b3", layer: "dialog", verdict: "allow", rule: "dialog" });
  const costly = costlyIn([first, clear, first2, refuse, dialog]);
  assert.equal(costly(first), false);
  assert.equal(costly(clear), false);
  assert.equal(costly(refuse), false);
  assert.equal(costly(first2), true);
  assert.equal(costly(dialog), true);
});

test("the /retro line counts clears of the last week and names the switch; none gives no line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-suggest-"));
  const now = Date.now();
  assert.equal(readClearHint(dir, now), null);
  const f = gateLogFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rows = [
    row({ ts: now - 1000, verdict: "allow", rule: "read-clear" }),
    row({ ts: now - 2000, verdict: "allow", rule: "read-clear", layer: "cache" }),
    row({ ts: now - 3000, rule: "read-clear:model" }),
    row({ ts: now - 30 * 86_400_000, verdict: "allow", rule: "read-clear" }),
  ];
  fs.writeFileSync(f, rows.map((r) => JSON.stringify({ ...r, ts: new Date(r.ts).toISOString() })).join("\n") + "\n");
  const line = readClearHint(dir, now) ?? "";
  assert.match(line, /^2 shell lines/);
  assert.match(line, /gate\.readClear false/);
});

// `perms suggest` and the /retro hint end to end: calls as rows, with a `model` and with a `no_entries` first row.
const NOW = Date.now();
type Kind = "cleared" | "refused";
/** One call of session `s`: the first-call row, then (when `withRead`) the read-clear row, then the dialog row of a call that was not cleared. */
function callRows(n: number, s: string, firstRule: string, kind: Kind, withRead: boolean): LogRow[] {
  const id = `${s}-${n}`;
  const first = row({ id: `${id}-1`, ts: NOW - 1000 * (n + 1), session: s, rule: firstRule });
  if (kind === "cleared") return [first, ...(withRead ? [row({ id: `${id}-2`, follows: first.id, ts: first.ts, session: s, verdict: "allow", rule: "read-clear" })] : [])];
  return [
    first,
    ...(withRead ? [row({ id: `${id}-2`, follows: first.id, ts: first.ts, session: s, rule: "read-clear:model" })] : []),
    row({ id: `${id}-3`, ts: first.ts, session: s, layer: "dialog", verdict: "allow", rule: "dialog" }),
  ];
}
const callsOf = (firstRule: string, kind: Kind, withRead: boolean, count = 4): LogRow[] =>
  Array.from({ length: count }, (_, i) => callRows(i, i % 2 ? "s1" : "s2", firstRule, kind, withRead)).flat();

for (const firstRule of ["model", "no_entries"]) {
  test(`perms suggest, first row ${firstRule}: a cleared call adds no candidate; a call that was not cleared adds the hits it adds without the read-clear row`, () => {
    const opts = { now: NOW, minHits: 1 };
    const cleared = suggest(callsOf(firstRule, "cleared", true), opts);
    assert.equal(cleared.candidates.length, 0);
    assert.equal(cleared.costly, 0);
    const refused = suggest(callsOf(firstRule, "refused", true), opts);
    const plain = suggest(callsOf(firstRule, "refused", false), opts);
    assert.ok(plain.candidates.length > 0);
    assert.deepEqual(refused.candidates.map((c) => c.hits), plain.candidates.map((c) => c.hits));
    assert.equal(refused.costly, plain.costly);
    // a mix: the cleared calls add nothing to the refused calls' hits
    const mixed = suggest([...callsOf(firstRule, "refused", true), ...callsOf(firstRule, "cleared", true).map((r) => ({ ...r, id: `x${r.id}`, follows: r.follows ? `x${r.follows}` : "" }))], opts);
    assert.deepEqual(mixed.candidates.map((c) => c.hits), plain.candidates.map((c) => c.hits));
  });

  test(`the /retro hint, first row ${firstRule}: cleared calls add no count; a call that was not cleared counts as without the read-clear row`, () => {
    const hintOf = (rows: LogRow[]): string | null => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hint-"));
      const f = gateLogFile(dir);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, rows.map((r) => JSON.stringify({ ...r, ts: new Date(r.ts).toISOString() })).join("\n") + "\n");
      return suggestHint(dir, NOW);
    };
    const n = SUGGEST_AFTER;
    assert.equal(hintOf(callsOf(firstRule, "cleared", true, n)), null, "cleared calls alone never reach the threshold");
    const refused = hintOf(callsOf(firstRule, "refused", true, n));
    assert.match(refused ?? "", new RegExp(`^${2 * n} decisions`));
    assert.equal(refused, hintOf(callsOf(firstRule, "refused", false, n)));
  });
}
