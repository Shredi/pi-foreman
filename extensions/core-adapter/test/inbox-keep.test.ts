// Item 1: the control inbox folders of an async run survive an OS pass that removes empty folders (Windows Storage Sense).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keepControlInboxes, INBOX_PLACEHOLDER } from "../inboxkeep.ts";

const controlUrl = new URL("../../../node_modules/pi-subagents/src/runs/background/control-channel.js", import.meta.url);
const control = (await import(controlUrl.href)) as {
  watchAsyncControlInbox(asyncDir: string, opts: { onSteer?: (r: { message: string }) => void; onError?: (e: unknown) => void; pollIntervalMs?: number; safetyPollIntervalMs?: number }): () => void;
  requestAsyncSteer(asyncDir: string, payload: { message: string }): string;
};

/** A run folder as the parent leaves it before spawn: the root holds a file, nothing below it yet. */
function makeRun(): { root: string; asyncDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-inbox-"));
  const asyncDir = path.join(root, "run-1");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "run-fanout-budget.json"), "{}");
  return { root, asyncDir };
}

/** Removes every empty folder below `root`, deepest first, as the OS clean-up does. */
function storageSensePass(root: string): void {
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) walk(path.join(dir, e.name));
    if (dir !== root && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  walk(root);
}

const steerDir = (a: string): string => path.join(a, "control", "steer-requests");
const stopDir = (a: string): string => path.join(a, "control", "stop-requests");

test("keepControlInboxes creates both inbox folders with a non-json placeholder", () => {
  const { root, asyncDir } = makeRun();
  try {
    assert.equal(keepControlInboxes(asyncDir), null);
    for (const d of [steerDir(asyncDir), stopDir(asyncDir)]) assert.deepEqual(fs.readdirSync(d), [INBOX_PLACEHOLDER]);
    assert.ok(!INBOX_PLACEHOLDER.endsWith(".json"));
    assert.equal(keepControlInboxes(asyncDir), null, "idempotent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pass removing empty folders keeps the inbox folders when the helper ran, and a steer is consumed afterwards", async () => {
  const { root, asyncDir } = makeRun();
  const got: string[] = [];
  let dispose = (): void => {};
  try {
    keepControlInboxes(asyncDir);
    dispose = control.watchAsyncControlInbox(asyncDir, { onSteer: (r) => got.push(r.message), onError: (e) => assert.fail(String(e)), pollIntervalMs: 20, safetyPollIntervalMs: 20 });
    storageSensePass(root);
    assert.ok(fs.existsSync(steerDir(asyncDir)) && fs.existsSync(stopDir(asyncDir)));
    control.requestAsyncSteer(asyncDir, { message: "hello" });
    for (let i = 0; i < 100 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, ["hello"]);
    assert.ok(fs.existsSync(path.join(steerDir(asyncDir), INBOX_PLACEHOLDER)), "placeholder survives the consumed request");
    assert.deepEqual(fs.readdirSync(steerDir(asyncDir)), [INBOX_PLACEHOLDER]);
  } finally {
    dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control: without the helper the same pass removes the inbox folders", () => {
  const { root, asyncDir } = makeRun();
  try {
    fs.mkdirSync(steerDir(asyncDir), { recursive: true });
    fs.mkdirSync(stopDir(asyncDir), { recursive: true });
    storageSensePass(root);
    assert.ok(!fs.existsSync(steerDir(asyncDir)) && !fs.existsSync(stopDir(asyncDir)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keepControlInboxes never throws and reports the failure text", () => {
  const { root, asyncDir } = makeRun();
  try {
    fs.writeFileSync(path.join(asyncDir, "control"), "a file, not a folder");
    const failed = keepControlInboxes(asyncDir);
    assert.equal(typeof failed, "string");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
