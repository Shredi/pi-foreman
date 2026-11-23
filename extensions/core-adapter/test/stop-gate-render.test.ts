// Item 2: the stop gate message is drawn as plain text, so a Windows path keeps every backslash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STOP_GATE_TYPE, stopGateRenderer } from "../stopgaterender.ts";
import extension from "../index.ts";

const LEDGER = String.raw`C:\Users\x\pf-live-a\.workflow\LEDGER-steer.md`;
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the renderer keeps every backslash of a Windows ledger path", () => {
  const box = stopGateRenderer({ customType: STOP_GATE_TYPE, content: `Open items in ${LEDGER}.\n- [ ] 1. thing` }, {}, theme);
  const out = strip(box.render(200).join("\n"));
  assert.ok(out.includes(LEDGER), out);
  assert.ok(out.includes("- [ ] 1. thing"));
});

test("the extension registers the renderer for the stop gate type", () => {
  const registered: string[] = [];
  const pi = new Proxy({ registerMessageRenderer: (t: string) => registered.push(t) } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : () => undefined),
  });
  try {
    (extension as unknown as (p: unknown) => unknown)(pi);
  } catch {
    // the factory may need more of the host than this fake offers; registration happens before that point
  }
  assert.deepEqual(registered, [STOP_GATE_TYPE]);
});
