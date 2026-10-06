// Usage counting (D8): every Pi process running the adapter, foreman and children, appends one
// JSON line per assistant `message_end` (error and aborted ones too, so retries count) to
// `<agentDir>/pi-foreman/state/usage/<foreman-session>.jsonl`. Parallel children write the same
// file, so a line is one appendFileSync call and nothing is ever read back and rewritten.
//
// How a child learns who it is: pi-subagents 0.75.0 forwards the launch parameter
// `extensionBindings` ({"<package>/<n>": JSON}) to the child as the env var
// PI_SUBAGENT_EXTENSION_BINDINGS (runs/shared/child-launch.js childProcessEnv), applied in the
// runner per child before its extensions load, one launch at a time (runs/shared/child-session.js
// applyProcessEnv / `loading`). The foreman's adapter writes its binding into the launch input in
// the tool_call hook; the child's adapter reads it when its instance is created. pi-subagents
// honours the parameter on single launches only (runs/background/async-execution.js, single path),
// so `tasks`/`chain` launches get no binding: their children log role "child", launchId null.
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Env } from "./env.ts";

export const BINDING_NS = "pi-foreman/1";
export const BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
export const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";

export const LAUNCH_KINDS = ["foreman", "first", "revision", "strong-relaunch", "fallback"] as const;
export type LaunchKind = (typeof LAUNCH_KINDS)[number];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** What a child needs to know about its own launch. */
export interface LaunchBinding {
  foremanSession: string;
  workspace: string;
  role: string;
  launchId: string;
  kind: LaunchKind;
  model: string | null;
}

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageLine {
  ts: string;
  workspace: string;
  foremanSession: string;
  role: string;
  provider: string | null;
  model: string | null;
  launchId: string | null;
  kind: LaunchKind;
  stopReason: string | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: UsageCost;
}

export function usageDir(agentDir: string): string {
  return path.join(agentDir, "pi-foreman", "state", "usage");
}

export function usageFile(agentDir: string, foremanSession: string): string {
  const safe = foremanSession.replace(/[^A-Za-z0-9_-]/g, "") || "session";
  return path.join(usageDir(agentDir), `${safe}.jsonl`);
}

