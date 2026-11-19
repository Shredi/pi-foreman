// Spawner for rigs whose cases do not test the python guards: the spawn gate (ledger_guard_spawn.py) answers "no opinion" (empty stdout, exit 0,
// which the adapter reads as allow); when `memoConfig` is set, the config CLI (foreman_config.py merged) runs once per argument list; when
// `noFindings` is set, the run-end findings record (foreman_findings.py record) answers "no findings" (for reports that name no file, which is
// what the script would find).
// Everything else (the version probe memo, git, the other scripts) goes to probeSpawner as it is. For a case whose condition does not depend
// on the guard's answer or on a changed config; a case that asserts a guard's decision keeps the real spawner. Not a test: the test glob
// matches only *.test.ts.
import { probeSpawner } from "./_probe-memo.ts";
import type { Spawner, SpawnResult } from "../spawn.ts";

const ALLOW: SpawnResult = { code: 0, stdout: "", stderr: "", timedOut: false };

export function lightSpawner(o: { memoConfig?: boolean; noFindings?: boolean } = {}): Spawner {
  const base = probeSpawner();
  const memo = new Map<string, SpawnResult>();
  return async (command, args, options) => {
    if (args.some((a) => /ledger_guard_spawn\.py$/.test(a))) return { ...ALLOW };
    if (o.noFindings && args.some((a) => /foreman_findings\.py$/.test(a)) && args.includes("record")) return { ...ALLOW, stdout: '{"findings":[]}' };
    if (o.memoConfig && args.some((a) => /foreman_config\.py$/.test(a)) && args.includes("merged")) {
      const key = JSON.stringify(args);
      const hit = memo.get(key);
      if (hit) return { ...hit };
      const r = await base(command, args, options);
      if (!r.error && !r.timedOut && r.code === 0) memo.set(key, r);
      return r;
    }
    return base(command, args, options);
  };
}
