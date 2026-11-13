// ranks.ts: the reader of ladder.equalOnStrongRisk and the tie check of a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { equalKeySentence, equalOnStrongRisk, rankTie } from "../ranks.ts";

const ranks = [{ match: "alpha*", tier: 0 }, { match: "beta*", tier: 0 }, { match: "gamma*", tier: 2 }];
const cfg = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ providers: { p: { ranks } }, ...extra });

test("equalOnStrongRisk is true only for a literal true", () => {
  assert.equal(equalOnStrongRisk(undefined), false);
  assert.equal(equalOnStrongRisk({}), false);
  for (const v of [false, "true", 1, null, {}]) assert.equal(equalOnStrongRisk({ ladder: { equalOnStrongRisk: v } }), false, String(v));
  assert.equal(equalOnStrongRisk({ ladder: { equalOnStrongRisk: true } }), true);
});

test("rankTie: two ranked models of the same tier under policy below", () => {
  assert.equal(rankTie(cfg(), "p/alpha-1", "p/beta-1", "builder"), true);
  assert.equal(rankTie(cfg(), "p/alpha-1", "p/alpha-1:high", "builder"), true);
  assert.equal(rankTie(cfg(), "p/alpha-1", "p/gamma-1", "builder"), false);
  assert.equal(rankTie(cfg(), "p/gamma-1", "p/alpha-1", "builder"), false);
});

test("rankTie is never true with an unranked model or no foreman model", () => {
  assert.equal(rankTie(cfg(), "p/other", "p/other", "builder"), false);
  assert.equal(rankTie(cfg(), "p/alpha-1", "p/other", "builder"), false);
  assert.equal(rankTie(cfg(), "p/other", "p/alpha-1", "builder"), false);
  assert.equal(rankTie(cfg(), null, "p/alpha-1", "builder"), false);
  assert.equal(rankTie({}, "p/alpha-1", "p/alpha-1", "builder"), false);
});

test("rankTie follows the role's policy: only below", () => {
  assert.equal(rankTie(cfg({ ladder: { childPolicy: "at-or-below" } }), "p/alpha-1", "p/beta-1", "builder"), false);
  assert.equal(rankTie(cfg({ ladder: { childPolicy: "any" } }), "p/alpha-1", "p/beta-1", "builder"), false);
  assert.equal(rankTie(cfg({ ladder: { rolePolicy: { builder: "at-or-below" } } }), "p/alpha-1", "p/beta-1", "builder"), false);
  assert.equal(rankTie(cfg({ ladder: { childPolicy: "at-or-below", rolePolicy: { builder: "below" } } }), "p/alpha-1", "p/beta-1", "builder"), true);
});

test("the sentence names the key and where it is set", () => {
  assert.match(equalKeySentence(), /ladder\.equalOnStrongRisk.*user or overlay config/);
});
