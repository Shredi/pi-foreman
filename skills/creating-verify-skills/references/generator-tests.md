# Generator tests

A generator test builds many inputs by itself, asks the real code about each, and checks one rule. It fits the question "does the rule hold for every input of this shape, up to a depth". It needs no install and runs in the project's test runner.

## Contents

- Seeded random source
- Composition
- Oracle through the real entry point
- The twin property against false alarms
- Self-check of the generator
- Shrinking
- Failure output
- Expected-fail marks
- Budget and the opt-in sweep
- Sketch

## Seeded random source

Use a tiny seeded generator (mulberry32 or an xorshift, about ten lines) and no dependency. The same seed must give the same cases on every machine, so a CI failure replays locally. Read the seed from an environment variable with a fixed default; the default run is deterministic, a sweep passes other seeds.

## Composition

Describe the inputs as two lists:

- payloads: the things the rule is about (for a gate: seven dangerous commands, each a different kind of harm);
- constructs: the ways the input can be wrapped or disguised (for a gate: command substitution, here-doc, `xargs sh -c`; for a parser: nesting, escapes, odd whitespace).

A construct is a function from a payload to a new input. Compose to a depth: depth 1 is every construct on every payload (exhaustive, small); depth 2 and 3 are a seeded sample of chains, because the full product grows too fast. Keep a construct that cannot wrap a payload (it is a complete input of its own) as a separate kind, so it takes part in the danger property only.

## Oracle through the real entry point

The oracle is the production function a caller would use, not a part of it. Map its answer to a few classes ordered by strictness (for a gate: silent, judged, asked, blocked). State the rule over the classes ("a dangerous input is never silent"). If the real entry point is slow or needs a heavy setup, run a small sample through the full path as well and assert that the fast oracle agrees with it class by class; that ties the fast check to the real one.

Add a precondition per payload: the plain payload, with no wrapper, already has the class the rule demands. A payload that fails it is dropped and reported, since a wrapper cannot be blamed for what the plain input already does.

## The twin property against false alarms

A check that only says "block more" is passed by blocking everything. Pair each payload with a harmless twin (same wrapper, safe content) and pin the exact class the code gives it today, per construct, from a measured run. The check fails when a twin gets stricter. A twin that gets looser is not a failure of this property; the danger property guards that side.

For chains built only of constructs that are harmless today, pin the share that is not in the loosest class, with a stated tolerance (the measured share plus a few percentage points, written in the test with the reason). The tolerance absorbs sample noise and small intended changes and still catches a new wave of false alarms.

When a change makes a twin stricter on purpose, the owner of that change edits the pinned class; say so in the failure message.

## Self-check of the generator

Each construct declares what it needs to run for real (a minimum interpreter version, the external programs it starts) as data on the construct. A self-check builds each construct with a marker payload (create a file in a temp folder), runs it in the real interpreter with a time limit and closed stdin, and asserts the marker ran. When the needs are not met on this machine, assert only that the syntax is accepted. A construct that does not run its payload is a generator fault; it fails here and not in the danger property, which is how a generator fault is told from a real finding. Give every real run its own empty working folder and check the marker by absolute path.

## Shrinking

On a failure, reduce the chain by dropping one construct at a time while it still fails, until no drop keeps the failure (a fixed point). Report the shrunk form; a single construct on a single payload is the usual end.

## Failure output

Print everything needed to replay and to report: the seed, the chain index, the construct names, the shrunk input, the class got and the class wanted, and the rerun line with the seed variable set. A reader should reproduce the failure by pasting that line.

## Expected-fail marks

A table of known open findings. An entry has a shape (one construct, or an ordered pair; optional payload names), an id the test defines, and the source it stands for (a brief, an issue, or "new, found by the generator").

- A failure whose shrunk shape matches an entry is expected and does not fail the run.
- A failure with no entry fails the run.
- Strict stale rule: collect the shrunk shapes of all failures of the deterministic set (depth 1, the pairs that have entries, and the default-seed sample). An entry that matches none fails the run with "gap `<id>` is closed: remove its line". Run this check only with the default seed, so a sweep with other seeds never reports a stale mark.
- Add an entry only for a shape that fails in a measured run. A listed gap that does not reproduce gets no entry; report it as not reproduced.
- A mark without payload names covers every payload of its shape; list that blind spot in the left-out list until the gap closes.

## Budget and the opt-in sweep

The default run covers depth 1 in full plus a sample sized to finish in seconds on the slowest CI runner (measure; write the counts and the timing in the verify skill). The sweep is a separate script that runs the same test file with many seeds and larger samples. It is never part of the default test command or CI.

## Sketch

```ts
function rng(seed: number) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Wrap = (payload: string) => string;
const build = (chain: Wrap[], payload: string) => chain.reduceRight((acc, wrap) => wrap(acc), payload);

function shrink(chain: Wrap[], fails: (c: Wrap[]) => boolean): Wrap[] {
  for (let i = 0; i < chain.length; i++) {
    const shorter = chain.filter((_, j) => j !== i);
    if (shorter.length && fails(shorter)) return shrink(shorter, fails); // restart from the shorter chain
  }
  return chain; // fixed point: no single drop keeps the failure
}

function check(oracle: (input: string) => number, payloads: string[], wraps: Wrap[], seed: number) {
  const next = rng(seed);
  const pick = () => wraps[Math.floor(next() * wraps.length)];
  for (let i = 0; i < 300; i++) {
    const payload = payloads[i % payloads.length];
    const fails = (c: Wrap[]) => oracle(build(c, payload)) === 0; // 0 = silent; the rule says never
    const chain = [pick(), pick()];
    if (fails(chain)) {
      const small = shrink(chain, fails);
      throw new Error(`seed ${seed} index ${i}: ${build(small, payload)}\nrerun: GEN_SEED=${seed} <test command>`);
    }
  }
}
```
