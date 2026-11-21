// Served-link root ids: 16 random bytes as 26 lowercase base32 characters; other shapes are 404 or skipped.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { handle, pagesStateDir, registerRoot, rootsDir } from "../pageserver.ts";
import type { HandlerCtx } from "../pageserver.ts";
import { mkTestTmp, rmTestTmp } from "./_tmpbase.ts";

let tmp: string;
let stateDir: string;
let pages: string;

const ctx = (): HandlerCtx => ({ stateDir, hosts: () => ({ bind: "127.0.0.1", baseHost: null }), health: () => ({ key: "k".repeat(32), info: { pid: 1, version: "1.0.0", port: 1, bind: "127.0.0.1" } }), touch: () => {} });
const status = (id: string): number => handle(ctx(), "GET", `/${id}/plan.html`, "127.0.0.1:47317").status;

before(() => {
  tmp = fs.realpathSync(mkTestTmp("pageserver-rootid-"));
  stateDir = pagesStateDir(path.join(tmp, "agent"));
  pages = path.join(tmp, "pages");
  fs.mkdirSync(pages, { recursive: true });
  fs.writeFileSync(path.join(pages, "plan.html"), "<h1>x</h1>");
});
after(() => rmTestTmp(tmp));

test("a new id is 26 chars of [a-z2-7]", () => {
  const id = registerRoot(stateDir, pages, "dir");
  assert.ok(id);
  assert.match(id, /^[a-z2-7]{26}$/);
  assert.equal(status(id), 200);
});

test("ids of many registrations are distinct", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const d = path.join(tmp, `d${i}`);
    fs.mkdirSync(d);
    const id = registerRoot(stateDir, d, "dir");
    assert.ok(id);
    assert.match(id, /^[a-z2-7]{26}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 50);
});

test("a 43-char base64url id and an uppercase variant give 404", () => {
  const id = registerRoot(stateDir, pages, "dir")!;
  assert.equal(status("Ab_-".repeat(10) + "Ab_"), 404);
  assert.equal(status(id.toUpperCase()), 404);
});

test("old-shape root files are skipped", () => {
  const old = "Ab_-".repeat(10) + "Ab_";
  const d = path.join(tmp, "old");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "plan.html"), "x");
  fs.writeFileSync(path.join(rootsDir(stateDir), `${old}.json`), JSON.stringify({ path: fs.realpathSync(d), kind: "dir", touchedAt: Date.now() }));
  assert.equal(status(old), 404);
  const id = registerRoot(stateDir, d, "dir");
  assert.ok(id);
  assert.notEqual(id, old);
  assert.match(id, /^[a-z2-7]{26}$/);
});
