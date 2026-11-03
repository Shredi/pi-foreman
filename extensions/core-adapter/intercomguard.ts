// pi-intercom adoption (Phase 4, ledger items 3, 4, 22): the guard on the `intercom` tool, the
// inbound-message turn notice and the doctor lines. Facts from pi-intercom 0.18.1 (the fork pin
// in packages.lock.json, upstream v0.18.1 plus the hc transport; line numbers are the fork's):
//   - tool `intercom` (index.ts:2597), params incl. action, to, cwd, openProjectPaneIfMissing;
//     a `to` of the form name@machine is a cross-machine send, over SSH (crossMachine.transport
//     "herdr", default) or `hc` (transport "hc") (cross-machine-discovery.ts).
//   - inbound messages: pi.sendMessage({customType: "intercom_message", details: {from, message,
//     replyCommand?, bodyText}}) (delivery index.ts:1334-1341); on Pi 1.2.0 and newer an idle
//     session gets sendMessage's triggerTurn and no wake line: no `input` event, the message
//     reaches before_agent_start (messageType "custom") and then message_end; on Pi before 1.2.0
//     an idle session is woken with pi.sendUserMessage("New intercom message above.") (index.ts:1347)
//     (version switch index.ts:163-170). A busy session steers the message in (message_end).
//     intercomInbound below reads all three, keyed on the custom message, not on the wake text.
//   - config: <agentDir>/intercom/config.json (config.ts getConfigPath, broker/paths.ts).
// Intercom messages are data: no gate is relaxed for a turn they start.
import * as fs from "node:fs";
import * as path from "node:path";
import { INTERCOM_WAKE_TEXT } from "./usage.ts";

export const INTERCOM_TOOL = "intercom";
export const INTERCOM_PACKAGE = "pi-intercom";
export const INTERCOM_MESSAGE_TYPE = "intercom_message";

export interface IntercomPolicy {
  isChild: boolean;
  allowRemote: boolean;
  allowOpenPane: boolean;
}

/** Refusal reason for an `intercom` call, or undefined (allowed, or not the intercom tool). */
export function intercomBlock(toolName: string, input: unknown, p: IntercomPolicy): string | undefined {
  if (toolName !== INTERCOM_TOOL) return undefined;
  if (p.isChild) return "pi-foreman: the intercom tool is not available to child sessions; use contact_supervisor to reach the foreman.";
  const i = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (i.openProjectPaneIfMissing && !p.allowOpenPane) {
    return "pi-foreman: intercom openProjectPaneIfMissing is refused: starting Pi in a new pane is a launch outside the role allowlist. Send to a running session, or set intercom.allowOpenPane in your foreman.json.";
  }
  if (typeof i.to === "string" && i.to.includes("@") && !p.allowRemote) {
    return "pi-foreman: intercom targets of the form name@machine (cross-machine over SSH or hc) are refused. Send to a session on this machine, or set intercom.allowRemote in your foreman.json.";
  }
  return undefined;
}

/** Sender label of an inbound pi-intercom message (`details.from.name`, else the id prefix). */
export function intercomSender(details: unknown): string {
  const d = details && typeof details === "object" ? (details as Record<string, unknown>) : {};
  const from = d.from && typeof d.from === "object" ? (d.from as Record<string, unknown>) : {};
  const msg = d.message && typeof d.message === "object" ? (d.message as Record<string, unknown>) : {};
  const raw = typeof from.name === "string" && from.name.trim() ? from.name : typeof from.id === "string" ? from.id.slice(0, 8) : "an unknown session";
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
  return msg.crossMachine ? `${name} (unverified cross-machine)` : name;
}

export const intercomConfigPath = (agentDir: string): string => path.join(agentDir, "intercom", "config.json");

/** Keys of the pi-intercom config that change what it runs or where it sends (trusted overrides). */
export function intercomConfigRisks(agentDir: string): string[] {
  let cfg: unknown;
  try {
    cfg = JSON.parse(fs.readFileSync(intercomConfigPath(agentDir), "utf8").replace(/^﻿/, ""));
  } catch {
    return [];
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  return ["brokerCommand", "brokerArgs", "crossMachine", "stableId"].filter((k) => Object.prototype.hasOwnProperty.call(cfg, k));
}

const isIntercomEntry = (e: unknown): boolean => {
  const src = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { source?: unknown }).source === "string" ? (e as { source: string }).source : "";
  return /(^|[/:\\])pi-intercom(@|$|[/\\])/.test(src);
};

const filtersIntercom = (e: unknown): boolean => {
  const ext = e && typeof e === "object" ? (e as { extensions?: unknown }).extensions : undefined;
  return Array.isArray(ext) && ext.some((x) => typeof x === "string" && x.startsWith("!") && x.includes("node_modules/pi-intercom"));
};

