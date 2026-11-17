// Test-side memo of the python version probe (`PROBE_CODE` in python.ts). A rig opens a session per fixture, and each session probed
// the same interpreter again; the probe's answer depends only on the executable it starts and its arguments, so a probe that succeeded
// is answered from memory for the rest of the test process. A failed, timed-out or missing probe is never remembered. Not a test: the
// test glob matches only *.test.ts.
import { lookPath, PROBE_CODE } from "../python.ts";
import { defaultSpawner, type Spawner, type SpawnResult } from "../spawn.ts";

const memo = new Map<string, SpawnResult>();

/** Forgets every remembered probe. */
export function resetProbeMemo(): void {
  memo.clear();
}

/**
 * The spawner of a rig's adapter: a probe is answered from the memo when it succeeded before; any other call goes to `base` as it is.
 * The key is the executable the probe resolves to on this call's PATH (so another PATH or PATHEXT probes again) and the full argument list.
 */
export function probeSpawner(base: Spawner = defaultSpawner): Spawner {
  return async (command, args, options) => {
    if (!args.includes(PROBE_CODE)) return base(command, args, options);
    const env = options.env ?? process.env;
    const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1];
    const resolved = lookPath(command, pathVar, process.platform, env.PATHEXT);
    // a name that is on no PATH: nothing to key on, so the call runs (and fails) as it would without the memo
    if (!resolved) return base(command, args, options);
    const key = JSON.stringify([resolved, args]);
    const hit = memo.get(key);
    if (hit) return { ...hit };
    const r = await base(command, args, options);
    if (!r.error && !r.timedOut && r.code === 0) memo.set(key, r);
    return r;
  };
}
