// The launch fields the adapter's gates read (`reason`, `items`, `attach`, `occasion`, `reads`, `install`, `size`, `risk`, `mcp`) are top-level keys of the foreman's
// `subagent` call, but pi-subagents' schema does not declare them, and a model that fills in only declared parameters never sends them.
// The triage tool's `prepareLoadout` (index.ts) therefore sets an extended copy of the schema on Pi's per-refresh wrapper of the declared tool.
//
// The fields are typed for the model and loose for Pi's validation: every field is `anyOf: [<typed branches>, {}]`, and the empty branch accepts any
// other value unchanged, so Pi's argument check neither refuses nor converts a value the gates see today. The gates keep their own checks and
// refusal texts. The source schema (pi-subagents' object, or a recorded declaration) is never mutated.
import { LAUNCH_OCCASIONS } from "./occasion.ts";
import { RISKS } from "./sizing.ts";

type Schema = Record<string, unknown>;

export interface LaunchSchemaFlags {
  /** `size` and `risk` are read (ladder.sizing on). */
  sizing: boolean;
  /** `mcp` is read (a role has an MCP ceiling). */
  mcp: boolean;
}

const ANY: Schema = {};
const loose = (description: string, ...typed: Schema[]): Schema => ({ anyOf: [...typed, ANY], description });
const NUMBER: Schema = { type: "number" };
const STRING: Schema = { type: "string" };
const BOOLEAN: Schema = { type: "boolean" };
const stringList: Schema = { anyOf: [{ type: "array", items: { anyOf: [STRING, ANY] } }, ANY] };
const count: Schema = { anyOf: [NUMBER, ANY] };

const OCCASIONS = LAUNCH_OCCASIONS.join(", ");
const RISK_TAGS = RISKS.join(", ");

const ALWAYS: Record<string, Schema> = {
  reason: loose("Why a launch with `model: \"strong\"` or `model: \"top\"`, or with a `model` below the rung that `size` and `risk` measure, is needed: one line of text, required for such a launch.", STRING),
  items: loose("Reviewer launches: the ledger items this reviewer checks, a list of item numbers and \"V\" such as [2, 5, \"V\"], each open on the ledger, except on a `[pre-pr]` launch, which may also name closed items and records their results without changing the ledger; without it a `[pre-pr]` takes the items reviews of its own checkout judged, and any other reviewer takes the open items except V that no other checkout judged, and after a FAIL in the same checkout the failed items still open; after a FAIL, items beyond the failed ones are reviewed against the whole change.", { type: "array", items: { anyOf: [NUMBER, STRING, ANY] } }, NUMBER, STRING),
  attach: loose("`[pre-pr]` reviewer launches: the images to attach to the pull request, a list of paths inside the checkout, for example [\".workflow/screenshots/result.png\"]; still images only (png, jpg, jpeg, webp). The reviewer is told to open each image and to FAIL on private data; only the files that PASS (and are unchanged) can go into pr_create or pr_attach.", { type: "array", items: { anyOf: [STRING, ANY] } }),
  diffBase: loose("Reviewer launches: the commit the review diff is taken against (a sha, branch or tag that is an ancestor of HEAD), for a change that sits on top of earlier commits; without it the base is the recorded builder base or the merge-base.", STRING),
  occasion: loose(`Reviewer launches: the kind of review, one of ${OCCASIONS}; without it the launch is the review of the items.`, STRING),
  reads: loose("Builder and reviewer launches: the child's read allowance as a positive integer, capped by the configured maximum.", NUMBER, STRING),
  install: loose("Builder launches: true lets the child run `npm ci` or `npm install` in its own folders.", BOOLEAN, STRING),
};

const SIZING: Record<string, Schema> = {
  size: loose("Builder launches: the files the task changes, as {files: [\"path\", ...], largestFileLines?: n, modules?: n}; the adapter measures them and picks the model rung from the result.", { type: "object", properties: { files: stringList, largestFileLines: count, modules: count } }, STRING),
  risk: loose(`Builder launches: the risk tags the task touches, a subset of ${RISK_TAGS}; guard, permission, parser, concurrency and security raise the rung, design raises it to the top.`, { type: "array", items: { anyOf: [STRING, ANY] } }, STRING),
};

const MCP: Record<string, Schema> = {
  mcp: loose("The MCP servers and tools the child gets, as [\"server\", \"server/tool\"] inside the role's ceiling; no mcp or [] means none.", { type: "array", items: { anyOf: [STRING, ANY] } }, STRING),
};

/** The launch field schemas for the given flags, by key. */
export function launchFieldSchemas(flags: LaunchSchemaFlags): Record<string, Schema> {
  return { ...ALWAYS, ...(flags.sizing ? SIZING : {}), ...(flags.mcp ? MCP : {}) };
}

const copies = new WeakMap<object, Map<string, Schema>>();
const originOf = new WeakMap<object, Schema>();

/**
 * A copy of `source` (a `subagent` parameters schema) with the launch fields it does not declare added after its own properties. Never mutates `source`;
 * the same source and flags give the same object (stable bytes, one validator compile). A source that declares every field is returned as is. A copy this
 * function made extends its own origin, so a second build never extends an extended copy.
 */
export function extendedParameters<T extends object>(source: T, flags: LaunchSchemaFlags): T {
  const origin = (originOf.get(source) ?? source) as Schema;
  const props = origin.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return source;
  const key = `${flags.sizing ? "s" : "-"}${flags.mcp ? "m" : "-"}`;
  let byFlags = copies.get(origin);
  if (!byFlags) copies.set(origin, (byFlags = new Map()));
  const hit = byFlags.get(key);
  if (hit) return hit as T;
  const added = Object.entries(launchFieldSchemas(flags)).filter(([name]) => !Object.hasOwn(props, name));
  const out: Schema = added.length === 0 ? origin : { ...origin, properties: { ...(props as Schema), ...Object.fromEntries(added) } };
  if (out !== origin) originOf.set(out, origin);
  byFlags.set(key, out);
  return out as T;
}

/**
 * Set the extended copy on the declared `subagent` entry of a loadout (Pi's per-refresh wrapper, not pi-subagents' definition and not a recorded
 * declaration). Returns true when the entry's parameters changed.
 */
export function extendSubagentDeclaration(declared: readonly { name: string; parameters?: unknown }[], flags: LaunchSchemaFlags): boolean {
  const sub = declared.find((t) => t.name === "subagent");
  if (!sub || !sub.parameters || typeof sub.parameters !== "object") return false;
  const next = extendedParameters(sub.parameters, flags);
  if (next === sub.parameters) return false;
  sub.parameters = next;
  return true;
}
