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
// the burner recursion leaves less and less stack for the parse as `k` shrinks: walk the headroom k up one frame at a time from "no room" until the parse reads the whole line, then a long run of full reads further,
// so the transition zone where the parse itself runs out is covered on any platform (frame sizes differ by engine tier)
const FULL = 5;
let fullAt = -1;
let run = 0;
let k = 0;
for (; k < total - 60; k++) {
  let r;
  try {
    r = at(total - k - 60, line);
  } catch {
    r = { overflowedOutside: true };
  }
  results.push(r);
  // the transition is ragged (the parse alternates between overflowing and finishing), so stop only after a long unbroken run of full reads
  if (r.segments === FULL && !r.tooDeep) {
    if (fullAt < 0) fullAt = k;
    if (++run >= 300) break;
  } else run = 0;
}
console.log(JSON.stringify({ total, scannedTo: k, fullAt, results }));
