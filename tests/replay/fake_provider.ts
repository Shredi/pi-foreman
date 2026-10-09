// Replay-only fake model provider (design §10). Never shipped in the package.
//
// Registers `foreman-fake` and `foreman-fake-b`; each has one model per role id
// (`foreman-fake/explorer`, ...). Every request answers from a fixture file named by
// FOREMAN_FAKE_SCRIPT:
//
//   { "<model id or *>": { "<tag>": [ {"text": "...", "tools": [{"name": "bash", "arguments": {...}}]}, ... ] } }
//
// The tag comes from the newest user message that carries `[[replay:<tag>]]` (a prompt from
// the driver, or a child's task text). The step index is the number of assistant messages
// after that user message, so the script is stateless across processes and turns.
//
// Reviewer models (`<provider>/review-<kind>`) ignore the script and answer every request with
// a fixed verdict, for the model-review link: allow, deny-high, deny-low, defer, garbage, empty,
// error (the provider throws) and hang (never answers until aborted).
//
// Usage is fixed per answer: input 10, output 5, cacheRead 4, cacheWrite 2 (cost 0), so replay can
// assert the four token kinds. A step's own "usage" object overrides single numbers (ladder replay).
//
// FOREMAN_FAKE_CALLS=<file> appends "<provider>/<model> <tag>" per provider call (tests assert a
// request never reached the provider).
// FOREMAN_FAKE_SECTIONS=<file> appends "<tag> <step> <section names>" per foreman-model call: the
// system-prompt sections the request carries, folded over its system messages (null deletes).
// Compaction summary requests (Pi's summarization system prompt) answer a fixed summary text.
// FOREMAN_FAKE_USAGE=size makes usage follow request size (explicit step usage wins): input 10,
// cacheWrite = ceil(new prompt chars / 4), cacheRead = chars already seen by this process for the
// same model / 4 (one process = one session). FOREMAN_FAKE_SIZES=<file> appends one JSON line per
// request of any model: pid, model, tag, step, systemChars, toolsChars, messagesChars, tool names.
// FOREMAN_FAKE_SYSTEM=<dir> writes the system text of each model's first request to <dir>/<model>-<pid>.txt.
// FOREMAN_FAKE_REQUESTS=<file> appends the request messages of each `<provider>/foreman` call as one
// JSON line (cache-prefix tests compare earlier requests with later ones byte for byte).
import * as fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDERS = ["foreman-fake", "foreman-fake-b"];
export const ROLE_MODELS = ["foreman", "planner", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"];
export const REVIEW_MODELS = ["allow", "deny-high", "deny-low", "defer", "garbage", "empty", "error", "hang"].map((k) => `review-${k}`);
const REVIEW_REPLIES: Record<string, string> = {
  "review-allow": '{"verdict":"allow"}',
  "review-deny-high": '{"verdict":"deny","reason":"scripted hard deny","riskLevel":"high"}',
  "review-deny-low": '{"verdict":"deny","reason":"scripted soft deny","riskLevel":"low"}',
  "review-defer": '{"verdict":"defer","reason":"scripted unsure","lean":"allow"}',
  "review-garbage": "Sure, that looks fine to me.",
  "review-empty": "",
};
const TAG = /\[\[replay:([A-Za-z0-9_.-]+)\]\]/;

interface Step {
  text?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  tools?: { name: string; arguments: Record<string, unknown> }[];
}
type Script = Record<string, Record<string, Step[]>>;

function loadScript(): Script {
  const file = process.env.FOREMAN_FAKE_SCRIPT;
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
  } catch {
    return {};
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : "")).join("\n");
}

/** [tag, step index] for the current request, or null. */
export function locate(messages: { role: string; content: unknown }[]): [string, number] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const hit = TAG.exec(textOf(m.content));
    if (!hit) continue;
    const step = messages.slice(i + 1).filter((x) => x.role === "assistant").length;
    return [hit[1], step];
  }
  return null;
}

export function pickStep(script: Script, modelId: string, messages: { role: string; content: unknown }[]): Step {
  const where = locate(messages);
  if (!where) return { text: "fake: no replay tag" };
  const [tag, step] = where;
  const steps = script[modelId]?.[tag] ?? script["*"]?.[tag];
  if (!steps) return { text: `fake: no script for ${modelId}/${tag}` };
  return steps[step] ?? { text: "fake: done" };
}

let counter = 0;
const seen = new Map<string, number>();

