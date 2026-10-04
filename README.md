# pi-foreman

A generic orchestration harness for the [pi coding agent](https://pi.dev). It is planned to ship Pi extensions (TypeScript), agent roles, skills and a Python core (requirements ledger, guards) together with an installer.

**Status:** early, design phase.

## Install

Needs Node 22+, Pi 1.0.x on `PATH` and Python 3.9+. From a checkout of this repo:

```sh
node setup.mjs --dry-run   # show the planned diff and `pi install` commands, write nothing
node setup.mjs             # install into the user-level Pi agent dir
node setup.mjs --project   # install project-locally (.pi/settings.json)
node setup.mjs --remove    # remove only what the installer manages
```

Options: `--overlay npm:<pkg>@<exact-version>` installs an organisation overlay (ranges are refused),
`--agent-dir <dir>` overrides `PI_CODING_AGENT_DIR` / `~/.pi/agent`. Project packages load only after
the project is trusted; headless runs need `pi --approve`. A second run changes nothing and says "up to date".

The installer installs `pi-subagents` (pinned in `packages.lock.json`) and registers this checkout with
`pi install <path>`. The permission packages are pinned but installed from Phase 3. It writes the generated
`subagents` block into `settings.json` (backup `settings.json.bak-<timestamp>` first) and creates
`<agent dir>/foreman.json` only if absent. Map each provider you use to models there:

```json
{
  "version": 1,
  "providers": {
    "my-provider": {
      "roles": {
        "foreman": { "model": "my-provider/big-model", "thinking": "high" },
        "builder": { "model": "my-provider/mid-model", "thinking": "medium" }
      }
    }
  }
}
```

Then re-run `node setup.mjs` to regenerate the block, and run `/foreman doctor` in Pi. Tests:
`node --test "tests/installer/*.test.mjs"`.

## Benchmark (`foreman bench`)

`python scripts/foreman_bench.py run --preset bench/presets/smoke.json` runs the preset's rows over a
[Harbor](https://github.com/harbor-framework/harbor) task dir (`--tasks DIR` or `bench.tasks_dir`) in local
Docker; a second `run` resumes, `table` prints the counters (success, tokens, wall time, tool calls,
approvals, guard blocks). Needs `uv tool install harbor`; Harbor telemetry is always switched off. The
Harbor agents live in `bench/harbor_agent.py` and are not part of the installed package.
`--dry-run` prints the cell order, `--token-cap N` stops cleanly (exit 4) once finished cells used N
tokens, `--setup-only` installs one cell's agent and runs zero-model checks without a prompt.
`bench/tasks/m1-recheck` re-checks the M1 standard task (ledger, explorer, builder, reviewer).

## License

MIT, see `LICENSE`. Upstream attributions are in `NOTICE`.
