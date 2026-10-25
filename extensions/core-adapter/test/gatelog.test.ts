import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeShape, openGateLog, gateLogFile, GATE_LOG_MAX_BYTES } from "../gatelog.ts";

const posix = { worktree: "/w/repo", scratch: "/s/scr", tmp: "/t", home: "/h/me", parent: "/w/main" };
const win = { worktree: "C:\\w\\repo", scratch: "C:\\s\\scr", tmp: "C:\\t", home: "C:\\Users\\me", parent: "C:\\w\\main" };

const tmpAgent = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "gatelog-"));
const lines = (f: string): Record<string, unknown>[] => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("normalizeShape: path classes on POSIX separators", () => {
  assert.equal(normalizeShape("cat /w/repo/src/a.ts /s/scr/x /t/y /h/me/.ssh/id /w/main/.workflow/L.md /etc/passwd src/b", posix), "cat <worktree>/... <scratch>/... <tmp>/... <home>/... <parent>/.workflow/... <abs> <rel>");
  assert.equal(normalizeShape("ls ~/x ~", posix), "ls <home>/... <home>/...");
});

test("normalizeShape: path classes on Windows separators", () => {
  assert.equal(normalizeShape("type C:\\w\\repo\\src\\a.ts c:\\S\\scr\\x C:\\t\\y C:\\Users\\me\\.ssh\\id C:\\w\\main\\.workflow\\L.md D:\\other src\\b", win), "type <worktree>/... <scratch>/... <tmp>/... <home>/... <parent>/.workflow/... <abs> <rel>");
  assert.equal(normalizeShape("cat C:/w/repo/a", win), "cat <worktree>/...");
});

test("normalizeShape: a sibling with a shared prefix is not below the root", () => {
  assert.equal(normalizeShape("cat /w/repo2/a", posix), "cat <abs>");
});

test("normalizeShape: URLs keep scheme and host only", () => {
  assert.equal(normalizeShape("curl -s https://example.com/a/b?q=1", posix), "curl -s https://example.com");
  assert.ok(!/pw|8080/.test(normalizeShape("curl http://u:pw@host.io:8080/x")));
  assert.ok(!normalizeShape("curl https://example.com/private/path?token=abc").includes("private"));
});

test("normalizeShape: quoted strings and secret values become <v>, options stay", () => {
  assert.equal(normalizeShape(`git commit -m "fix the thing" --author='A B'`), "git commit -m <v> --author=<v>");
  const s = normalizeShape("curl -H 'Authorization: Bearer abc123' --out=/h/x PASSWORD=hunter2 ghp_abcdefghijkl", posix);
  assert.ok(!/abc123|hunter2|ghp_/.test(s), s);
  assert.ok(s.includes("--out=<abs>"), s);
});

test("record: fields, redaction and no raw value in the file", () => {
  const agent = tmpAgent();
  const log = openGateLog({ agentDir: agent, session: "s1", kind: "child", role: "builder", cwd: "/w/repo/secret-dir", roots: posix, now: () => new Date("2026-01-02T03:04:05Z") });
  log.record({ tool: "bash", layer: "default", verdict: "allow", rule: "r.1", reason: "matched rule '/w/repo/x' for token=SECRETVALUE12345", input: `cat /w/repo/private-name.txt "quoted secret" API_TOKEN=sk-abcdefghijk1234 https://evil.example/leak/path` });
  const file = gateLogFile(agent);
  assert.equal(log.file, file);
  assert.equal(file, path.join(agent, "pi-foreman", "state", "gate", "log.jsonl"));
  const [r] = lines(file);
  assert.deepEqual(Object.keys(r), ["ts", "session", "kind", "role", "tool", "layer", "verdict", "rule", "reason", "shape", "cwdHash"]);
  assert.equal(r.ts, "2026-01-02T03:04:05.000Z");
  assert.equal(r.kind, "child");
  assert.equal(r.layer, "default");
  assert.match(String(r.cwdHash), /^[0-9a-f]{12}$/);
  const raw = fs.readFileSync(file, "utf8");
  for (const leak of ["private-name", "quoted secret", "SECRETVALUE12345", "sk-abcdefghijk1234", "/leak/path", "secret-dir"]) assert.ok(!raw.includes(leak), leak);
  assert.ok(String(r.shape).startsWith("cat <worktree>/... <v>"));
  fs.rmSync(agent, { recursive: true, force: true });
});

