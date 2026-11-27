// D211: file text sent to the judge hides only real key shapes (known token prefixes, PEM private-key blocks, the literal value of a secret-named key);
// code, long identifiers and hashes pass. Trace and command masking (redactCommand) is unchanged.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_READ_BUDGET, judgeReadScope, maskKeys, readPaths } from "../judgereads.ts";
import type { JudgeReadScope } from "../judgereads.ts";
import { redactCommand } from "../trace.ts";

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "judge-key-mask-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wt = path.join(tmp, "proj");
fs.mkdirSync(wt, { recursive: true });
const S = judgeReadScope({ cwd: wt, worktree: wt, agentDir: path.join(tmp, "agent"), home: tmp, config: {} }) as JudgeReadScope;
const shown = (name: string, text: string): string => {
  fs.writeFileSync(path.join(wt, name), text);
  return readPaths([name], S, { left: MAX_READ_BUDGET }).blocks[0].body;
};

test("ordinary code passes: a 25-char camelCase name, `key=lambda`, `token = get_token()`, a git sha, a long path-like identifier", () => {
  const lines = [
    "const thisIsALongCamelCaseName1 = 1;",
    "sorted(rows, key=lambda r: r[0])",
    "token = get_token()",
    "const token = parseToken1234(req);",
    "let token: string;",
    "commit da39a3ee5e6b4b0d3255bfef95601890afd80709",
    "import { aVeryLongModuleIdentifierName } from './x';",
    "password = os.environ['PASSWORD']",
    "auth = None",
    "author = Marc",
  ];
  const body = shown("code.txt", `${lines.join("\n")}\n`);
  for (const l of lines) assert.ok(body.includes(l), `${l}\n${body}`);
  assert.ok(!body.includes("[redacted]"));
});

test("real key shapes are masked: token prefixes, a PEM block, secret-named literals", () => {
  const secrets = ["ghp_abcdefghij1234567890", "github_pat_11ABCDEFG0abcdefghijklmn", "sk-abcdefghijklmnopqrstuvwx", "AKIAABCDEFGHIJKLMNOP", "AIzaSyA-abcdefghijklmnop", "glpat-abcdefghij1234567890", "xoxb-1234-abcdefghij"];
  const text = [
    ...secrets.map((s, i) => `k${i} = ${s}`),
    'password = "hunter2hunter2"',
    "API_TOKEN=abcd1234efgh5678",
    '{"api_key": "abcdefgh"}',
    '{\\"secret\\":\\"abcdefgh\\"}',
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEowIBAAKCAQEAyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
    "-----END RSA PRIVATE KEY-----",
    "after the block",
  ].join("\n");
  const body = shown("keys.txt", `${text}\n`);
  for (const s of [...secrets, "hunter2hunter2", "abcd1234efgh5678", "abcdefgh", "MIIEow"]) assert.ok(!body.includes(s), `${s}\n${body}`);
  assert.ok(body.includes("password = [redacted]") && body.includes("API_TOKEN=[redacted]"), body);
  assert.ok(body.includes("after the block"));
});

test("a PEM block keeps its line count, so a window and the more-hint stay true; an unterminated block is masked to the end", () => {
  const masked = maskKeys("a\n-----BEGIN PRIVATE KEY-----\nxx\nyy\n-----END PRIVATE KEY-----\nb\n");
  assert.equal(masked.split("\n").length, 7);
  assert.ok(masked.startsWith("a\n[redacted]") && masked.endsWith("\nb\n"));
  assert.ok(!maskKeys("a\n-----BEGIN OPENSSH PRIVATE KEY-----\nxx\nyy").includes("xx"));
});

test("a long run is no key by its length: a 40-char identifier and a 64-hex hash are shown, a [redacted] mark appears only for a key", () => {
  const hash = "a".repeat(10) + "0123456789abcdef".repeat(3) + "b".repeat(6);
  const ident = "someVeryLongFunctionNameThatKeepsGoing12345";
  const body = shown("long.txt", `${hash}\n${ident}\n`);
  assert.ok(body.includes(hash) && body.includes(ident));
});

test("trace and command masking is unchanged: a long run is still masked there", () => {
  assert.equal(redactCommand("echo thisIsALongCamelCaseName1"), "echo [redacted]");
});
