// Review bench helper (scripts/foreman_review_bench.py): runs the harness's own diff-fact scan
// (extensions/core-adapter/diffscan.ts) and the child scratch line
// (childscratch.ts) for one prepared repo, so the bench composes the reviewer task with the real
// code instead of a port. Node 22 runs the .ts imports directly, as `npm run test:node` does.
//
//   node bench/review_facts.mjs <repo dir> <base sha> [scratch dir]
//
// Prints one JSON object: {block, count, base, scratch}. `block` is "" when the scan found
// no fact; `scratch` is "" without a scratch dir.
import { collectFacts } from "../extensions/core-adapter/diffscan.ts";
import { scratchPromptBlock } from "../extensions/core-adapter/childscratch.ts";

const [cwd, base, scratchDir] = process.argv.slice(2);
if (!cwd || !base) {
  process.stderr.write("usage: node bench/review_facts.mjs <repo dir> <base sha> [scratch dir]\n");
  process.exit(2);
}
const facts = await collectFacts(cwd, base);
const scratch = scratchDir ? scratchPromptBlock(scratchDir) : "";
process.stdout.write(JSON.stringify({ block: facts.block, count: facts.count, base: facts.base, scratch }) + "\n");
