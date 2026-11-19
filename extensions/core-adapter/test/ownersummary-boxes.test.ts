// The checkpoint dialog shows the alert boxes of the owner section as plain lines, and the jargon hint ignores the markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jargonHits, ownerSectionIssues, ownerSummary } from "../ownertext.ts";

const PLAN = "# P\n\n## For the owner\n\n**Goal:** Uploads try again.\n\n1. Three tries.\n2. One message.\n\n> [!WARNING]\n> **Heads-up**\n>\n> - A slow network takes longer.\n\n> [!note]  \n> **Decided for you**\n>\n> - Three tries.\n\n> A plain quote stays quoted.\n\n## Work\n\nx\n";

test("ownerSummary: an alert shows its label and items, with no marker line and no quote prefix", () => {
  const s = ownerSummary(PLAN);
  assert.equal(s, ["For the owner", "  **Goal:** Uploads try again.", "  1. Three tries.", "  2. One message.", "  **Heads-up**", "  - A slow network takes longer.", "  **Decided for you**", "  - Three tries.", "  > A plain quote stays quoted."].join("\n"));
  assert.doesNotMatch(s, /\[!/);
});

test("ownerSummary: a quote right after an alert's body that is not part of it keeps its prefix", () => {
  const s = ownerSummary("## For the owner\n\n> [!TIP]\n> **Decided by you**\n\nText.\n> quoted\n");
  assert.match(s, /\n {2}\*\*Decided by you\*\*\n {2}Text\.\n {2}> quoted$/);
});

test("jargon: alert markers give no hit, and the owner section with boxes has no issue", () => {
  assert.deepEqual(jargonHits("> [!WARNING]\n> **Heads-up**\n> - [!NOTE]\n> [!IMPORTANT]\n> [!CAUTION]"), []);
  assert.deepEqual(ownerSectionIssues(PLAN), []);
});
