// The owner dialog drawn by Pi's real selector component with Pi's dark theme at full colour: only the question line is bold,
// the link is an OSC 8 link, and Pi's own terminal probe (PI_HYPERLINKS) decides the links. The environment is set before the imports
// because chalk and the capability probe read it once.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.FORCE_COLOR = "3";
process.env.PI_HYPERLINKS = "1";
const pi = await import("@earendil-works/pi-coding-agent");
// Pi's theme singleton is not exported from the package entry; it is the module the selector component itself draws with
const themeModule = (await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href)) as {
  theme: { fg(t: string, s: string): string; underline(s: string): string };
};
const { dialogStyle, ownerDialog } = await import("../ownerdialog.ts");
pi.initTheme("dark");
const { theme } = themeModule;

test("real theme: SGR 1 (bold) only on the question line; the link and the answers line are styled", () => {
  const { ask, body } = ownerDialog(
    {
      ask: "Approve the plan for demo?",
      summary: "Builders start only after you approve.",
      facts: [["Plan", "Demo"], ["Review", "passed"]],
      links: [{ label: "Plan page", path: "/tmp/pages/demo/plan.html", text: "open the plan page", kind: "page" }],
      detail: ["a dim line"],
      answers: "revise: you say what to change   approve: builders start",
    },
    { theme, links: true },
    false,
  );
  const lines = new pi.ExtensionSelectorComponent(ask, ["revise", "reject", "approve"], () => undefined, () => undefined, { description: body }).render(100);
  const bold = lines.filter((l) => l.includes("\x1b[1m"));
  assert.equal(bold.length, 1, lines.join("\n"));
  assert.match(bold[0], /Approve the plan for demo\?/);
  const text = lines.join("\n");
  assert.match(text, /\x1b\]8;;file:\/\/\/tmp\/pages\/demo\/plan\.html\x1b\\/);
  assert.match(text, /\x1b\[4m/, "the link is underlined");
});

test("PI_HYPERLINKS=1 makes Pi's own probe report links, and dialogStyle follows it", () => {
  assert.equal(dialogStyle({ theme, custom: () => undefined } as never, "tui")?.links, true);
});
