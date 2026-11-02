// r79 item 1: rules.ts: parseRule, matchRules (deny > ask > allow, per segment), proposeRule, describeCall, normaliseSegment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCall, matchRules, normaliseSegment, parseRule, proposeRule } from "../rules.ts";
import type { RuleCall, RuleSets } from "../rules.ts";
import { parseShell } from "../shellast.ts";

const env = { cwd: "/co/wt", home: "/home/me", platform: "linux", checkout: "/co" };
const rule = (t: string) => {
  const r = parseRule(t);
  if ("error" in r) throw new Error(`${t}: ${r.error}`);
  return r.rule;
};
const sets = (o: { allow?: string[]; ask?: string[]; deny?: string[] }): RuleSets => ({ allow: (o.allow ?? []).map(rule), ask: (o.ask ?? []).map(rule), deny: (o.deny ?? []).map(rule) });
const sh = (line: string): RuleCall => ({ tool: "bash", segments: parseShell(line).map((s) => ({ text: normaliseSegment(s), opaque: s.opaque !== null, writesRedirect: s.redirects.some((r) => r.op !== "<" && r.target !== "/dev/null") })) });
const verdict = (s: RuleSets, c: RuleCall) => matchRules(s, c, env).verdict;

test("parseRule: accepted forms", () => {
  for (const t of ["Bash", "Bash(git status *)", "Bash(npm run:*)", "Read(~/notes/**)", "Edit(src/**)", "Write(//etc/x)", "fetch(https://example.com/*)", "mcp__srv__tool", "mcp__srv__*", "mcp__srv", "intercom", "WebThing(x)"]) {
    assert.equal(parseRule(t).ok, true, t);
  }
});

test("parseRule: refused forms name the problem", () => {
  for (const t of ["", "  ", "Bash(", "Bash()", "Bash(x", "bash(ls *)", "read(x)", "Read()", "(x)"]) {
    const r = parseRule(t);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.ok("error" in r && r.error.length > 0);
  }
});

test("Bash rules match each segment; a trailing ' *' also matches the bare prefix", () => {
  const s = sets({ allow: ["Bash(git status *)", "Bash(ls *)"] });
  assert.equal(verdict(s, sh("git status")), "allow");
  assert.equal(verdict(s, sh("git status -s")), "allow");
  assert.equal(verdict(s, sh("git statusx")), "none");
  assert.equal(verdict(s, sh("git status && ls -la")), "allow");
  assert.equal(verdict(s, sh("git status && rm -rf x")), "none", "every segment must be covered");
});

test("precedence: deny beats ask beats allow, on any segment", () => {
  const s = sets({ allow: ["Bash(git *)"], ask: ["Bash(git push *)"], deny: ["Bash(git push --force *)"] });
  assert.equal(verdict(s, sh("git log")), "allow");
  assert.equal(verdict(s, sh("git push origin main")), "ask");
  assert.equal(verdict(s, sh("git push --force origin main")), "deny");
  assert.equal(verdict(s, sh("git log && git push --force x")), "deny");
});

test("opaque segments are never allowed by a rule; deny and ask still apply", () => {
  const s = sets({ allow: ["Bash(echo *)"], deny: ["Bash(rm *)"] });
  assert.equal(matchRules(s, { tool: "bash", segments: [{ text: "echo $(x)", opaque: true, writesRedirect: false }] }, env).verdict, "none");
  assert.equal(matchRules(s, { tool: "bash", segments: [{ text: "rm x", opaque: true, writesRedirect: false }] }, env).verdict, "deny");
});

test("a redirecting segment is allowed only by a rule that names the redirect", () => {
  assert.equal(verdict(sets({ allow: ["Bash(echo *)"] }), sh("echo x > out.txt")), "none");
  assert.equal(verdict(sets({ allow: ["Bash(echo *)"] }), sh("echo x > /dev/null")), "allow");
  assert.equal(verdict(sets({ deny: ["Bash(echo *)"] }), sh("echo x > out.txt")), "deny");
});

test("built-in allows cover units no rule matched, and appear in the verdict", () => {
  const s = sets({ allow: ["Bash(ls *)"] });
  const r = matchRules(s, sh("ls && pwd"), env, (i) => (i === 1 ? "default-pwd" : null));
  assert.deepEqual(r, { verdict: "allow", rule: "Bash(ls *)+default-pwd" });
  assert.equal(matchRules(s, sh("ls && pwd"), env, () => null).verdict, "none");
});

