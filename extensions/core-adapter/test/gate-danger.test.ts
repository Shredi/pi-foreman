// r79 item 3: the dangerous class (defaults.ts DANGER_RULES / dangerMatch). A positive and a negative case per entry; no built-in allow matches
// a positive case; the narrowed `default-role-launch`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { DANGER_RULES, dangerMatch, lineDefault, toolDefault } from "../defaults.ts";
import type { DangerEnv, DefaultCtx, GitFacts } from "../defaults.ts";
import { pathDecide } from "../pathrules.ts";
import type { GateRoots } from "../pathrules.ts";
import { parseShell } from "../shellast.ts";
import { webReadAllow } from "../webread.ts";
import { mkTestTmp } from "./_tmpbase.ts";
import { shPath } from "./_shpath.ts";

const base = fs.realpathSync(mkTestTmp("pf79-danger-"));
const wt = path.join(base, "wt");
const scr = path.join(base, "tmp", "pi-foreman-scratch", "mine");
const tmpDir = path.join(base, "tmp");
const owned = path.join(base, "owned");
for (const d of [path.join(wt, "src"), scr, path.join(owned, "sib")]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(wt, "a.txt"), "x\n");
after(() => fs.rmSync(base, { recursive: true, force: true }));

const roots: GateRoots = { worktree: wt, scratch: [scr], tmp: [tmpDir, "/tmp"], scratchBase: path.join(tmpDir, "pi-foreman-scratch"), owned: [path.join(owned, "*")], install: [], roundFlow: [], handoffs: [], child: false, role: "foreman", tmpAccess: true };
const facts = (upstream: boolean): GitFacts => ({ currentBranch: () => "round/79-x", protectedBranches: () => ["main"], pushConfigured: () => false, hasUpstream: () => upstream });
const denv = (upstream = false): DangerEnv => ({ roots, platform: process.platform, cwd: wt, facts: facts(upstream) });
const dctx = (upstream = false): DefaultCtx => ({ roots, facts: facts(upstream), platform: process.platform, cwd: wt });

type Case = { tool?: string; line?: string; input?: Record<string, unknown>; upstream?: boolean };
const callOf = (c: Case) => {
  const tool = c.tool ?? "bash";
  const input = c.input ?? { command: c.line };
  return tool === "bash" || tool === "bg_run" || tool === "foreman_bg" ? { tool, input, text: c.line!, segments: parseShell(c.line!, { cwd: wt, env: { FOREMAN_SCRATCH: scr } }) } : { tool, input };
};
const hit = (c: Case): string | null => dangerMatch(callOf(c), denv(c.upstream))?.name ?? null;
const sh = (line: string, o: Partial<Case> = {}): Case => ({ line, ...o });

const OUT = shPath(path.join(base, "outside"));
const SCR = shPath(scr);