test("cap: rotation to log.1.jsonl keeps one generation", () => {
  const agent = tmpAgent();
  const log = openGateLog({ agentDir: agent, session: "s", kind: "owner", maxBytes: 600 });
  for (let i = 0; i < 40; i++) log.record({ tool: "bash", layer: "floor", verdict: "deny", input: `echo ${i}` });
  const dir = path.dirname(log.file);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["log.1.jsonl", "log.jsonl"]);
  assert.ok(fs.statSync(log.file).size <= 600);
  assert.ok(fs.statSync(path.join(dir, "log.1.jsonl")).size <= 600);
  assert.equal(lines(log.file).at(-1)?.verdict, "deny");
  fs.rmSync(agent, { recursive: true, force: true });
});

test("default cap is 20 MB and a bad maxBytes falls back to it", () => {
  assert.equal(GATE_LOG_MAX_BYTES, 20 * 1024 * 1024);
  const agent = tmpAgent();
  const log = openGateLog({ agentDir: agent, session: "s", kind: "owner", maxBytes: "x" });
  for (let i = 0; i < 5; i++) log.record({ tool: "read", layer: "cache", verdict: "allow" });
  assert.equal(lines(log.file).length, 5);
  fs.rmSync(agent, { recursive: true, force: true });
});

test("a write failure never throws into the caller", () => {
  const agent = tmpAgent();
  fs.writeFileSync(path.join(agent, "pi-foreman"), "a file, not a directory");
  const log = openGateLog({ agentDir: agent, session: "s", kind: "owner" });
  assert.doesNotThrow(() => log.record({ tool: "bash", layer: "floor", verdict: "deny", input: "x" }));
  assert.doesNotThrow(() => log.record({ tool: "bash", layer: "floor", verdict: "deny", reason: { bad: 1 } as never, input: 5 as never }));
  fs.rmSync(agent, { recursive: true, force: true });
});

// ---- review fixes: the shape never keeps a raw credential
const cases: Array<[string, string, string]> = [
  ["curl -u admin:Hunter2pw https://h.io/x", "Hunter2pw", "curl -u <v> https://h.io"],
  ["curl -uadmin:Hunter2pw https://h.io", "Hunter2pw", "curl -u<v> https://h.io"],
  ["curl --user admin:Hunter2pw https://h.io", "Hunter2pw", "curl --user <v> https://h.io"],
  ["curl --user=admin:Hunter2pw https://h.io", "Hunter2pw", "curl --user=<v> https://h.io"],
  ["mysql -pHunter2pw -u root", "Hunter2pw", "mysql -p<v> -u <v>"],
  ["tool --password Hunter2pw run", "Hunter2pw", "tool --password <v> run"],
  ["tool --password=Hunter2pw run", "Hunter2pw", "tool --password=<v> run"],
  ["sshpass -p Hunter2pw ssh host", "Hunter2pw", "sshpass -p <v> ssh host"],
  ["aws --secret-access-key Hunter2pw s3 ls", "Hunter2pw", "aws --secret-access-key <v> s3 ls"],
  ["tool --token Hunter2pw", "Hunter2pw", "tool --token <v>"],
  ["tool --api-key Hunter2pw", "Hunter2pw", "tool --api-key <v>"],
  ["curl -H Authorization:Hunter2pw https://h.io", "Hunter2pw", "curl -H <v> https://h.io"],
  [`curl -H "Authorization: Basic Hunter2pw" https://h.io`, "Hunter2pw", "curl -H <v> https://h.io"],
  ["curl --header X-Thing:Hunter2pw https://h.io", "Hunter2pw", "curl --header <v> https://h.io"],
  ["PASSWORD=Hunter2pw run.sh", "Hunter2pw", "PASSWORD=<v> <rel>"],
  ["export DB_PASS=Hunter2pw", "Hunter2pw", "export DB_PASS=<v>"],
  ["MY_COOKIE=Hunter2pw run", "Hunter2pw", "MY_COOKIE=<v> run"],
  ["curl https://admin:Hunter2pw@h.io/x", "Hunter2pw", "curl https://h.io"],
  ["echo Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8", "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8", "echo <v>"],
  ["cat <<EOF\nHunter2pw\nEOF", "Hunter2pw", "cat <<EOF\n<heredoc>"],
  ["cat <<'EOF' > out.txt\nHunter2pw\nline2\nEOF\nls", "Hunter2pw", "cat <<EOF > <rel>\n<heredoc>\nls"],
  ["cat <<-EOF\n\tHunter2pw\n\tEOF", "Hunter2pw", "cat <<-EOF\n<heredoc>"],
  ["cat <<< Hunter2pw", "Hunter2pw", "cat <<< <heredoc>"],
  [`cat <<< "Hunter2 pw"`, "Hunter2 pw", "cat <<< <heredoc>"],
];

