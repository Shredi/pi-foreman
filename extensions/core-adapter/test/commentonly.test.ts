import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commentOnlySince, isCommentOnlyChange, worktreeTree } from "../commentonly.ts";

const GO = `package hub

// Hub fans messages out.
type Hub struct{}

/* broadcast sends msg
   to every client. */
func (h *Hub) broadcast(msg []byte) int {
	url := "http://example.invalid/a" // the sink
	return len(msg) + len(url)
}
`;

const RUST = `/// A hub.
pub struct Hub;

impl Hub {
    //! inner doc
    /* outer /* nested */ comment */
    pub fn send<'a>(&self, msg: &'a str) -> usize {
        let url = "http://example.invalid/a"; // the sink
        let c = '/';
        msg.len() + url.len() + c.len_utf8()
    }
}
`;

test("go: comments reworded, added and removed, whitespace re-indented -> comment-only", () => {
  const after = GO.replace("// Hub fans messages out.", "// Hub fans messages out to clients.\n// It is safe for one writer.")
    .replace("/* broadcast sends msg\n   to every client. */\n", "")
    .replace("// the sink", "/* where it goes */")
    .replace("\treturn len(msg)", "    return  len(msg)");
  assert.equal(isCommentOnlyChange("hub.go", GO, after), true);
});

test("go: a comment change plus one changed token -> not comment-only", () => {
  const after = GO.replace("// the sink", "// the new sink").replace("len(msg) + len(url)", "len(msg) - len(url)");
  assert.equal(isCommentOnlyChange("hub.go", GO, after), false);
});

test("go: a change inside a string literal after // -> not comment-only", () => {
  assert.equal(isCommentOnlyChange("hub.go", GO, GO.replace("example.invalid/a", "example.invalid/b")), false);
});

test("go: a build directive comment is code", () => {
  const before = `//go:build linux\n\npackage hub\n`;
  assert.equal(isCommentOnlyChange("hub.go", before, before.replace("linux", "darwin")), false);
});

test("rust: doc, inner and nested block comments changed -> comment-only", () => {
  const after = RUST.replace("/// A hub.", "/// A hub that fans out.")
    .replace("//! inner doc", "//! inner docs, reworded")
    .replace("/* outer /* nested */ comment */", "/* one /* two /* three */ */ */")
    .replace("// the sink", "");
  assert.equal(isCommentOnlyChange("src/hub.rs", RUST, after), true);
});

test("rust: a comment change plus one changed token -> not comment-only", () => {
  const after = RUST.replace("/// A hub.", "/// The hub.").replace("msg.len() + url.len()", "msg.len() * url.len()");
  assert.equal(isCommentOnlyChange("src/hub.rs", RUST, after), false);
});

test("rust: a change inside a string literal after // -> not comment-only; a lifetime is not a char", () => {
  assert.equal(isCommentOnlyChange("src/hub.rs", RUST, RUST.replace("example.invalid/a", "example.invalid/b")), false);
  assert.equal(isCommentOnlyChange("src/hub.rs", RUST, RUST.replace("let c = '/';", "let c = '*';")), false);
});

test("rust: a doc comment with a doctest fence is never comment-only", () => {
  const before = "/// ```\n/// assert_eq!(1, 1);\n/// ```\npub fn f() {}\n";
  assert.equal(isCommentOnlyChange("lib.rs", before, before.replace("1, 1", "1, 2")), false);
});

test("docs files always, unknown languages and JSX never", () => {
  assert.equal(isCommentOnlyChange("README.md", "a", "b"), true);
  assert.equal(isCommentOnlyChange("docs/guide.txt", "a", "b"), true);
  assert.equal(isCommentOnlyChange("main.c", "int a; // x", "int a; // y"), false);
  assert.equal(isCommentOnlyChange("app.tsx", "const a = 1; // x", "const a = 1; // y"), false);
});

const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("snapshot of a clean tree; a comment-only edit since lists the file, a code edit gives null", { skip: !gitAvailable }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-commentonly-"));
  try {
    const g = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: dir, stdio: "ignore" });
    g("init", "-q");
    fs.writeFileSync(path.join(dir, "hub.go"), GO);
    g("add", "hub.go");
    g("commit", "-q", "-m", "init");
    const tree = await worktreeTree(dir);
    assert.match(tree ?? "", /^[0-9a-f]{40,64}$/);
    const snap = { cwd: dir, tree: tree! };
    assert.deepEqual(await commentOnlySince(snap), []);
    fs.writeFileSync(path.join(dir, "hub.go"), GO.replace("// the sink", "// the real sink"));
    fs.mkdirSync(path.join(dir, ".workflow"));
    fs.writeFileSync(path.join(dir, ".workflow", "notes.txt"), "scratch\n");
    assert.deepEqual(await commentOnlySince(snap), ["hub.go"]);
    fs.writeFileSync(path.join(dir, "hub.go"), GO.replace("len(msg) +", "len(msg) -"));
    assert.equal(await commentOnlySince(snap), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
