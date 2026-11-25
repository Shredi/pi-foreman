// Run with a small `--stack-size`: parses a harmless line at stack depths that end in a stack overflow somewhere inside parseShell, and prints what came back.
import { parseShell } from "../../shellast.ts";

let total = 0;
const probe = () => {
  total++;
  probe();
};
try {
  probe();
} catch (e) {
  if (!(e instanceof RangeError)) throw e;
}
function at(depth, line) {
  if (depth > 0) return at(depth - 1, line);
  try {
    const segs = parseShell(line, { platform: "linux" });
    return { segments: segs.length, opaque: segs[0]?.opaque ?? null, tooDeep: !!segs[0]?.tooDeep };
  } catch (e) {
    return { threw: e?.constructor?.name ?? "?" };
  }
}
const line = "echo $(echo $(echo hi)); ls | wc -l";
const results = [];
// the burner recursion leaves less and less stack for the parse: the scan covers the band where the parse itself runs out
for (let k = 0; k < 1500; k += 3) {
  let r;
  try {
    r = at(Math.max(0, total - k - 60), line);
  } catch {
    r = { overflowedOutside: true };
  }
  results.push(r);
}
console.log(JSON.stringify(results));
