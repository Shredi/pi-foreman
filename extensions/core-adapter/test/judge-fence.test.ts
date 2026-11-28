// A stray code fence around the judge's JSON answer (only a leading or only a trailing line) is tolerated; prose or a second object is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJudgeVerdict, parseProtectedVerdict } from "../classifier.ts";

const CLEAR = JSON.stringify({ verdict: "clear", reason: "because" });
const OWNER = JSON.stringify({ verdict: "owner", reason: "because", class: "outbound" });
const READ = JSON.stringify({ verdict: "read", paths: ["a.txt"], reason: "because" });
const PROT = JSON.stringify({ verdict: "allow", effect: "read", confidence: "high", entry: null, reason: "because" });

const wraps: [string, (j: string) => string][] = [
  ["trailing fence only", (j) => `${j}\n\`\`\``],
  ["leading fence only", (j) => `\`\`\`\n${j}`],
  ["both fences", (j) => `\`\`\`\n${j}\n\`\`\``],
  ["json tag, leading only", (j) => `\`\`\`json\n${j}`],
  ["json tag, both", (j) => `\`\`\`json\n${j}\n\`\`\``],
  ["CRLF, both", (j) => `\`\`\`json\r\n${j}\r\n\`\`\`\r\n`],
  ["CRLF, trailing only", (j) => `  ${j}\r\n\`\`\`  \r\n`],
  ["CRLF, leading only", (j) => `\r\n\`\`\`JSON\r\n${j}\r\n`],
];

for (const [name, wrap] of wraps) {
  test(`fence: ${name}: clear, owner and read verdicts parse`, () => {
    assert.deepEqual(parseJudgeVerdict(wrap(CLEAR)), { verdict: "clear", reason: "because" });
    const owner = parseJudgeVerdict(wrap(OWNER));
    assert.ok(!("error" in owner) && owner.verdict === "owner" && owner.class === "outbound");
    assert.deepEqual(parseJudgeVerdict(wrap(READ), "read"), { verdict: "read", paths: ["a.txt"], reason: "because" });
  });
}

test("fence: protected verdict parses with a stray fence", () => {
  for (const [, wrap] of wraps) {
    const r = parseProtectedVerdict(wrap(PROT), []);
    assert.ok(!("error" in r) && r.verdict === "allow", wrap(PROT));
  }
});

// remote-asks D5: prose BEFORE a trailing verdict object is read now (the "reply is not JSON" cause); text after the block, two objects and a fence in the middle stay invalid
test("fence: prose before a trailing verdict object is read, with or without a closing fence", () => {
  for (const ok of [`Here you go: ${CLEAR}`, `Here you go:\n${CLEAR}\n\`\`\``]) {
    const j = parseJudgeVerdict(ok);
    assert.ok(!("error" in j), ok);
    assert.ok(!("error" in parseProtectedVerdict(ok.replace(CLEAR, PROT), [])), ok);
  }
});

test("fence: a fence in the middle, two objects and prose after a fence stay invalid", () => {
  const bad = [
    `\`\`\`\n${CLEAR}\n\`\`\`\nthanks`,
    `${CLEAR}\n\`\`\`\nthanks`,
    `${CLEAR}\n\`\`\`\n${CLEAR}`,
    `\`\`\`\n${CLEAR}\n\`\`\`\n${CLEAR}`,
    `${CLEAR}\n${CLEAR}`,
    `\`\`\`json\n${CLEAR.replace("}", ',"extra":1}')}\n\`\`\``,
    `\`\`\`\n${CLEAR.replace("clear", "maybe")}`,
  ];
  for (const b of bad) {
    assert.ok("error" in parseJudgeVerdict(b), b);
    assert.ok("error" in parseProtectedVerdict(b, []), b);
  }
});
