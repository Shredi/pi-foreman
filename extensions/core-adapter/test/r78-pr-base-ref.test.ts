import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch } from "../openprs.ts";

const node = (over: Record<string, unknown> = {}) => ({
  number: 1, title: "t", url: "https://example.test/acme/widgets/pull/1", isDraft: false,
  repository: { nameWithOwner: "acme/widgets" }, author: { login: "octo" }, commits: { nodes: [] }, ...over,
});
const parse = (n: unknown) => parseSearch(JSON.stringify({ data: { search: { nodes: [n] } } }))[0];

test("baseRefName is stored per entry; absent or invalid leaves the key out", () => {
  assert.equal(parse(node({ baseRefName: "main" })).baseRefName, "main");
  assert.equal("baseRefName" in parse(node({ baseRefName: "" })), false);
  assert.equal("baseRefName" in parse(node({ baseRefName: 3 })), false);
  assert.equal("baseRefName" in parse(node()), false);
});
