// Ledger 10/12: config/secret-paths.json is the one key-file list; the gate's secret-path floor reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { SECRET_GLOBS, SECRET_PATHS_FILE, secretPath, type FloorEnv } from "../floors.ts";

const env: FloorEnv = { platform: "linux", cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: [] };

test("the list file parses and every pattern is a non-empty string", () => {
  const v = JSON.parse(fs.readFileSync(SECRET_PATHS_FILE, "utf8")) as unknown;
  assert.ok(Array.isArray(v) && v.length > 0);
  for (const p of v as unknown[]) assert.ok(typeof p === "string" && p.length > 0, String(p));
  assert.deepEqual([...SECRET_GLOBS], v);
});

test("the floor matches the listed key-file spellings", () => {
  for (const w of ["/w/repo/secrets.kdbx", "/w/repo/keystore.jks", "/w/repo/cert.pfx", "/h/me/x/id_ecdsa", "/h/me/x/id_ecdsa_work", "/w/repo/a.pem", "/w/repo/id_ed25519"]) {
    assert.equal(secretPath(w, env)?.rule, "floor-secret-path", w);
  }
});

test("public keys and ordinary files stay readable", () => {
  for (const w of ["/h/me/x/id_ecdsa.pub", "/w/repo/notes.txt", "/w/repo/src/keys.ts"]) assert.equal(secretPath(w, env), null, w);
});
