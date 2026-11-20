// PR C step 5: forms that hide a word from the floors, each next to its plain form. A row is the line's verdict through the gate (foreman session, presence off, no UI):
// `ran` (no refusal), `ask` (the owner dialog would open: refused here for want of a pane) or `deny`. The PowerShell rows go through the powershell tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { r11Rig } from "./_r11rig.ts";

async function verdict(t: Parameters<typeof r11Rig>[0], tool: string, command: string): Promise<string> {
  const registry = { find: () => undefined, getProviderAuthStatus: () => ({ configured: false }), complete: async () => { throw new Error("no judge in this test"); } };
  const ui = { notify: () => undefined, confirm: async () => false, select: async () => undefined, input: async () => "", editor: async () => undefined, setStatus: () => undefined, setWidget: () => undefined };
  const r = await r11Rig(t, {}, { ctx: { modelRegistry: registry, ui, hasUI: false }, config: { presence: { enabled: false } } });
  const res = await r.call(tool, { command });
  if (!res?.block) return "ran";
  return /nobody is at this session/.test(String(res.reason)) ? "ask" : "deny";
}

const ROWS: [string, string, string][] = [
  // [tool, line, verdict]
  ["bash", "git push origin main", "deny"],
  ["bash", "git ${V:-push} origin main", "ask"],
  ["bash", "V=push; git ${V:-push} origin main", "ask"],
  ["powershell", "Remove-Item -Recurse -Force C:\\Windows", "deny"],
  ["powershell", "Remove-Item -Recurse -Force 'C:\\Windows' 'a&b'", "deny"],
  ["powershell", "Remove-Item -Recurse -Force C:\\Windows 'a;b'", "deny"],
  ["powershell", "Remove-Item -Recurse:$true C:\\Windows", "deny"],
  ["powershell", "Remove-Item -Recurse:$false C:\\Windows", "deny"], // not the system-folder floor: the foreman's shell write is refused
  ["bash", "pwsh -c 'Remove-Item -Recurse C:\\Windows'", "deny"],
  ["bash", "pwsh -c 'Remove-Item -Recurse C:\\Windows \"a&b\"'", "deny"], // the quoted & inside a pwsh -c script: the system-folder floor misses it (psUnits drops the unit), the refusal of an unreadable delete still denies
];

test("hidden-word forms next to their plain forms", async (t) => {
  const got: string[] = [];
  for (const [tool, line] of ROWS) got.push(`${tool}: ${line} => ${await verdict(t, tool, line)}`);
  assert.deepEqual(got, ROWS.map(([tool, line, v]) => `${tool}: ${line} => ${v}`));
});