const POSITIVE: Record<string, Case[]> = {
  "danger-write-outside": [
    sh(`echo x > ${OUT}/f`),
    sh(`cp a.txt ${OUT}/b.txt`),
    { tool: "write", input: { path: `${OUT}/f`, content: "x" } },
    { tool: "edit", input: { path: `${OUT}/f`, edits: [] } },
    { tool: "foreman_move", input: { src: path.join(wt, "a.txt"), dst: `${OUT}/a.txt` } },
    { tool: "foreman_copy", input: { src: path.join(wt, "a.txt"), dst: `${OUT}/a.txt` } },
  ],
  "danger-deploy": [
    sh("ssh host ls"), sh("scp a.txt user@host:/tmp/"), sh("rsync -a src/ host:/srv/"), sh("rsync -a ssh://host/x src/"),
    sh("kubectl apply -f x.yaml"), sh("kubectl delete pod x -n prod"), sh("oc rollout restart d/x"), sh("kubectl config use-context prod"),
    sh("helm upgrade r c"), sh("helm uninstall r"), sh("terraform apply"), sh("tofu destroy"), sh("terraform import a.b c"), sh("pulumi up"),
    sh("ansible-playbook x.yml"), sh("ansible all -m ping"), sh("docker run img"), sh("docker exec c ls"), sh("docker rm c"), sh("docker compose up -d"), sh("podman compose down"),
    sh("systemctl restart nginx"), sh("service nginx restart"), sh("launchctl kickstart system/x"), sh("crontab -e"), sh("crontab -r"), sh("crontab jobs.txt"),
    sh("aws s3 rm s3://b/x"), sh("aws ec2 terminate-instances --instance-ids i-1"), sh("gcloud compute instances delete x"), sh("az vm create -n x"), sh("vercel deploy"), sh("flyctl deploy"), sh("wrangler publish"), sh("netlify deploy --prod"),
  ],
  "danger-forge": [
    sh("gh pr merge 3"), sh("gh pr close 3"), sh("gh pr ready 3"), sh("gh pr edit 3 --title x"), sh("gh pr review 3 --approve"), sh("gh pr comment 3 -b x"),
    sh("gh api -X POST repos/o/r/issues"), sh("gh api --method=DELETE repos/o/r"), sh("gh api repos/o/r/issues -f title=x"), sh("gh api repos/o/r --input body.json"),
    sh("gh repo delete o/r"), sh("gh repo edit o/r"), sh("gh repo create x"), sh("gh secret set X"), sh("gh variable set X"), sh("gh release create v1"), sh("gh release delete v1"),
    sh("gh api graphql -f query='mutation{addStar(input:{starrableId:\"x\"}){clientMutationId}}'"), sh("gh api graphql --input q.json"), sh("gh api graphql -f query=@q.graphql"),
    sh("gh issue create"), sh("gh issue close 3"), sh("gh issue edit 3"), sh("glab mr merge 3"), sh("glab api -X PUT projects/1"),
  ],
  "danger-publish": [sh("npm publish"), sh("pnpm publish"), sh("yarn npm publish"), sh("bun publish"), sh("cargo publish"), sh("twine upload dist/x.whl"), sh("gem push x.gem"), sh("docker push img"), sh("gh release upload v1 f.zip")],
  "danger-net-write": [
    sh("curl -X POST https://example.com/x"), sh("curl -XPUT https://example.com/x"), sh("curl --request DELETE https://example.com/x"), sh("curl -d a=1 https://example.com/x"), sh("curl --data-binary @f https://example.com/x"),
    sh("curl -sSd x https://example.com/x"), sh("curl -F f=@x https://example.com/x"), sh("curl -T f https://example.com/x"), sh("curl --json '{}' https://example.com/x"), sh("wget --post-data=a=1 https://example.com/x"),
    sh("wget --method=PUT https://example.com/x"), sh("http POST example.com a=1"), sh("http example.com a=1"), sh("xh PUT example.com"), sh("nc host 80"), sh("ncat host 80"), sh("socat - TCP:host:80"),
    sh(`curl -n https://example.com/x -o ${SCR}/p`), sh(`curl -H @h.txt https://example.com/x -o ${SCR}/p`), sh(`curl --output-dir ${OUT} -o a https://example.com/x`),
    { tool: "fetch", input: { url: "https://example.com/x", method: "POST" } }, { tool: "fetch", input: { url: "https://example.com/x", body: "a" } }, { tool: "fetch", input: { url: "https://example.com/x", headers: { Authorization: "x" } } },
  ],
  "danger-install": [
    sh("npm install"), sh("npm i lodash"), sh("npm ci"), sh("npm install -g x"), sh("npm uninstall x"), sh("pnpm add x"), sh("yarn"), sh("yarn add x"), sh("bun install"), sh("npx cowsay"), sh("pnpm dlx x"), sh("bunx x"), sh("uvx x"),
    sh("pip install x"), sh("pip3 install x"), sh("uv pip install x"), sh("python3 -m pip install x"), sh("cargo install ripgrep"), sh("gem install x"), sh("brew install x"), sh("brew upgrade"),
    sh("apt-get install x"), sh("apt remove x"), sh("dnf install x"), sh("choco install x"), sh("winget install x"), sh("scoop uninstall x"), sh("pacman -S x"), sh("pacman -Syu"),
  ],
  "danger-git": [
    sh("git reset --hard HEAD~1"), sh("git -C src reset --hard"), sh("git clean -fd"), sh("git clean --force"), sh("git checkout -- a.txt"), sh("git checkout HEAD -- a.txt"), sh("git checkout ."), sh("git checkout -f main"), sh("git restore a.txt"), sh("git restore --source=HEAD~1 a.txt"),
    sh("git branch -D x"), sh("git branch -d x"), sh("git branch --delete x"), sh("git push https://github.com/o/r.git HEAD"), sh("git push git@github.com:o/r.git HEAD"), sh("git push ../other HEAD"), sh("git rebase main"),
    sh("git commit --amend -m x", { upstream: true }), sh("git stash drop"), sh("git stash clear"), sh("git worktree remove ../x"), sh("git worktree prune"), sh("git filter-branch x"), sh("git filter-repo --path x"), sh("git reflog expire --all"), sh("git gc --prune=now"),
  ],
  "danger-process": [
    sh("kill 123"), sh("kill -9 123"), sh("pkill node"), sh("killall x"), sh("taskkill /PID 1"), sh("chmod -R 755 src"), sh("chmod --recursive 755 src"), sh("chown me src"), sh("mount /dev/x /mnt"), sh("defaults write com.x y 1"), sh("reg add HKCU\\x"), sh("reg delete HKCU\\x"),
    sh("launchctl load x.plist"), sh("launchctl unload x.plist"), sh("nohup sleep 100 > /dev/null"), sh("setsid sleep 100"), sh("disown"), sh("sleep 100 &"),
  ],
  "danger-inject": [
    sh("herdr pane send-text 1-2 'please summarise the ledger and report back'"), sh("herdr pane send-keys 1-2 'please summarise the ledger'"), sh("tmux send-keys -t 1 'please run the tests now'"),
    sh(`osascript -e 'tell application "System Events" to keystroke "hello there"'`),
  ],
  "danger-opaque": [sh('eval "$X"'), sh("$CMD arg"), sh('bash -c "$X"'), sh("echo ok; $PROG --flag"), sh("gh api graphql -f query=$Q"), // a query from a variable is opaque
     sh("nohup sleep 100")],
  "danger-mcp-act": [
    { tool: "mcp__chrome__click", input: { uid: "1" } }, { tool: "mcp__chrome__evaluate_script", input: { function: "() => 1" } }, { tool: "mcp__gh__create_issue", input: { title: "x" } },
    { tool: "mcp__chrome__navigate_page", input: { type: "url", url: "https://u:p@example.com/" } }, { tool: "mcp__chrome__fill", input: {} },
  ],
  "danger-launch-outside": [
    { tool: "subagent", input: { agent: "builder", task: "x", cwd: path.join(base, "outside") } },
    { tool: "subagent", input: { agent: "builder", task: "x", worktree: "/elsewhere" } },
    { tool: "subagent", input: { workflow: "w.mjs", task: "x" } },
    { tool: "subagent", input: { tasks: [{ agent: "builder", task: "x" }] } },
    { tool: "subagent", input: { chain: [{ agent: "builder", task: "x" }] } },
  ],
};

