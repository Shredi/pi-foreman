# Upstream issue draft: stale "subagent needs attention" notices (pi-subagents / Pi)

> Draft of an upstream issue about notices that arrive after their run ended.
> The finalizer moves this file out of docs/; it is not published.
> Context: the known limit in safety.md.

**Problem.** pi-subagents sends a `subagent_control_notice` custom message with `pi.sendMessage({...}, { triggerTurn: true })` for an async run that needs attention. Messages are queued and cannot be withdrawn, so when the run ends before Pi flushes the queue the host still starts a turn on a notice for a finished run. `deliverControlNotice` dedupes by `controlNotificationKey` within one `visibleControlNotices` set, but not against the run's end event.

**Why an extension cannot fix it.** `context` and `message_end` can edit what is sent to the model or replace a finalized message, but no hook can cancel a queued custom message before it triggers a turn. `notifyOn` is global: excluding `needs_attention` suppresses the event for live runs too.

**Request (either).**
1. pi-subagents: before `pi.sendMessage`, drop the notice when the run's async job is no longer `running`/`queued` (the check `scheduleSupervisorNotice` already does for supervisor notices).
2. Pi: let a `message_start`/`before_agent_start` handler return `{ cancel: true }` for a custom message so an extension can drop it and skip the turn it would trigger.
