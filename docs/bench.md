# Benchmark (`foreman bench`)

> Covers the Harbor-based benchmark runner, its trace-derived columns, post steps and price tiers.
> Read it when you measure a change to the harness; ordinary users do not need it.
> Needs `uv tool install harbor` and local Docker; Harbor telemetry is always switched off.

## Running

`python scripts/foreman_bench.py run --preset bench/presets/smoke.json` runs the preset's rows over a
[Harbor](https://github.com/harbor-framework/harbor) task dir (`--tasks DIR` or `bench.tasks_dir`) in local
Docker; a second `run` resumes, `table` prints the counters (success, tokens, wall time, tool calls,
approvals, guard blocks). Needs `uv tool install harbor`; Harbor telemetry is always switched off. The
Harbor agents live in `bench/harbor_agent.py` and are not part of the installed package.

`--dry-run` prints the cell order, `--token-cap N` stops cleanly (exit 4) once finished cells used N
tokens (two consecutive infrastructure-error cells stop it with exit 5), `--setup-only` installs one cell's agent and runs zero-model checks without a prompt.
`bench/tasks/m1-recheck` re-checks the M1 standard task (ledger, explorer, builder, reviewer).

## Columns

Trace-derived columns include `ceremony_incomplete`, `read_blocks`, `recheck_blocks`, `finish_refused`,
`launch_waits`, `rereviews` (reviewer launches while the review step was re-opened) and `orient_lines`
(lines in the orientation packet, 0 if none), `ledger_calls` and `ledger_denies` (the foreman's own `foreman_ledger` and shell `ledger` calls, and those refused; child denies stay in `asks_denied`), `dup_reviews` (reviewer launches refused as duplicates), `second_opinions` and `stop_hold`. `tier` is read from the foreman's own trace only (its `triage` event, else its last `tier` event); a trace file whose `session_start` has role `child` is ignored for it. A foreman row's user-layer `foreman.json` is generated from the row: `foreman_edits`, `foreman_reads`, `recheck_budget`, `launch_wait` and `dedupe_notify` map to their ceremony knobs, and a `user_config` object is deep-merged in last, so a row can set any knob (the eee843d-equivalent row: `"user_config": {"ceremony": {"ledgerHelper": "off", "reviewPerRevision": false, "heavyThreshold": "eee843d"}}`).

Other counters: `rung_up`, `child_read_warn`/`child_read_deny` (trace `child_read_budget`), `review_defer_headless`, `child_turn_cap`, `launch_refused`, `thinking_by_role` (levels the sessions ran with), `tier_dist`, `cache_write_per_launch` (median cache-write tokens per launch).

## Cost and post steps

Cost uses `bench/prices.json`; Haiku 5.5's long-context tier (prompts above 100k tokens) is applied per request from the usage log (rows without it are priced flat and flagged `tier_approx`). Permission auto-review calls are logged with role `autoreview` (columns `autoreview_tokens`, `autoreview_calls`, `autoreview_usd`, `autoreview_defer_share`). A row's `"bench": {"post_steps": ["retro", "sync"]}` (RPC driver) runs `/retro` and `/sync --dry-run` in the foreman session after the task is done; their output stays in the agent state dir, their usage after a marker is left out of tokens and cost and shown as `retro_tokens`/`retro_usd`, a changed workspace marks the cell infra `post_step_changed_workspace`, and `run` writes the cells' retro output to `<jobs dir>/retro-findings.md`.

Design record: `design/architecture.md` [section 12](../design/architecture.md#12-benchmark-design-design-only-no-runs).