/** Characters of the system prompt (base text, system messages and their sections), tool schemas and the other messages. */
function requestSizes(context: TranscriptContext): { system: number; tools: number; messages: number; total: number; toolNames: string } {
  const c = context as unknown as { systemPrompt?: string; tools?: { name?: string }[]; messages: { role: string; content: unknown; sections?: Record<string, unknown> }[] };
  let system = typeof c.systemPrompt === "string" ? c.systemPrompt.length : 0;
  let messages = 0;
  for (const m of c.messages) {
    if (m.role === "system") {
      system += textOf(m.content).length;
      for (const v of Object.values(m.sections ?? {})) if (typeof v === "string") system += v.length;
    } else messages += JSON.stringify(m.content ?? "").length;
  }
  const tools = c.tools ? JSON.stringify(c.tools).length : 0;
  return { system, tools, messages, total: system + tools + messages, toolNames: (c.tools ?? []).map((x) => x.name).join(",") };
}


function streamFake(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const log = process.env.FOREMAN_FAKE_CALLS;
  if (log) {
    try {
      fs.appendFileSync(log, `${model.provider}/${model.id} ${locate(context.messages as { role: string; content: unknown }[])?.[0] ?? "-"}\n`);
    } catch {
      // the log is a test aid only
    }
  }
  const secLog = process.env.FOREMAN_FAKE_SECTIONS;
  if (secLog && !model.id.startsWith("review-")) {
    const names = new Set<string>();
    for (const m of context.messages as { role: string; sections?: Record<string, unknown> }[]) {
      if (m.role !== "system") continue;
      for (const [k, v] of Object.entries(m.sections ?? {})) v === null ? names.delete(k) : names.add(k);
    }
    const where = locate(context.messages as { role: string; content: unknown }[]);
    try {
      fs.appendFileSync(secLog, `${where?.[0] ?? "-"} ${where?.[1] ?? "-"} ${[...names].sort().join(",")}\n`);
    } catch {
      // the log is a test aid only
    }
  }
  const reqLog = process.env.FOREMAN_FAKE_REQUESTS;
  if (reqLog && model.id === "foreman") {
    try {
      fs.appendFileSync(reqLog, `${JSON.stringify(context.messages)}\n`);
    } catch {
      // the log is a test aid only
    }
  }
  const sizes = requestSizes(context);
  const seenChars = seen.get(model.id) ?? 0;
  seen.set(model.id, sizes.total);
  const sysDir = process.env.FOREMAN_FAKE_SYSTEM;
  if (sysDir && !model.id.startsWith("review-") && seenChars === 0) {
    const c = context as unknown as { systemPrompt?: string; messages: { role: string; content: unknown; sections?: Record<string, unknown> }[] };
    const text = [c.systemPrompt ?? "", ...c.messages.filter((m) => m.role === "system").map((m) => `${textOf(m.content)}${JSON.stringify(m.sections ?? {})}`)].join("\n=====\n");
    try {
      fs.mkdirSync(sysDir, { recursive: true });
      fs.writeFileSync(`${sysDir}/${model.id}-${process.pid}.txt`, `keys: ${Object.keys(context).join(",")}\n${text}`);
    } catch {
      // the dump is a test aid only
    }
  }
  const sizeLog = process.env.FOREMAN_FAKE_SIZES;
  if (sizeLog && !model.id.startsWith("review-")) {
    const where = locate(context.messages as { role: string; content: unknown }[]);
    try {
      fs.appendFileSync(sizeLog, `${JSON.stringify({ pid: process.pid, model: model.id, tag: where?.[0] ?? null, step: where?.[1] ?? null, systemChars: sizes.system, toolsChars: sizes.tools, messagesChars: sizes.messages, tools: sizes.toolNames })}\n`);
    } catch {
      // the log is a test aid only
    }
  }
  if (model.id === "review-error") throw new Error("fake: scripted provider failure");
  const stream = createAssistantMessageEventStream();
  const summary = [context.systemPrompt, ...(context.messages as { role: string; content: unknown }[]).filter((m) => m.role === "system").map((m) => textOf(m.content))]
    .some((t) => typeof t === "string" && t.startsWith("You are a context summarization assistant"));
  const step: Step = model.id.startsWith("review-") ? { text: REVIEW_REPLIES[model.id] } : summary ? { text: "fake: summary" } : pickStep(loadScript(), model.id, context.messages as { role: string; content: unknown }[]);
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 10, output: 5, cacheRead: 4, cacheWrite: 2, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
  if (process.env.FOREMAN_FAKE_USAGE === "size") {
    const kept = Math.min(seenChars, sizes.total);
    Object.assign(output.usage, { input: 10, cacheRead: Math.ceil(kept / 4), cacheWrite: Math.ceil((sizes.total - kept) / 4) });
  }
  if (step.usage) Object.assign(output.usage, step.usage);
  if (model.id === "review-hang") {
    const abort = (): void => {
      output.stopReason = "aborted";
      output.errorMessage = "Request was aborted";
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
    };
    if (options?.signal?.aborted) queueMicrotask(abort);
    else options?.signal?.addEventListener("abort", abort, { once: true });
    return stream;
  }
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      output.stopReason = "aborted";
      output.errorMessage = "Request was aborted";
      stream.push({ type: "error", reason: "aborted", error: output });
      stream.end();
      return;
    }
    stream.push({ type: "start", partial: output });
    if (step.text) {
      output.content.push({ type: "text", text: "" });
      const i = output.content.length - 1;
      stream.push({ type: "text_start", contentIndex: i, partial: output });
      (output.content[i] as { text: string }).text = step.text;
      stream.push({ type: "text_delta", contentIndex: i, delta: step.text, partial: output });
      stream.push({ type: "text_end", contentIndex: i, content: step.text, partial: output });
    }
    for (const t of step.tools ?? []) {
      const call = { type: "toolCall" as const, id: `fake-${process.pid}-${++counter}`, name: t.name, arguments: t.arguments as never };
      output.content.push(call);
      const i = output.content.length - 1;
      stream.push({ type: "toolcall_start", contentIndex: i, partial: output });
      stream.push({ type: "toolcall_delta", contentIndex: i, delta: JSON.stringify(t.arguments), partial: output });
      stream.push({ type: "toolcall_end", contentIndex: i, toolCall: call, partial: output });
    }
    output.stopReason = step.tools?.length ? "toolUse" : "stop";
    stream.push({ type: "done", reason: output.stopReason, message: output });
    stream.end();
  });
  return stream;
}