/** Doctor lines: pi-intercom installed (top-level or bundled under pkgRoot)?, its config's trusted overrides, the Herdr pane-state hint. */
export function intercomDoctor(agentDir: string, packageLists: unknown[], env: NodeJS.ProcessEnv = process.env, pkgRoot?: string): string[] {
  const out: string[] = [];
  const listed = packageLists.some((l) => Array.isArray(l) && l.some(isIntercomEntry));
  const bundled = !!pkgRoot && fs.existsSync(path.join(pkgRoot, "node_modules", INTERCOM_PACKAGE, "package.json"));
  const filtered = packageLists.some((l) => Array.isArray(l) && l.some(filtersIntercom));
  if (listed) out.push(`OK   ${INTERCOM_PACKAGE} listed in settings.json packages`);
  else if (bundled && filtered) out.push(`INFO ${INTERCOM_PACKAGE} bundled but disabled by a package filter (--no-intercom)`);
  else if (bundled) out.push(`OK   ${INTERCOM_PACKAGE} bundled under ${path.join(pkgRoot!, "node_modules")}`);
  else out.push(`INFO ${INTERCOM_PACKAGE} not installed (bundled with pi-foreman: pi update --extensions, or npm install in a checkout)`);
  const all = intercomConfigRisks(agentDir);
  const risks = all.filter((k) => k !== "stableId");
  // Security review S6: a shared stableId makes every session (children too) register under one id.
  if (all.includes("stableId")) out.push(`WARN ${intercomConfigPath(agentDir)} sets stableId: every Pi session of this agent dir, child sessions included, registers under that one intercom id, so a child can pose as the foreman's parent (foreman:close). Remove it and set PI_INTERCOM_STABLE_ID per session if you need a fixed id.`);
  if (risks.length) out.push(`WARN ${intercomConfigPath(agentDir)} sets ${risks.join(", ")}: brokerCommand/brokerArgs choose the program pi-intercom starts as its broker, crossMachine enables sends over SSH or hc. Fine if you set them on purpose.`);
  if (env.HERDR_ENV === "1" && !fs.existsSync(path.join(agentDir, "extensions", "herdr-agent-state.ts"))) {
    out.push("INFO Herdr detected; run `herdr integration install pi` for pane state");
  }
  return out;
}

/**
 * Details of the newest pi-intercom message since the last user message in a session branch
 * (entries oldest first), or null. On Pi before 1.2.0 an idle session gets the message without an
 * extension `message_end`, then pi-intercom's wake prompt; this finds the message for that prompt.
 */
export function lastIntercomDetails(entries: readonly unknown[]): { details: unknown } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; details?: unknown; message?: { role?: unknown } } | null;
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom_message" && e.customType === INTERCOM_MESSAGE_TYPE) return { details: e.details };
    if (e.type === "message" && e.message?.role === "user") return null;
  }
  return null;
}

/** A pi-intercom inbound custom message: the customType plus `details.from` and `details.message` objects (never the text). */
export function isIntercomCustom(message: unknown): boolean {
  const m = message as { customType?: unknown; details?: { from?: unknown; message?: unknown } | null } | null;
  if (!m || typeof m !== "object" || m.customType !== INTERCOM_MESSAGE_TYPE) return false;
  const d = m.details;
  return !!d && typeof d === "object" && !!d.from && typeof d.from === "object" && !!d.message && typeof d.message === "object";
}

export type IntercomInboundEvent =
  | { hook: "input"; source: unknown; text: unknown; branch: readonly unknown[] }
  | { hook: "before_agent_start"; messageType: unknown; message?: unknown }
  | { hook: "message_end"; message: unknown };

/**
 * The inbound pi-intercom message an event carries, or null. Version-free: `before_agent_start`
 * (Pi 1.2+ idle triggerTurn run) and `message_end` (busy steer on every Pi, and the triggerTurn run
 * once more) read the custom message itself; `input` is the legacy wake line (Pi before 1.2.0),
 * which then reads the newest intercom entry of the branch. `id` is `details.message.id` ("" when
 * absent); before_agent_start and message_end of one message report the same id.
 */
export function intercomInbound(event: IntercomInboundEvent): { details: unknown; id: string } | null {
  let details: unknown;
  if (event.hook === "input") {
    if (event.source !== "extension" || event.text !== INTERCOM_WAKE_TEXT) return null;
    const hit = lastIntercomDetails(event.branch);
    if (!hit) return null;
    details = hit.details;
  } else if (event.hook === "before_agent_start") {
    if (event.messageType !== "custom" || !isIntercomCustom(event.message)) return null;
    details = (event.message as { details: unknown }).details;
  } else {
    const m = event.message as { role?: unknown } | null;
    if (!m || typeof m !== "object" || m.role !== "custom" || !isIntercomCustom(m)) return null;
    details = (m as { details: unknown }).details;
  }
  const id = (details as { message?: { id?: unknown } } | null)?.message?.id;
  return { details, id: typeof id === "string" ? id : "" };
}

/** Sender label of the newest pi-intercom message since the last user message, or null. */
export function lastIntercomSender(entries: readonly unknown[]): string | null {
  const hit = lastIntercomDetails(entries);
  return hit ? intercomSender(hit.details) : null;
}
