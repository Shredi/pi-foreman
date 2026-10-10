// Review bench helper (scripts/foreman_review_bench.py): runs the harness's own diff-fact scan
// and owner block (extensions/core-adapter/diffscan.ts) and the child scratch line
// (childscratch.ts) for one prepared repo, so the bench composes the reviewer task with the real
// code instead of a port. Node 22 runs the .ts imports directly, as `npm run test:node` does.
//
//   node bench/review_facts.mjs <repo dir> <base sha> <owner text file> [scratch dir]
//
// Prints one JSON object: {block, count, base, owner, scratch}. `block` is "" when the scan found
// no fact; `scratch` is "" without a scratch dir.
import { readFileSync } from "node:fs";
import { collectFacts, ownerBlock } from "../extensions/core-adapter/diffscan.ts";
import { scratchPromptBlock } from "../extensions/core-adapter/childscratch.ts";

const [cwd, base, ownerFile, scratchDir] = process.argv.slice(2);
if (!cwd || !base || !ownerFile) {
  process.stderr.write("usage: node bench/review_facts.mjs <repo dir> <base sha> <owner text file> [scratch dir]\n");
  process.exit(2);
}
const facts = await collectFacts(cwd, base);
const owner = ownerBlock(readFileSync(ownerFile, "utf8"));
const scratch = scratchDir ? scratchPromptBlock(scratchDir) : "";
process.stdout.write(JSON.stringify({ block: facts.block, count: facts.count, base: facts.base, owner, scratch }) + "\n");