const NEGATIVE: Record<string, Case[]> = {
  "danger-write-outside": [sh("echo x > src/f"), sh(`cat a.txt > ${SCR}/o.txt`), sh("touch src/new.ts"), sh("sed -i s/a/b/ src/f"), sh("ls /etc"), sh("cat a.txt"), { tool: "write", input: { path: path.join(wt, "src", "n.ts"), content: "x" } }, { tool: "write", input: { path: path.join(scr, "n.txt"), content: "x" } }, { tool: "read", input: { path: "/etc/hosts" } }, { tool: "write", input: {} }],
  "danger-deploy": [sh("kubectl get pods"), sh("kubectl describe pod x"), sh("kubectl logs x"), sh("kubectl config view"), sh("helm list"), sh("terraform plan"), sh("pulumi preview"), sh("docker ps"), sh("docker build ."), sh("systemctl status x"), sh("service nginx status"), sh("launchctl list"), sh("crontab -l"), sh("aws s3 ls"), sh("gcloud compute instances list"), sh("az vm show -n x"), sh("flyctl status"), sh("rsync -a src/ dst/"), sh("scp a.txt b.txt"), sh("ssh --version")],
  "danger-forge": [sh("gh pr create --title t --body b"), sh("gh pr view 3"), sh("gh pr list"), sh("gh pr diff 3"), sh("gh pr checks 3"), sh("gh issue view 3"), sh("gh repo view o/r"), sh("gh api repos/o/r"), sh("gh api -X GET repos/o/r"), sh("gh run view 1"), sh("gh release view v1"), sh("gh search issues x"), sh("gh search prs x"), sh("gh api graphql -f query='query{viewer{login}}'"), sh("gh auth status"), sh("gh --version"), sh("glab mr view 3")],
  "danger-publish": [sh("npm test"), sh("cargo build"), sh("docker build ."), sh("gem list"), sh("twine check dist/x.whl"), sh("gh release view v1")],
  "danger-net-write": [sh(`curl -sS https://example.com/p -o ${SCR}/p`), sh(`curl -I https://example.com/p -o ${SCR}/h`), sh(`wget -q -O ${SCR}/x https://example.com/x`), sh(`curl -sS http://localhost:3000/ -o ${SCR}/h`), sh(`curl -sS http://127.0.0.1:8080/health -o ${SCR}/h`), sh("curl -sS http://localhost:8080/api | head -c 200"), sh("http GET example.com"), sh("xh example.com"), { tool: "fetch", input: { url: "https://example.com/x" } }, { tool: "fetch", input: { url: "http://localhost:8080/" } }],
  "danger-install": [sh("npm test"), sh("npm run build"), sh("pip list"), sh("pip --version"), sh("brew list"), sh("cargo build"), sh("pacman -Ss x"), sh("apt list"), sh("yarn --version"), sh("python3 -m pytest")],
  "danger-git": [sh("git status"), sh("git log"), sh("git reset HEAD a.txt"), sh("git clean -n"), sh("git clean -nd"), sh("git checkout feature"), sh("git checkout -b feature2"), sh("git restore --staged a.txt"), sh("git branch -a"), sh("git branch newbranch"), sh("git push origin HEAD"), sh("git push -u origin round/79-x"), sh("git commit -m x"), sh("git commit --amend -m x", { upstream: false }), sh("git stash"), sh("git stash pop"), sh("git worktree add ../x"), sh("git worktree list"), sh("git merge main"), sh("git fetch origin")],
  "danger-process": [sh("chmod +x src/run.sh"), sh("defaults read com.x"), sh("reg query HKCU\\x"), sh("ps aux"), sh("sleep 1 && echo done"), sh("echo a && echo b"), sh("launchctl list"), { tool: "bg_run", line: "sleep 100 &", input: { command: "sleep 100 &" } }],
  "danger-inject": [sh("herdr pane read 1-2"), sh("herdr pane list"), sh("tmux list-panes"), sh("echo herdr pane send-text hi")],
  "danger-opaque": [sh("echo hi"), sh("ls src"), sh("cat a.txt | wc -l")],
  "danger-mcp-act": [{ tool: "mcp__chrome__list_pages", input: {} }, { tool: "mcp__chrome__take_snapshot", input: {} }, { tool: "mcp__chrome__navigate_page", input: { type: "url", url: "https://example.com/" } }, { tool: "mcp__x__get_thing", input: {} }, { tool: "mcp__x__search_things", input: {} }, { tool: "mcp__x__read_file", input: {} }, { tool: "mcp__x__find_x", input: {} }, { tool: "mcp__x__describe_x", input: {} }, { tool: "read", input: { path: "a.txt" } }],
  "danger-launch-outside": [
    { tool: "subagent", input: { agent: "builder", task: "x" } }, { tool: "subagent", input: { agent: "builder", task: "x", cwd: wt } }, { tool: "subagent", input: { agent: "reviewer", task: "x", worktree: path.join(owned, "sib") } },
    { tool: "subagent", input: { agent: "builder", task: "x", cwd: scr } }, { tool: "subagent", input: { action: "list" } },
  ],
};