export default function fakeProvider(pi: ExtensionAPI): void {
  // `/replay-trigger <tag>` starts a run the way a detached child's completion notice does:
  // sendMessage with triggerTurn (no input / before_agent_start event).
  pi.registerCommand("replay-trigger", {
    description: "replay only: start a run through sendMessage(triggerTurn)",
    handler: async (args: string) => {
      pi.sendMessage({ customType: "replay-trigger", content: `[[replay:${args.trim() || "t"}]] child finished`, display: true }, { triggerTurn: true });
    },
  });
  // FOREMAN_FAKE_HERDR=<file> appends each `herdr:blocked` event (JSON per line), as Herdr would see it.
  const herdrLog = process.env.FOREMAN_FAKE_HERDR;
  if (herdrLog && process.env.PI_SUBAGENT_CHILD !== "1") {
    pi.events?.on("herdr:blocked", (data: unknown) => {
      try {
        fs.appendFileSync(herdrLog, `${JSON.stringify(data)}\n`);
      } catch {
        // the log is a test aid only
      }
    });
  }
  // FOREMAN_FAKE_PR_TOOL=<name> registers a package-style tool that "creates a pull request", for the PR gate replay.
  const prTool = process.env.FOREMAN_FAKE_PR_TOOL;
  if (prTool) {
    pi.registerTool({
      name: prTool,
      label: "Create a pull request",
      description: "replay only: pretend to create a pull request",
      parameters: { type: "object", properties: { title: { type: "string" } }, additionalProperties: true } as never,
      async execute() {
        return { content: [{ type: "text" as const, text: "fake: pull request created" }], details: {} };
      },
    } as never);
  }
  // FOREMAN_FAKE_BRIDGE=1 also registers the fake under the claude-bridge provider name, so the
  // adapter treats the session as a claude-bridge session (the real bridge is never loaded).
  for (const name of process.env.FOREMAN_FAKE_BRIDGE === "1" ? [...PROVIDERS, "claude-bridge"] : PROVIDERS) {
    pi.registerProvider(name, {
      name: `pi-foreman replay fake (${name})`,
      baseUrl: "http://127.0.0.1:9",
      apiKey: "fake-key",
      api: "foreman-fake-api" as Api,
      models: [...ROLE_MODELS, ...REVIEW_MODELS].map((id) => ({
        id,
        name: `${name} ${id}`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      })),
      streamSimple: streamFake,
    });
  }
}