export function newLaunchId(): string {
  return `L${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** `fallback` when the launch's provider differs from the active one, else `first`. */
export function launchKind(model: string | null, activeProvider: string | undefined): LaunchKind {
  const slash = model ? model.indexOf("/") : -1;
  if (!model || slash <= 0 || !activeProvider) return "first";
  return model.slice(0, slash) === activeProvider ? "first" : "fallback";
}

export interface RecordLaunchInput {
  foremanSession: string;
  workspace: string;
  role: string;
  model: string | null;
  /** Explicit kind (`revision`, `strong-relaunch` from later callers); default first/fallback. */
  kind?: LaunchKind;
  activeProvider?: string;
}

/** A new launch id with role, model and kind, kept in `registry` (keyed by launch id). */
export function recordUsageLaunch(registry: Map<string, LaunchBinding>, input: RecordLaunchInput): LaunchBinding {
  const b: LaunchBinding = {
    foremanSession: input.foremanSession,
    workspace: input.workspace,
    role: input.role,
    launchId: newLaunchId(),
    kind: input.kind ?? launchKind(input.model, input.activeProvider),
    model: input.model,
  };
  registry.set(b.launchId, b);
  return b;
}

/** Single-child launch (top-level `agent`, no tasks/chain/action): its role, else null. */
export function singleLaunchRole(input: Json): string | null {
  if (!isObj(input) || input.action !== undefined) return null;
  if (Array.isArray(input.tasks) || Array.isArray(input.chain)) return null;
  return str(input.agent);
}

/** Drop a foreman-supplied pi-foreman binding from any `subagent` call; only the adapter writes it. */
export function stripBinding(input: Json): void {
  if (!isObj(input) || !isObj(input.extensionBindings) || !(BINDING_NS in input.extensionBindings)) return;
  const { [BINDING_NS]: _dropped, ...rest } = input.extensionBindings;
  if (Object.keys(rest).length > 0) input.extensionBindings = rest;
  else delete input.extensionBindings;
}

/** Write the binding into the launch input's `extensionBindings` (other namespaces are kept). */
export function bindLaunch(input: Json, b: LaunchBinding): void {
  const prev = isObj(input.extensionBindings) ? input.extensionBindings : {};
  input.extensionBindings = { ...prev, [BINDING_NS]: { ...b } };
}

/** This process's launch binding (child side), or null. */
export function readBinding(env: Env): LaunchBinding | null {
  const raw = env[BINDINGS_ENV];
  if (!raw) return null;
  try {
    const all = JSON.parse(raw) as unknown;
    const b = isObj(all) ? all[BINDING_NS] : null;
    if (!isObj(b)) return null;
    const kind = (LAUNCH_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as LaunchKind) : "first";
    const foremanSession = str(b.foremanSession);
    const role = str(b.role);
    const launchId = str(b.launchId);
    if (!foremanSession || !role || !launchId) return null;
    return { foremanSession, workspace: str(b.workspace) ?? "", role, launchId, kind, model: str(b.model) };
  } catch {
    return null;
  }
}

export interface LineContext {
  workspace: string;
  foremanSession: string;
  role: string;
  launchId: string | null;
  kind: LaunchKind;
}

/** One usage line from an assistant message (missing numbers count as 0). */
export function usageLine(ctx: LineContext, message: unknown, now: Date = new Date()): UsageLine {
  const m = isObj(message) ? message : {};
  const u = isObj(m.usage) ? m.usage : {};
  const c = isObj(u.cost) ? u.cost : {};
  return {
    ts: now.toISOString(),
    workspace: ctx.workspace,
    foremanSession: ctx.foremanSession,
    role: ctx.role,
    provider: str(m.provider),
    model: str(m.model),
    launchId: ctx.launchId,
    kind: ctx.kind,
    stopReason: str(m.stopReason),
    input: num(u.input),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    output: num(u.output),
    cost: { input: num(c.input), output: num(c.output), cacheRead: num(c.cacheRead), cacheWrite: num(c.cacheWrite), total: num(c.total) },
  };
}

/** Append one line (one write call; the directory is created on demand). Never throws; false on error. */
export function appendUsage(file: string, line: UsageLine): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ reading

export function parseLines(text: string): UsageLine[] {
  const out: UsageLine[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const v = JSON.parse(l) as unknown;
      if (isObj(v) && typeof v.role === "string") out.push(v as unknown as UsageLine);
    } catch {
      // a torn line from a crash: skip
    }
  }
  return out;
}

/** Lines of one session file, or of every file in the folder whose lines match `workspace`. */
export function readUsage(agentDir: string, opts: { session?: string; workspace?: string }): UsageLine[] {
  const files: string[] = [];
  if (opts.workspace === undefined && opts.session) files.push(usageFile(agentDir, opts.session));
  else {
    try {
      for (const f of fs.readdirSync(usageDir(agentDir))) if (f.endsWith(".jsonl")) files.push(path.join(usageDir(agentDir), f));
    } catch {
      // no folder yet
    }
  }
  const lines: UsageLine[] = [];
  for (const f of files) {
    try {
      lines.push(...parseLines(fs.readFileSync(f, "utf8")));
    } catch {
      // missing file
    }
  }
  return opts.workspace === undefined ? lines : filterWorkspace(lines, opts.workspace);
}

export function filterWorkspace(lines: UsageLine[], workspace: string): UsageLine[] {
  const want = path.resolve(workspace);
  return lines.filter((l) => typeof l.workspace === "string" && l.workspace !== "" && path.resolve(l.workspace) === want);
}

export interface Totals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: UsageCost;
}

export interface UsageSummary {
  byRole: Map<string, Totals>;
  byModel: Map<string, Totals>;
  total: Totals;
  /** Per kind: distinct launches (foreman: distinct foreman sessions) and model calls. */
  byKind: Map<LaunchKind, { launches: number; calls: number }>;
}

const zero = (): Totals => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function add(t: Totals, l: UsageLine): void {
  t.calls += 1;
  t.input += num(l.input);
  t.cacheRead += num(l.cacheRead);
  t.cacheWrite += num(l.cacheWrite);
  t.output += num(l.output);
  const c = isObj(l.cost) ? l.cost : ({} as Json);
  t.cost.input += num(c.input);
  t.cost.output += num(c.output);
  t.cost.cacheRead += num(c.cacheRead);
  t.cost.cacheWrite += num(c.cacheWrite);
  t.cost.total += num(c.total);
}

export function aggregate(lines: UsageLine[]): UsageSummary {
  const byRole = new Map<string, Totals>();
  const byModel = new Map<string, Totals>();
  const total = zero();
  const launches = new Map<LaunchKind, Set<string>>();
  const byKind = new Map<LaunchKind, { launches: number; calls: number }>();
  for (const l of lines) {
    const model = l.provider && l.model ? `${l.provider}/${l.model}` : l.model ?? "(unknown)";
    for (const [map, key] of [[byRole, l.role], [byModel, model]] as const) {
      const t = map.get(key) ?? zero();
      add(t, l);
      map.set(key, t);
    }
    add(total, l);
    const kind = l.kind;
    const k = byKind.get(kind) ?? { launches: 0, calls: 0 };
    k.calls += 1;
    byKind.set(kind, k);
    const ids = launches.get(kind) ?? new Set<string>();
    ids.add(kind === "foreman" ? `s:${l.foremanSession}` : l.launchId ?? `none:${l.foremanSession}:${l.role}`);
    launches.set(kind, ids);
  }
  for (const [kind, ids] of launches) byKind.get(kind)!.launches = ids.size;
  return { byRole, byModel, total, byKind };
}

function cell(v: number, money = false): string {
  return money ? v.toFixed(4) : String(v);
}

/** Plain-text tables: per role, per model, totals, launches by kind. */
export function formatSummary(sum: UsageSummary, title: string): string {
  const head = ["", "calls", "input", "cacheRead", "cacheWrite", "output", "$input", "$cacheRead", "$cacheWrite", "$output", "$total"];
  const row = (name: string, t: Totals): string[] => [name, cell(t.calls), cell(t.input), cell(t.cacheRead), cell(t.cacheWrite), cell(t.output), cell(t.cost.input, true), cell(t.cost.cacheRead, true), cell(t.cost.cacheWrite, true), cell(t.cost.output, true), cell(t.cost.total, true)];
  const table = (label: string, rows: string[][]): string[] => {
    const all = [[label, ...head.slice(1)], ...rows];
    const w = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
    return all.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join("  "));
  };
  const sorted = (m: Map<string, Totals>): string[][] => [...m.keys()].sort().map((k) => row(k, m.get(k)!));
  const out = [title];
  if (sum.total.calls === 0) return [...out, "no usage recorded"].join("\n");
  out.push("", ...table("role", [...sorted(sum.byRole), row("total", sum.total)]));
  out.push("", ...table("model", sorted(sum.byModel)));
  out.push("", "launches by kind:");
  for (const kind of LAUNCH_KINDS) {
    const k = sum.byKind.get(kind);
    if (k) out.push(`  ${kind.padEnd(16)} ${String(k.launches).padStart(4)} launch(es), ${k.calls} call(s)`);
  }
  return out.join("\n");
}

// ------------------------------------------------------------- turn cause (D9)

export type TurnCause = "user" | "child" | "intercom" | "other";

/** pi-subagents 0.75.0 custom messages that report a child's end (notify.js, subagent-executor.js, wait-subscriptions.js). */
export const CHILD_MESSAGE_TYPES = ["subagent-notify", "subagent-incremental-child-notify", "subagent-wait-subscription"];
/**
 * Its native intercom (supervisor) channel: a child's contact_supervisor request (intercom/native-supervisor-channel.js),
 * and pi-intercom 0.16.1's inbound message (index.ts:1291).
 */
export const INTERCOM_MESSAGE_TYPES = ["subagent_supervisor_request", "intercom_message"];
/**
 * pi-intercom 0.16.1 appends a message to an idle session without starting a run (Pi's extension
 * `message_end` does not fire for that append), then wakes it with this extension prompt (index.ts:1302).
 */
export const INTERCOM_WAKE_TEXT = "New intercom message above.";

/** Cause from an `input` event: typed or RPC prompts are the user's, pi-intercom's wake prompt is intercom. */
export function causeOfInput(source: unknown, text?: unknown): TurnCause {
  if (source === "extension" && text === INTERCOM_WAKE_TEXT) return "intercom";
  return source === "interactive" || source === "rpc" ? "user" : "other";
}

/** Cause from a custom message's type; null = not a trigger this measures (the cause is kept). */
export function causeOfCustom(customType: unknown): TurnCause | null {
  if (typeof customType !== "string") return null;
  if (CHILD_MESSAGE_TYPES.includes(customType)) return "child";
  if (INTERCOM_MESSAGE_TYPES.includes(customType)) return "intercom";
  return null;
}
