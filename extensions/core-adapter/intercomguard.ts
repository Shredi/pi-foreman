// pi-intercom adoption (Phase 4, ledger items 3, 4, 22): the guard on the `intercom` tool, the
// inbound-message turn notice and the doctor lines. Facts from pi-intercom 0.16.1 (pinned in
// packages.lock.json):
//   - tool `intercom` (index.ts:2434), params incl. action, to, cwd, openProjectPaneIfMissing;
//     a `to` of the form name@machine is a cross-machine send over SSH (cross-machine-discovery.ts).
//   - inbound messages: pi.sendMessage({customType: "intercom_message", details: {from, message,
//     replyCommand?, bodyText}}) (index.ts:1289); an idle session is then woken with
//     pi.sendUserMessage("New intercom message above.") (index.ts:1302).
//   - config: <agentDir>/intercom/config.json (config.ts getConfigPath, broker/paths.ts).
// Intercom messages are data: no gate is relaxed for a turn they start.
import * as fs from "node:fs";
import * as path from "node:path";

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
    return "pi-foreman: intercom targets of the form name@machine (cross-machine over SSH) are refused. Send to a session on this machine, or set intercom.allowRemote in your foreman.json.";
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
  return ["brokerCommand", "brokerArgs", "crossMachine"].filter((k) => Object.prototype.hasOwnProperty.call(cfg, k));
}

const isIntercomEntry = (e: unknown): boolean => {
  const src = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { source?: unknown }).source === "string" ? (e as { source: string }).source : "";
  return /(^|[/:\\])pi-intercom(@|$|[/\\])/.test(src);
};

/** Doctor lines: pi-intercom installed?, its config's trusted overrides, the Herdr pane-state hint. */
export function intercomDoctor(agentDir: string, packageLists: unknown[], env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const installed = packageLists.some((l) => Array.isArray(l) && l.some(isIntercomEntry));
  out.push(installed ? `OK   ${INTERCOM_PACKAGE} listed in settings.json packages` : `INFO ${INTERCOM_PACKAGE} not installed (the installer adds it unless --no-intercom)`);
  const risks = intercomConfigRisks(agentDir);
  if (risks.length) out.push(`WARN ${intercomConfigPath(agentDir)} sets ${risks.join(", ")}: brokerCommand/brokerArgs choose the program pi-intercom starts as its broker, crossMachine enables sends over SSH. Fine if you set them on purpose.`);
  if (env.HERDR_ENV === "1" && !fs.existsSync(path.join(agentDir, "extensions", "herdr-agent-state.ts"))) {
    out.push("INFO Herdr detected; run `herdr integration install pi` for pane state");
  }
  return out;
}

/**
 * Sender of the newest pi-intercom message since the last user message in a session branch
 * (entries oldest first), or null. Used for the wake prompt, whose message reached the session
 * without an extension `message_end`.
 */
export function lastIntercomSender(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; details?: unknown; message?: { role?: unknown } } | null;
    if (!e || typeof e !== "object") continue;
    if (e.type === "custom_message" && e.customType === INTERCOM_MESSAGE_TYPE) return intercomSender(e.details);
    if (e.type === "message" && e.message?.role === "user") return null;
  }
  return null;
}