test("DANGER_RULES: every entry has the danger- name and a reason; the tables cover each entry", () => {
  const names = DANGER_RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  for (const r of DANGER_RULES) {
    assert.match(r.name, /^danger-[a-z-]+$/);
    assert.ok(r.reason.length > 10 && r.reason.length < 300, r.name);
  }
  assert.deepEqual([...names].sort(), Object.keys(POSITIVE).sort());
  assert.deepEqual([...names].sort(), Object.keys(NEGATIVE).sort());
});

test("positive: each case falls into its own entry (when several match, the table order decides, so the case's own entry must match)", () => {
  for (const [name, cases] of Object.entries(POSITIVE)) {
    const rule = DANGER_RULES.find((r) => r.name === name)!;
    for (const c of cases) assert.ok(rule.test(callOf(c), denv(c.upstream)), `${name}: ${c.line ?? `${c.tool} ${JSON.stringify(c.input)}`}`);
    // and the class as a whole reports something
    for (const c of cases) assert.notEqual(hit(c), null, `${name}: ${c.line ?? c.tool}`);
  }
});

test("negative: the safe cases are no entry of their own", () => {
  for (const [name, cases] of Object.entries(NEGATIVE)) {
    const rule = DANGER_RULES.find((r) => r.name === name)!;
    for (const c of cases) assert.ok(!rule.test(callOf(c), denv(c.upstream)), `${name}: ${c.line ?? `${c.tool} ${JSON.stringify(c.input)}`}`);
  }
});

