# Host pressure gate

> Covers the `resources` keys, the host pressure levels, what the launch gate does at `high` and `critical`, the surfaces
> that show it and the trace events.
> Layer rules are in [safety](safety.md); fan-out and the ladder are in [ladder](ladder.md).

A sampler in the foreman session measures the host every `resources.sampleSeconds` and writes
`<agent dir>/pi-foreman/state/pressure.json`. The child-launch path only reads that file. A missing, unreadable or stale file
(older than 3 x `sampleSeconds`) counts as `ok`: a dead sampler never blocks work.

## Keys

| key | default | meaning |
|---|---|---|
| `resources.maxLoadPerCore` | 1.5 | 5-minute load average per core above which pressure is `high`. The 1-minute value is shown for information and never gates, so a short burst (parallel test runs) does not trip the limit. |
| `resources.minFreeMemMB` | 1024 | Free memory (MB) below which pressure is `high`. |
| `resources.minFreeDiskGB` | 5 | Free disk (GB) of the workspace below which pressure is `high`. |
| `resources.sampleSeconds` | 30 | Sampling interval, integer of at least 5. User or overlay config only. |

The project layer can only tighten: it may lower `maxLoadPerCore` and raise `minFreeMemMB` and `minFreeDiskGB`; it cannot set `sampleSeconds`.

## Levels

- `high`: a limit is crossed (`load`, `mem` or `disk`).
- `critical`: load is at least twice `maxLoadPerCore`, or free memory or disk is below half its limit.
- `ok`: nothing is crossed, or a probe is `unknown` (a field whose probe fails is skipped, never counted as a hit).

## What the gate does

- `high`: child launches run one at a time. The first launch of an assistant message runs; the others are refused with a
  queued reason and a `pressure` wait wakes the foreman, with their arguments, once no run is active so it can relaunch them.
  A `tasks` call keeps its first task and queues the rest. No strong-rung climb happens while pressure is high.
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

`launch_narrowed` (width 1, reasons), `launch_deferred` (level, reasons), `climb_suppressed` (level `high`, reasons) and
`pressure_sampler` (the first sampler failure, once).

## Probes

| OS | load | free memory | free disk |
|---|---|---|---|
| Linux | `os.getloadavg` (5-minute value gates, 1-minute is informational) | `/proc/meminfo` `MemAvailable` | `shutil.disk_usage` of the workspace |
| macOS | `os.getloadavg` (same) | `vm_stat` free + inactive + speculative pages | `shutil.disk_usage` |
| Windows | none (`unknown`) | `GlobalMemoryStatusEx` | `shutil.disk_usage` |

A probe that fails reports `unknown` and takes no part in the level. Everything is standard library, no dependency.
