import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { requestText } from "../gatereview.ts";
import { scriptFacts, scriptFiles, scriptState } from "../scriptfact.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scriptfact-")));
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-scriptfact-out-")));
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});
const git = (...a: string[]): void => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: root, stdio: "ignore" });
};
fs.mkdirSync(path.join(root, "scripts"));
for (const f of ["clean.sh", "edited.sh"]) fs.writeFileSync(path.join(root, "scripts", f), "echo hi\n");
git("init", "-q");
git("add", "scripts");
git("commit", "-q", "-m", "init");
fs.writeFileSync(path.join(root, "scripts", "edited.sh"), "echo changed\n");
fs.writeFileSync(path.join(root, "scripts", "new.sh"), "echo new\n");
fs.writeFileSync(path.join(outsideDir, "o.sh"), "echo out\n");

test("script state: tracked-unchanged, modified, untracked, outside-repo", () => {
  assert.deepEqual(scriptState("scripts/clean.sh", root, root), { rel: "scripts/clean.sh", state: "tracked-unchanged" });
  assert.equal(scriptState("scripts/edited.sh", root, root).state, "modified");
  assert.equal(scriptState("scripts/new.sh", root, root).state, "untracked");
  assert.equal(scriptState("scripts/missing.sh", root, root).state, "untracked");
  assert.equal(scriptState(path.join(outsideDir, "o.sh"), root, root).state, "outside-repo");
  assert.equal(scriptState("../" + path.basename(outsideDir) + "/o.sh", root, root).state, "outside-repo");
});

test("script facts: the fact line format per interpreter form", () => {
  assert.deepEqual(scriptFacts("bash scripts/clean.sh", root, root), ["script: scripts/clean.sh tracked-unchanged"]);
  assert.deepEqual(scriptFacts("./scripts/clean.sh arg", root, root), ["script: scripts/clean.sh tracked-unchanged"]);
  assert.deepEqual(scriptFacts("sh -e scripts/edited.sh", root, root), ["script: scripts/edited.sh modified"]);
  assert.deepEqual(scriptFacts("node scripts/new.sh --x", root, root), ["script: scripts/new.sh untracked"]);
  assert.deepEqual(scriptFacts(`bash '${path.join(outsideDir, "o.sh")}'`, root, root), [`script: ${path.join(outsideDir, "o.sh")} outside-repo`]);
});

test("script facts: no script file, no fact", () => {
  assert.deepEqual(scriptFacts("ls scripts", root, root), []);
  assert.deepEqual(scriptFacts("npm run build", root, root), []);
  assert.deepEqual(scriptFacts("python3 -c 'print(1)'", root, root), []);
  assert.deepEqual(scriptFiles("bash $UNSET/x.sh", root), []);
});

test("review request carries the gate facts and cache keys differ with them", () => {
  const base = { surface: "bash", tool: "bash", role: "builder", kind: "child" as const, cwd: root, worktree: root, owned: [], branch: "b", remotes: [], ownerMessages: [], payload: "bash scripts/clean.sh" };
  const text = requestText({ ...base, facts: ["script: scripts/clean.sh tracked-unchanged"] }, "n1");
  assert.match(text, /^script: scripts\/clean\.sh tracked-unchanged$/m);
  assert.ok(text.indexOf("script: scripts/clean.sh") < text.indexOf("## The call"));
  assert.doesNotMatch(requestText(base, "n1"), /script: /);
});
