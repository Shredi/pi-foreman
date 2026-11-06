# Host pressure gate

> Covers the `resources` keys, the host pressure levels, what the launch gate does at `high` and `critical`, the surfaces
> that show it and the trace events.
> Layer rules are in [safety](safety.md); fan-out and the ladder are in [ladder](ladder.md).

A sampler in the foreman session measures the host every `resources.sampleSeconds` and writes
`<agent dir>/pi-foreman/state/pressure.json`. The child-launch path only reads that file. A missing, unreadable or stale file
(older than 3 x `sampleSeconds`) counts as `ok`: a dead sampler never blocks work. Parallel full test suites are a common cause of load; `npm run test:node` and `npm test` queue behind a machine-wide test lock (see [development](development.md#tests)).

## Keys

| key | default | meaning |
|---|---|---|
| `resources.maxLoadPerCore` | 1.5 | Load average per core above which pressure is `high`. Both the 5-minute and the 1-minute value must be above it, so a short burst does not trip the limit and a load that has already dropped stops gating at once. |
| `resources.minFreeMemMB` | 1024 | Free memory (MB) below which pressure is `high`. |
| `resources.minFreeDiskGB` | 5 | Free disk (GB) of the workspace below which pressure is `high`. |
| `resources.sampleSeconds` | 30 | Sampling interval, integer of at least 5. User or overlay config only. |

The project layer can only tighten: it may lower `maxLoadPerCore` and raise `minFreeMemMB` and `minFreeDiskGB`; it cannot set `sampleSeconds`.

## Levels

- `high`: a limit is crossed (`load`, `mem` or `disk`). `load` needs both the 5-minute and the 1-minute load per core above `maxLoadPerCore`.
- `critical`: both load values are at least twice `maxLoadPerCore`, or free memory or disk is below half its limit.
- `ok`: nothing is crossed, or a probe is `unknown` (a field whose probe fails is skipped, never counted as a hit).

## What the gate does

- Explorers are never gated: an explorer-only launch (a single `explorer`, or `tasks`/`chain` whose every entry is an explorer) runs at any level, is never queued or deferred and leaves no pressure trace event. A mixed call stays gated.
- `high`: child launches run one at a time. The first gated launch of an assistant message runs (explorers do not count for that slot); the others are refused with a
  queued reason and a `pressure` wait wakes the foreman, with their arguments, once no run is active so it can relaunch them.
  A `tasks` call keeps its first task and queues the rest. Pressure delays a launch, it never downgrades one: every climb (explicit strong, RUNG_UP handoff, revision after a FAIL, sizing) keeps its strong or top rung.
- `critical`: a launch is deferred (refused with a reason). A `pressure` wait wakes the foreman with the launch arguments when the
  level drops, or after 10 minutes at the latest.
- `foreman_bg` and the add-on's `bg_run` are not gated: they are your own shell commands.

## Surfaces

- `foreman doctor` / `/foreman doctor`: `INFO pressure: <level> (<reasons or none>) load5/core=<x> load1/core=<y> freeMem=<n>MB freeDisk=<n>GB`
  from a fresh sample; unknown fields print `unknown`. It never fails on a missing probe.
- `/foreman status`: `pressure: <level> (<reasons>) sampled <age>s ago`, the open waits count and the ceremony tier.
- Herdr sidebar: the cost row gets ` ⚠ <reasons>` only when the level is not `ok` (the presence file carries a `pressure` field then).
- Retro: `pressure: deferred N, narrowed M` from the trace events below. The line is omitted when both are 0.

## Trace events

`launch_narrowed` (width 1, reasons), `launch_deferred` (level, reasons), and
`pressure_sampler` (the first sampler failure, once). `climb_suppressed` is no longer emitted (the trace key stays, unused).

## Probes

| OS | load | free memory | free disk |
|---|---|---|---|
| Linux | `os.getloadavg` (the 5-minute and the 1-minute value must both be over the limit) | `/proc/meminfo` `MemAvailable` | `shutil.disk_usage` of the workspace |
| macOS | `os.getloadavg` (same) | `vm_stat` free + inactive + speculative pages | `shutil.disk_usage` |
| Windows | none (`unknown`) | `GlobalMemoryStatusEx` | `shutil.disk_usage` |

A probe that fails reports `unknown` and takes no part in the level. Everything is standard library, no dependency.