test("path rules: ~, //, relative-to-checkout, ** and *", () => {
  const read = (p: string): RuleCall => ({ tool: "read", paths: [p] });
  assert.equal(verdict(sets({ allow: ["Read(~/notes/**)"] }), read("/home/me/notes/a/b.md")), "allow");
  assert.equal(verdict(sets({ allow: ["Read(~/notes/*)"] }), read("/home/me/notes/a/b.md")), "none");
  assert.equal(verdict(sets({ allow: ["Read(//etc/hosts)"] }), read("/etc/hosts")), "allow");
  assert.equal(verdict(sets({ allow: ["Read(src/**)"] }), read("/co/src/a.ts")), "allow");
  assert.equal(verdict(sets({ allow: ["Read(src/**)"] }), read("/co/wt/src/a.ts")), "none", "relative patterns resolve against the main checkout");
  assert.equal(verdict(sets({ deny: ["Read(~/.ssh/**)"], allow: ["Read(~/**)"] }), read("/home/me/.ssh/id")), "deny");
  assert.equal(verdict(sets({ allow: ["Read(src/**)"] }), { tool: "read", paths: ["/co/src/a.ts", "/co/other"] }), "none", "every path must be covered");
  assert.equal(verdict(sets({ allow: ["Read(src/**)"] }), { tool: "edit", paths: ["/co/src/a.ts"] }), "none", "Read does not cover edit");
  assert.equal(verdict(sets({ allow: ["Edit(src/**)"] }), { tool: "write", paths: ["/co/src/a.ts"] }), "allow");
});

test("named tools: exact name, mcp prefix and server-wide forms, payload glob", () => {
  const call = (tool: string, payload = "{}"): RuleCall => ({ tool, payload });
  assert.equal(verdict(sets({ allow: ["intercom"] }), call("intercom")), "allow");
  assert.equal(verdict(sets({ allow: ["intercom"] }), call("intercom2")), "none");
  assert.equal(verdict(sets({ allow: ["mcp__srv__*"] }), call("mcp__srv__a")), "allow");
  assert.equal(verdict(sets({ allow: ["mcp__srv"] }), call("mcp__srv__a")), "allow");
  assert.equal(verdict(sets({ allow: ["mcp__srv"] }), call("mcp__other__a")), "none");
  assert.equal(verdict(sets({ allow: ["mcp__srv__a(*safe*)"] }), call("mcp__srv__a", '{"x":"safe"}')), "allow");
  assert.equal(verdict(sets({ allow: ["mcp__srv__a(*safe*)"] }), call("mcp__srv__a", '{"x":"bad"}')), "none");
  assert.equal(verdict(sets({ deny: ["mcp__srv"] }), call("mcp__srv__a")), "deny");
  assert.equal(verdict(sets({ allow: ["fetch(https://example.com/*)"] }), { tool: "fetch", url: "https://example.com/a" }), "allow");
  assert.equal(verdict(sets({ allow: ["fetch(https://example.com/*)"] }), { tool: "fetch", url: "https://evil.com/a" }), "none");
});

test("normaliseSegment: single spaces, quotes stripped, win32 drops .exe and case", () => {
  const [a] = parseShell("git   commit -m 'a b'");
  assert.equal(normaliseSegment(a, "linux"), "git commit -m a b");
  const [b] = parseShell("GIT.EXE status");
  assert.equal(normaliseSegment(b, "win32"), "git status");
});

test("proposeRule: program and first argument; null for opaque, exec flags, globs and leading flags", () => {
  const p = (l: string) => proposeRule(parseShell(l));
  assert.deepEqual(p("git status -s"), ["Bash(git status *)"]);
  assert.deepEqual(p("ls"), ["Bash(ls *)"]);
  assert.deepEqual(p("git status && npm test"), ["Bash(git status *)", "Bash(npm test *)"]);
  assert.deepEqual(p("git status && git status -s"), ["Bash(git status *)"]);
  for (const l of ["git -C d status", "find . -exec rm {} ;", "python -c 'x'", "echo $(id)", "ls *.ts", "ssh -o ProxyCommand=x h", "node -e 1"]) assert.equal(p(l), null, l);
  assert.equal(proposeRule([]), null);
});

test("describeCall: one sentence per name, variable parts quoted, control characters stripped, long values capped", () => {
  const d = (name: string, line?: string, input?: Record<string, unknown>) => describeCall({ name, tool: line ? "bash" : "mcp__srv__act", segments: line ? parseShell(line) : undefined, input });
  assert.match(d("danger-deploy", "kubectl apply -f x -n prod"), /Run "kubectl" "apply".*namespace "prod"/);
  assert.match(d("write-outside", "cp a /etc/b"), /outside the worktree.*"\/etc\/b"/);
  assert.match(d("danger-git", "git push origin main"), /history-changing git command "git push origin main"/);
  assert.match(d("danger-net-write", "curl -d x https://api.example.com/p"), /host "api.example.com"/);
  assert.match(d("danger-mcp-act"), /MCP tool "mcp__srv__act"/);
  assert.match(d("danger-opaque", "echo $(x)"), /cannot read exactly/);
  const nasty = d("danger-process", 'kill "a\nb\u0007"');
  assert.doesNotMatch(nasty, /[\u0000-\u001f]/);
  const long = d("danger-install", `npm install ${"x".repeat(200)}`);
  assert.ok(long.length < 200, String(long.length));
  assert.doesNotMatch(d("danger-process", 'kill "a"b'), /""/);
  assert.match(d("danger-unknown", "ls"), /Run a "unknown" call/);
});
