// Model map check (modelcheck.ts): the foreman idle rung is listed with the other rungs, labelled `.idle`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mappedModels, modelGaps } from "../modelcheck.ts";

const config = {
  providers: {
    p: { roles: { foreman: { model: "p/big", idle: { model: "q/cheap", thinking: "low" } }, builder: { model: "p/b", idle: { model: "p/ignored" } } } },
  },
};

test("mappedModels lists the foreman idle rung, resolved in its own provider; other roles' idle is ignored", () => {
  const idle = mappedModels(config, "p").filter((m) => m.strength === "idle");
  assert.deepEqual(idle, [{ role: "foreman", strength: "idle", mapProvider: "p", provider: "q", id: "cheap" }]);
});

test("an idle rung missing from the registry, or on a provider without auth, is a gap labelled .idle", () => {
  const registry = { find: (p: string, id: string) => (p === "q" ? undefined : { provider: p, id }), getProviderAuthStatus: (p: string) => ({ configured: p !== "q" }) };
  const gaps = modelGaps(config, "p", registry);
  assert.ok(gaps.includes("model q/cheap (providers.p.roles.foreman.idle) is not in the model registry"), gaps.join("\n"));
  assert.ok(gaps.includes("no auth for provider q, which the map for p uses"));
});
