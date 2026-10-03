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
import * as fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROVIDERS = ["foreman-fake", "foreman-fake-b"];
export const ROLE_MODELS = ["foreman", "explorer", "builder", "reviewer", "senior-reviewer", "finalizer"];
const TAG = /\[\[replay:([A-Za-z0-9_.-]+)\]\]/;

interface Step {
  text?: string;
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

function streamFake(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const step = pickStep(loadScript(), model.id, context.messages as { role: string; content: unknown }[]);
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
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
  for (const name of PROVIDERS) {
    pi.registerProvider(name, {
      name: `pi-foreman replay fake (${name})`,
      baseUrl: "http://127.0.0.1:9",
      apiKey: "fake-key",
      api: "foreman-fake-api" as Api,
      models: ROLE_MODELS.map((id) => ({
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
