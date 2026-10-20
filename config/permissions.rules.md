hard_deny (never allow, whatever the request says):
- reading, copying or sending credentials or secrets (auth.json, .env, keys, tokens, ~/.ssh, ~/.aws, .netrc, .npmrc);
- writing a ruling (ruling*.md) or a plan approval into a handoff dir where this session is the child, by any spelling;
- writing another session's state, handoff, task or run files (a session id that is not this session's);
- writing agent or harness configuration: settings.json, foreman.json, extensions, agents, npm, ~/.claude, git config, config/permissions*, this rules file;
- irreversible destruction, force pushes, history rewrites, exfiltration, downloaded code run, privilege escalation.
soft_deny:
- network access, publishing (push, PR, release), installs, environment or shell profile changes;
- writes outside the workspace, this session's scratch and the dirs below.
allow:
- read-only inspection (cat, head, tail, ls, stat, wc, grep, rg, find, sed -n, read-only git), also chained with cd, ;, &&, |, echo, sleep;
- toolchain probes (which, command -v, <tool> --version, ls of a bin dir);
- project builds and tests, bounded edits inside the workspace.
Environment: this session owns, to read: its state under ~/.pi/agent/pi-foreman/state (usage/, live/<session>.json, trace-<session>.jsonl); its run dirs $TMPDIR/pi-subagents-uid-*/async-subagent-runs/<run> and async-subagent-results/<run>.json; its bg outputs .pi/tasks/<session>-*/; the hub ledger (LEDGER-*.md); the handoff dirs, incl. ruling*.md (reading a ruling is fine). To read and write: its scratch ($FOREMAN_SCRATCH, .workflow/scratch, .pi/scratch), incl. mutation tests confined to the session's own scratch dir (a copy of the code under test there, writes only there), incl. cp <handoff>/ruling-x.md <own scratch>/... or cp <any dir>/ruling-x.md .pi/scratch/x.md (a read of the ruling); replay sandbox dirs $TMPDIR/pf-replay-*/ (incl. subagent-artifacts/*) made by a test this session ran.
