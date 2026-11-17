// A mermaid fence nested in a list item (4 spaces or a tab) is a diagram for the dialog and masked for the jargon rule, as on the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jargonHits, ownerSummary } from "../ownertext.ts";

for (const [name, indent] of [["4-space", "    "], ["tab", "\t"]] as const) {
  test(`${name}-indented mermaid fence in the owner section is a diagram; its jargon is not counted`, () => {
    const plan = `# P\n\n## For the owner\nWe ship it.\n\n- Steps:\n\n${indent}\`\`\`mermaid\n${indent}graph TD\n${indent}A[\`src/foo.ts\`] --> B\n${indent}\`\`\`\n\nDone.\n\n## Next\nx\n`;
    const s = ownerSummary(plan);
    assert.match(s, /\(diagram: see the plan page\)/);
    assert.doesNotMatch(s, /graph TD|foo\.ts/);
    assert.match(s, /Done\./);
    assert.deepEqual(jargonHits(`- Steps:\n\n${indent}\`\`\`mermaid\n${indent}A[\`src/foo.ts\`] --> B\n${indent}\`\`\`\n`), []);
  });
}
