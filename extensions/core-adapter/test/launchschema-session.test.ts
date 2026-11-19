// A real Pi session (createAgentSession, pi-ai's faux provider) with the adapter and the installed pi-subagents loaded as extensions:
// the request's `subagent` tool declares the launch fields, and a `subagent` call with only declared keys passes Pi's argument check
// and reaches the first `tool_call` handler with every field intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import coreAdapter from "../index.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";
import { SUBAGENTS_PKG } from "./_subagents-handlers.ts";

type Json = Record<string, unknown>;

test("real session: the request declares the launch fields on subagent, and a call with only declared keys reaches tool_call intact", async (t) => {
  const root = fs.realpathSync.native(mkTestTmp("pf-lschema-"));
  t.after(() => rmTestTmp(root));
  const cwd = path.join(root, "proj");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  const savedChild = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  t.after(() => void (savedChild === undefined ? delete process.env.PI_SUBAGENT_CHILD : (process.env.PI_SUBAGENT_CHILD = savedChild)));

  const core = createFauxCore({ provider: "fake", models: [{ id: "m1", reasoning: false }] });
  const requests: { tools: { name: string; parameters: Json }[] }[] = [];
  const call = { agent: "builder", task: "build it", reason: "needs it", items: [1, "V"], occasion: "pre-pr", reads: 4, install: true };
  core.setResponses?.([fauxAssistantMessage([fauxToolCall("subagent", structuredClone(call), { id: "c1" })], { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("done"))]);
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("fake", {
    api: core.api as never,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "k",
    models: core.models.map((m) => ({ id: m.id, name: m.id, api: m.api as never, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 100000, maxTokens: 4000 })),
    streamSimple: ((model: unknown, context: { tools?: { name: string; parameters: Json }[] }, options: unknown) => {
      requests.push({ tools: structuredClone(getCurrentTools((context as unknown as { messages: never[] }).messages) as never) });
      return (core.streamSimple as (...a: unknown[]) => unknown)(model, context, options);
    }) as never,
  });

  const seen: { input: Json }[] = [];
  const first = (pi: { on: (e: string, h: (ev: { toolName: string; input: Json }) => unknown) => void }): void => {
    pi.on("tool_call", (ev) => void (ev.toolName === "subagent" && seen.push({ input: structuredClone(ev.input) })));
  };
  const subagents = (await import(pathToFileURL(path.join(SUBAGENTS_PKG, "index.js")).href)) as { default: (pi: unknown) => void };
  const settingsManager = SettingsManager.inMemory ? SettingsManager.inMemory({}) : SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [first as never, (pi: never) => coreAdapter(pi), subagents.default as never],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: modelRuntime.getModel("fake", "m1"), resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager });
  t.after(() => session.dispose?.());
  await session.bindExtensions?.({});
  await session.prompt("launch the builder");

  const declared = requests[0]?.tools.find((x) => x.name === "subagent");
  assert.ok(declared, `the first request declares subagent; declared: ${requests[0]?.tools.map((x) => x.name).join(",")}`);
  const properties = (declared.parameters as { properties: Json }).properties;
  for (const f of ["reason", "items", "occasion", "reads", "install"]) assert.ok(properties[f], `${f} is declared in the request`);
  assert.equal(seen.length, 1, "the call reached the tool_call handlers");
  assert.deepEqual(seen[0].input, call, "Pi's argument check left every field as the model gave it");
});