test("shape: each credential position becomes <v> or <heredoc>", () => {
  for (const [input, secret, want] of cases) {
    const s = normalizeShape(input, posix);
    assert.ok(!s.includes(secret), `${input} -> ${s}`);
    assert.equal(s, want, input);
  }
});

const passwordCases: Array<[string, string, string]> = [
  ["mysql -ppw", "pw", "mysql -p<v>"],
  ["mysql -u root -ppw", "pw", "mysql -u <v> -p<v>"],
  ["mysql -h db -P 3306 -u root -pS3cret dbname", "S3cret", "mysql -h db -P 3306 -u <v> -p<v> dbname"],
  ["docker login -p pw2", "pw2", "docker login -p <v>"],
  ["docker login -u me -p pw2 registry.example", "pw2", "docker login -u me -p <v> <rel>"], // a dotted host reads as a file name; the operand is kept as its class, not masked as a password
  ["podman login -ppw2 reg.io", "pw2", "podman login -p<v> <rel>"],
  ["mariadb -ppw db", "pw", "mariadb -p<v> db"],
  ["mysqldump -ppw db", "pw", "mysqldump -p<v> db"],
  ["mysqladmin -ppw status", "pw", "mysqladmin -p<v> status"],
  ["sshpass -ppw ssh host", "pw", "sshpass -p<v> ssh host"],
  ["othertool --user me -ppw", "pw", "othertool --user <v> -p<v>"],
  ["tool -p pw run", "pw", "tool -p <v> run"],
  ["tool --password pw run", "pw", "tool --password <v> run"],
  ["tool --password=pw run", "pw", "tool --password=<v> run"],
  ["helm registry login -p pw reg.io", "pw", "helm registry login -p <v> <rel>"],
  ["npm login --token pw", "pw", "npm login --token <v>"],
  ["gh auth login --token pw", "pw", "gh auth login --token <v>"],
  ["az login --password pw", "pw", "az login --password <v>"],
  ["aws configure set aws_secret_access_key pw", "pw", "aws configure set aws_secret_access_key <v>"],
  ["docker login --secret pw reg.io", "pw", "docker login --secret <v> <rel>"],
];

test("shape: password operands are masked whatever their length", () => {
  for (const [input, secret, want] of passwordCases) {
    const s = normalizeShape(input, posix);
    assert.equal(s, want, input);
    assert.ok(!s.split(/[\s=]/).some((w) => w.replace(/^-p/, "") === secret), input);
  }
});

test("shape: no-operand credential flags keep the next word", () => {
  assert.equal(normalizeShape("docker login --password-stdin reg.io", posix), "docker login --password-stdin <rel>");
  assert.equal(normalizeShape("gh auth login --with-token < tok.txt", posix), "gh auth login --with-token < <rel>");
});

test("shape: psql -p masks the port (chosen behaviour: harmless)", () => {
  assert.equal(normalizeShape("psql -p 5432", posix), "psql -p <v>");
});

test("shape: ordinary flags and operands survive the credential rules", () => {
  assert.equal(normalizeShape("mkdir -p dir && ls -ltr", posix), "mkdir -p dir && ls -ltr");
  assert.equal(normalizeShape("cp -pr a.txt b.txt", posix), "cp -pr <rel> <rel>");
  assert.equal(normalizeShape("sort -u list.txt | uniq", posix), "sort -u <rel> | uniq");
  assert.equal(normalizeShape("git log --oneline -n 5", posix), "git log --oneline -n 5");
});

test("record: the serialised log line never contains a planted secret, in any position", () => {
  const agent = tmpAgent();
  const log = openGateLog({ agentDir: agent, session: "s", kind: "owner", roots: posix });
  for (const [input] of cases) log.record({ tool: "bash", layer: "default", verdict: "allow", input });
  const raw = fs.readFileSync(log.file, "utf8");
  for (const [, secret] of cases) assert.ok(!raw.includes(secret), secret);
  assert.equal(raw.trim().split("\n").length, cases.length);
  fs.rmSync(agent, { recursive: true, force: true });
});
