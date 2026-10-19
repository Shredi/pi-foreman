// R17 item 2: the `/foreman doctor` autoReview line (review.ts autoReviewDoctorLine).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { autoReviewDoctorLine } from "../review.ts";

const PKG = path.resolve("/pkg");
const SHIPPED = path.join(PKG, "config", "permissions.rules.md");
const model = { provider: "fake", modelId: "small", timeoutMs: 15000 };

test("r17 doctor autoReview: on, shipped rules, model", () => {
  assert.equal(autoReviewDoctorLine(true, SHIPPED, PKG, model), "autoReview: on (rulesFile: shipped, model: fake/small)");
});

test("r17 doctor autoReview: off", () => {
  assert.equal(autoReviewDoctorLine(false, SHIPPED, PKG, model), "autoReview: off (rulesFile: shipped, model: fake/small)");
});

test("r17 doctor autoReview: custom rules path", () => {
  const f = path.resolve("/agent/my-rules.md");
  assert.equal(autoReviewDoctorLine(true, f, PKG, model), `autoReview: on (rulesFile: ${f}, model: fake/small)`);
});

test("r17 doctor autoReview: no model, no rules file", () => {
  assert.equal(autoReviewDoctorLine(true, null, PKG, null), "autoReview: on (rulesFile: shipped, model: none)");
});
