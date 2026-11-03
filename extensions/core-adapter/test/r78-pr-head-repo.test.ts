import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch } from "../openprs.ts";

const node = (over: Record<string, unknown> = {}) => ({
  number: 1, title: "t", url: "https://example.test/acme/widgets/pull/1", isDraft: false,
  repository: { nameWithOwner: "acme/widgets" }, author: { login: "octo" }, commits: { nodes: [] }, ...over,
});
const parse = (n: unknown) => parseSearch(JSON.stringify({ data: { search: { nodes: [n] } } }))[0];

test("headRepo is the head repository; absent, null or invalid leaves the key out", () => {
  assert.equal(parse(node({ headRepository: { nameWithOwner: "fork/widgets" } })).headRepo, "fork/widgets");
  assert.equal("headRepo" in parse(node({ headRepository: null })), false);
  assert.equal("headRepo" in parse(node({ headRepository: { nameWithOwner: 3 } })), false);
  assert.equal("headRepo" in parse(node()), false);
});