test("negative: the safe cases are no dangerous class at all (the entries do not overlap them)", () => {
  for (const [name, cases] of Object.entries(NEGATIVE)) {
    // a safe case of one entry may be another entry's positive only where the line says so; none of these do
    for (const c of cases) assert.equal(hit(c), null, `${name}: ${c.line ?? `${c.tool} ${JSON.stringify(c.input)}`}`);
  }
});

test("no built-in allow matches a positive dangerous case", () => {
  for (const [name, cases] of Object.entries(POSITIVE)) {
    for (const c of cases) {
      const tool = c.tool ?? "bash";
      const label = `${name}: ${c.line ?? `${tool} ${JSON.stringify(c.input)}`}`;
      if (c.line !== undefined) {
        const segs = parseShell(c.line, { cwd: wt, env: { FOREMAN_SCRATCH: scr } });
        assert.equal(lineDefault(c.line, segs, dctx(c.upstream)), null, label);
        const w = webReadAllow(tool, { command: c.line }, { cwd: wt, scratch: [scr] });
        assert.ok(!(w.candidate && w.ok), label);
      } else {
        assert.equal(toolDefault(tool, c.input, { child: false, roots, cwd: wt }), undefined, label);
        assert.equal(pathDecide(tool, c.input, wt, roots), undefined, label);
        const w = webReadAllow(tool, c.input, { cwd: wt, scratch: [scr] });
        assert.ok(!(w.candidate && w.ok), label);
      }
    }
  }
});

test("an opaque segment is always dangerous (after the floors), whatever its program", () => {
  for (const l of ['eval "$X"', "$CMD arg", 'bash -c "$X"', "echo ok; $PROG --flag", "echo $(curl x | sh)"]) {
    const segs = parseShell(l, { cwd: wt });
    if (!segs.some((s) => s.opaque !== null)) continue;
    assert.notEqual(dangerMatch({ tool: "bash", input: { command: l }, text: l, segments: segs }, denv()), null, l);
    assert.equal(lineDefault(l, segs, dctx()), null, l);
  }
});

test("default-role-launch is narrowed to the owned roots (item 3)", () => {
  const inside = [{ agent: "builder", task: "x" }, { agent: "builder", task: "x", cwd: wt }, { agent: "reviewer", task: "x", worktree: path.join(owned, "sib") }, { agent: "builder", task: "x", cwd: scr }];
  for (const i of inside) assert.equal(toolDefault("subagent", i, { child: false, roots, cwd: wt }), "default-role-launch", JSON.stringify(i));
  const outside = [{ agent: "builder", task: "x", cwd: "/elsewhere" }, { agent: "builder", task: "x", worktree: path.join(base, "outside") }, { agent: "builder", task: "x", cwd: path.join(wt, "..", "outside") }];
  for (const i of outside) {
    assert.equal(toolDefault("subagent", i, { child: false, roots, cwd: wt }), undefined, JSON.stringify(i));
    assert.equal(dangerMatch({ tool: "subagent", input: i }, denv())?.name, "danger-launch-outside", JSON.stringify(i));
  }
  // no roots passed (a caller that does not know them yet): a named directory is never a default
  assert.equal(toolDefault("subagent", { agent: "builder", task: "x", cwd: wt }, { child: false }), undefined);
  assert.equal(toolDefault("subagent", { agent: "builder", task: "x" }, { child: false }), "default-role-launch");
  assert.equal(toolDefault("subagent", { agent: "builder", task: "x" }, { child: true }), undefined);
});

test("a dangerous segment is never a default, also inside an otherwise plain line", () => {
  for (const l of ["git status && git reset --hard", "ls && npm install", "cat a.txt; kill 1"]) {
    assert.equal(lineDefault(l, parseShell(l, { cwd: wt }), dctx()), null, l);
    assert.notEqual(hit({ line: l }), null, l);
  }
  for (const l of ["git status && git log", "ls src && cat a.txt"]) assert.notEqual(lineDefault(l, parseShell(l, { cwd: wt }), dctx()), null, l);
});
