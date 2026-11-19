// The workspace key of the findings store: the TypeScript key equals the Python one (scripts/foreman_config.py derive_key and workspace_key).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentBranch, deriveKey, mainCheckout, repoOf, sanitizeKey, workspaceKey, workspaceKeyOf } from "../workspacekey.ts";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PY = process.env.PI_FOREMAN_PYTHON || (process.platform === "win32" ? "python" : "python3");

function pyKey(code: string, ...args: string[]): string {
  const r = spawnSync(PY, ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(path.join(PKG, "scripts"))}); import foreman_config as bl\n${code}`, ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wskey-")));

test("deriveKey: known vectors for a POSIX, a case folding and a Windows path", () => {
  assert.equal(deriveKey("/Users/Me/Proj", "linux"), "Proj-37828794");
  assert.equal(deriveKey("/Users/Me/Proj", "darwin"), "Proj-3153d5d2");
  assert.equal(deriveKey("C:\\Work\\My Proj", "win32"), "My-Proj-65e355cd");
  assert.equal(deriveKey("C:/Work/My Proj", "win32"), "My-Proj-65e355cd");
  assert.match(deriveKey("/", "linux"), /^root-[0-9a-f]{8}$/);
});

test("the TypeScript key of a real directory equals Python derive_key", () => {
  const root = tmp();
  try {
    for (const name of ["plain", "with space", "dots.and-dash_1", "ümlaut"]) {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      assert.equal(workspaceKey(dir), pyKey("print(bl.derive_key(sys.argv[1]))", dir), name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked path is keyed by its real path, as Python does", { skip: process.platform === "win32" }, () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, "real"));
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    assert.equal(workspaceKey(path.join(root, "link")), workspaceKey(path.join(root, "real")));
    assert.equal(workspaceKey(path.join(root, "link")), pyKey("print(bl.derive_key(sys.argv[1]))", path.join(root, "link")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the retro.workspaceKey override is sanitised like Python workspace_key; a blank one is ignored", () => {
  const root = tmp();
  try {
    for (const k of ["my key/Sub dir", "plain-1", "a\\b"]) assert.equal(workspaceKey(root, k), pyKey("print(bl.workspace_key(sys.argv[1], {'retro': {'workspaceKey': sys.argv[2]}}))", root, k), k);
    assert.equal(workspaceKey(root, "my key/Sub dir"), "my-key/Sub-dir");
    assert.equal(workspaceKey(root, "   "), workspaceKey(root));
    assert.equal(workspaceKey(root, 5), workspaceKey(root));
    assert.throws(() => sanitizeKey("a/../b"));
    assert.throws(() => sanitizeKey(""));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a linked worktree and a subfolder resolve to the main checkout; outside git the folder itself", () => {
  const root = tmp();
  try {
    const main = path.join(root, "main-repo");
    fs.mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(main, "f.txt"), "x");
    git(main, "add", "f.txt");
    git(main, "commit", "-q", "-m", "base");
    const linked = path.join(root, "linked-tree");
    git(main, "worktree", "add", "-q", linked, "-b", "side");
    fs.mkdirSync(path.join(main, "deep"));
    for (const cwd of [main, linked, path.join(main, "deep")]) {
      assert.equal(mainCheckout(cwd), main);
      assert.equal(workspaceKeyOf(cwd), workspaceKey(main));
    }
    assert.equal(currentBranch(linked), "side");
    assert.equal(currentBranch(main), "main");
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    assert.equal(mainCheckout(plain), plain);
    assert.equal(currentBranch(plain), null);
    git(main, "checkout", "-q", "--detach");
    assert.equal(currentBranch(main), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a submodule layout (git dir below another .git) uses the workspace root", () => {
  const root = tmp();
  try {
    const top = path.join(root, "outer");
    const sub = path.join(top, "inner");
    fs.mkdirSync(sub, { recursive: true });
    const gitDir = path.join(top, ".git", "modules", "inner");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(sub, ".git"), `gitdir: ${gitDir}\n`);
    assert.equal(mainCheckout(sub), sub);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repoOf: origin, else the first remote by name, else null", async () => {
  const root = tmp();
  try {
    const repo = path.join(root, "r");
    fs.mkdirSync(repo);
    git(repo, "init", "-q");
    assert.equal(await repoOf(repo), null);
    git(repo, "remote", "add", "zeta", "https://example.test/acme/zeta.git");
    git(repo, "remote", "add", "beta", "git@example.test:acme/beta.git");
    assert.equal(await repoOf(repo), "acme/beta");
    git(repo, "remote", "add", "origin", "https://example.test/acme/widgets");
    assert.equal(await repoOf(repo), "acme/widgets");
    assert.equal(await repoOf(path.join(root, "missing")), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const OVERRIDES = [" my key ", "my key", "  ", "", "\t", "a.b", "..", ".", "a/../b", "a//b/", "/lead", "back\\slash", "ünï/cødé", "emoji😀x", "x".repeat(300), "\x1ckey\x1f", " key ", "﻿key", " key ", " . ", "k\n"];

test("workspaceKey override: same result as Python workspace_key for each value", { skip: spawnSync(PY, ["-I", "-c", "pass"]).status !== 0 }, () => {
  const root = tmp();
  for (const o of OVERRIDES) {
    const py = spawnSync(PY, ["-I", "-c", `import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(PKG, "scripts"))}); import foreman_config as bl\ntry:\n  print(json.dumps(bl.workspace_key(sys.argv[1], {}, sys.argv[2])))\nexcept ValueError:\n  print(json.dumps(None))`, root, o], { encoding: "utf8" });
    assert.equal(py.status, 0, py.stderr);
    const want = JSON.parse(py.stdout.trim()) as string | null;
    let got: string | null;
    try {
      got = workspaceKey(root, o);
    } catch {
      got = null;
    }
    assert.equal(got, want, JSON.stringify(o));
  }
  fs.rmSync(root, { recursive: true, force: true });
});
