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

The status strip of the herdr-app Agents view shows the same host numbers (CPU, memory, disks, this level); see [herdr](herdr.md#status-strip).

The project layer can only tighten: it may lower `maxLoadPerCore` and raise `minFreeMemMB` and `minFreeDiskGB`; it cannot set `sampleSeconds`.

## Levels

- `high`: a limit is crossed (`load`, `mem` or `disk`). `load` needs both the 5-minute and the 1-minute load per core above `maxLoadPerCore`.
- `critical`: both load values are at least twice `maxLoadPerCore`, or free memory or disk is below half its limit.
- `ok`: nothing is crossed, or a probe is `unknown` (a field whose probe fails is skipped, never counted as a hit).

## What the gate does

- Explorers are never gated: an explorer-only launch (a single `explorer`, or `tasks`/`chain` whose every entry is an explorer) runs at any level, is never queued or deferred and leaves no pressure trace event; the one exception is a `pressureOverride` field on such a launch, which is removed and traced as `pressure_override` `not_needed` (see [owner approval at critical](#owner-approval-at-critical)). A mixed call stays gated.
- `high`: child launches run one at a time. The first gated launch of an assistant message runs (explorers do not count for that slot); the others are refused with a
  queued reason and a `pressure` wait wakes the foreman, with their arguments, once no run is active so it can relaunch them.
  A `tasks` call keeps its first task and queues the rest. Pressure delays a launch, it never downgrades one: every climb (explicit strong, RUNG_UP handoff, revision after a FAIL, sizing) keeps its strong or top rung.
- `critical`: a launch is deferred (refused with a reason). A `pressure` wait wakes the foreman with the launch arguments when the
  level drops, or after 10 minutes at the latest. The refusal tells the session how to ask the owner for one launch (below).
- The add-on's `bg_run` is not gated: it is your own shell command.

## Owner approval at critical

A launch deferred at `critical` can start anyway when the owner says Yes in a dialog. Nothing is stored: one Yes is one launch.

- The session adds the top-level key `pressureOverride: "<why this launch cannot wait>"` to its `subagent` call. The harness removes the key before anything else sees the call (pi-subagents, a wake's relaunch JSON and the `high` queue never carry it), at every level and in every session.
- The dialog (Yes first, no time limit; it opens in this pane in the `tui` or `rpc` mode, the same test as `foreman_checkpoint`) shows the agent, the first line of the task, the reason (each cut to 300 characters) and the 1-minute and 5-minute load per core with `resources.maxLoadPerCore`. Yes starts this launch now; No keeps it deferred as above. Escape or an abort also keeps it deferred.
- The session never approves its own request: only the dialog answer counts, and there is no flag or config key that stands in for it.
- It is possible only when: the level is `critical` and the only reason is `load` (a memory or disk cause cannot be approved); the call is one new launch with `agent` and `task` at the top level (no `tasks`, `chain`, `parallel`, `workflow`, no `action`, so no resume; a field found only inside an entry does not count); the session can show the dialog (a headless session has no owner at its pane); and the owner did not decline or dismiss an earlier request since their last prompt (an `input` of source `interactive` or `rpc` clears this). Otherwise no dialog opens, the launch is deferred as above and the refusal names why.
- A refusal without the field names the way out in one added sentence when it is possible, and says why not when it is not.
- A No, an Escape or an abort starts no second wait when an equal deferred launch already has one (and none when the call was aborted).
- An approval is spent at the end of the call: if the launch started, the open critical wait for the same arguments is cancelled (the session is not told to start it again); if a later check refused it (for example `worktree: true` in a nested submodule checkout), the approval is gone and the wait stays.
- At `ok` or `high`, for an explorer-only launch and in a subagent child the field is just removed.

## Surfaces

- `foreman doctor` / `/foreman doctor`: `INFO pressure: <level> (<reasons or none>) load5/core=<x> load1/core=<y> freeMem=<n>MB freeDisk=<n>GB`
  from a fresh sample; unknown fields print `unknown`. It never fails on a missing probe.
- `/foreman status`: `pressure: <level> (<reasons>) sampled <age>s ago`, the open waits count and the ceremony tier.
- Herdr sidebar: the cost row gets ` ⚠ <reasons>` only when the level is not `ok` (the presence file carries a `pressure` field then).
- Retro: `pressure: deferred N, narrowed M` from the trace events below. The line is omitted when both are 0.

## Trace events

`launch_narrowed` (width 1, reasons), `launch_deferred` (level, reasons), and
`pressure_sampler` (the first sampler failure, once). `pressure_override` records each request and answer: `decision` is `approved`, `declined` (No), `dismissed` (Escape, abort or a failed dialog), `unavailable` (with `reason` `no_ui`, `cause`, `shape` or `declined_recently`), `not_needed` (with `reason` `level`, `explorer`, `child` or `action`), then `launched` or `not_launched` once per approval; the fields are `agent`, `hash` (the first 16 hex of the sha256 of the task), `level` and `reasons`, never the task or the reason text. The dialog also leaves a `dialog` record with `surface` `pressure_override`. `climb_suppressed` is no longer emitted (the trace key stays, unused).

## Probes

| OS | load | free memory | free disk |
|---|---|---|---|
| Linux | `os.getloadavg` (the 5-minute and the 1-minute value must both be over the limit) | `/proc/meminfo` `MemAvailable` | `shutil.disk_usage` of the workspace |
| macOS | `os.getloadavg` (same) | `vm_stat` free + inactive + speculative pages | `shutil.disk_usage` |
| Windows | none (`unknown`) | `GlobalMemoryStatusEx` | `shutil.disk_usage` |

A probe that fails reports `unknown` and takes no part in the level. Everything is standard library, no dependency.
