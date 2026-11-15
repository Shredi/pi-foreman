// redactCommand runs in linear time on every rule, and redacts exactly what it redacted before: `redactOld` below is a verbatim copy of the
// function as it was when the authorization, keyword and URL-userinfo rules were quadratic; the differential tests pin every output to it.
// In-process, no child process.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { redactCommand } from "../trace.ts";

function redactOld(cmd: string): string {
  const R = "[redacted]";
  // a run of few distinct characters ("xxxx…") is padding, not a key
  const keyish = (t: string): string => (new Set(t).size >= 6 ? R : t);
  let out = cmd
    .replace(/(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s'"]+/gi, `$1${R}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]+/gi, `Bearer ${R}`)
    .replace(/\b((?:[A-Za-z0-9_-]*(?:token|key|password|passwd|secret|pwd))\s*[=:]\s*)(?:"[^"]*"?|'[^']*'?|[^\s'"&;]+)/gi, `$1${R}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/@'"]+@/gi, `$1${R}@`)
    .replace(/((?:^|[\s;|&(])(?:-[A-Za-z]{0,8}[uU]\s{0,8}|--(?:proxy-)?user(?:\s{1,8}|=)))(?:("[^"\s:]{0,256}:)[^"]*|('[^'\s:]{0,256}:)[^']*|((?:"[^"\s:]{0,256}"|'[^'\s:]{0,256}'|[^\s:'"]{0,256}):)(?:"[^"]*"?|'[^']*'?|(?:\\.|[^\s'"\\])+))/g, (_m: string, p: string, a?: string, b?: string, c?: string) => p + (a ?? b ?? c ?? "") + R)
    .replace(/((?:^|[\s;|&(])--(?:http-|ftp-|proxy-)?password(?:\s{1,8}|=))(?:"[^"]*"?|'[^']*'?|[^\s'"]+)/g, `$1${R}`)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, R)
    .replace(/\b(?:gh[pousr]_|github_pat_|npm_|glpat-|sk-|xox[abprs]-)[A-Za-z0-9_-]{6,}/g, R)
    .replace(/\bAIza[A-Za-z0-9_-]{6,}/g, R)
    .replace(/\b[0-9a-fA-F]{24,}\b/g, keyish);
  const home = os.homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(/[A-Za-z0-9+]{24,}={0,2}/g, keyish);
}

const same = (s: string): void => {
  const old = redactOld(s);
  const now = redactCommand(s);
  assert.equal(now, old, `input ${JSON.stringify(s)}\n old ${JSON.stringify(old)}\n new ${JSON.stringify(now)}`);
};

const GROUPS: Record<string, string[]> = {
  // Keyword rule: the old `\b` admitted a start at each `-`/word-letter transition, the new lookbehind only at a run start; the replaced text must not change.
  keyword: [
    "--token=abc", "-token=abc", "x-api-key: v", "my_key=v", "a-b-key = \"v w\"", "key='v", "monkey=v", "keyboard=v", "tokens=v", "token =v", "token= v",
    "TOKEN=v", "é-key=v", "a.key=v", "a/key=v", "\"key\"=v", "key=a&pwd=b;secret=c", "key=\"a\"token=b", "key='a'-token=b", "--password=hunter2", "-secret:x",
    "a--key=v", "_key=v", "9key=v", "key==v", "key:=v", "key =", "key", "key=", "key= \"", "x_token-key=v y", "--a--b--pwd=1", "---token=1", "a-token-=v",
    "foo.passwd=1 bar-secret=2", "MyKey = 'a b' rest", "x key=v", "x\tkey=v", "(key=v)", "[token=v]", "key=v-key=w", "key-key=v key-key=w", "-key=v", "--key  :  v",
  ],
  // Authorization rule: the optional scheme now owns its trailing spaces; every form with, without, and with a scheme at the end of the input.
  authorization: [
    "authorization: bearer abc", "Authorization: Basic dXNlcjpwdw==", "authorization=token abc", "authorization:abc", "authorization :  abc", "authorization  =  bearer   abc",
    "authorization: bearer", "authorization: bearer ", "authorization: bearer  ", "authorization: bearer \"x\"", "authorization: bearer 'x'", "authorization:bearertoken",
    "authorization: bearerx y", "authorization: basic", "authorization: token", "authorization:", "authorization: ", "authorization:  \"x\"", "authorization: \"x\" bearer y",
    "AUTHORIZATION: BEARER ABC", "-H 'Authorization: Bearer abc'", "-H \"authorization: basic abc\"", "authorization: bearer\tabc", "authorization: bearer\n abc",
    "authorization authorization: x", "authorization: authorization: x", "xauthorization:y", "authorization: bearer bearer", "authorization: tokenbasic z",
  ],
  // URL userinfo rule: the scheme is now a lookbehind; the word boundary and the scheme alphabet decide, a scheme of any length is covered.
  url: [
    "https://u:p@h", "1+a://u:p@h", "a.b+c-d://u@h", "_a://u@h", "9a://u@h", "a://b@c://d@e", "git+ssh://u@h/p@q", "://u@h", "a:// u@h", "HTTPS://U:P@H", "Git+SSH://u@h",
    `${"a".repeat(300)}://u:p@h`, `${"a.".repeat(150)}://u@h`, `x${"-".repeat(200)}a://u@h`, "a://@h", "a://u", "a://u/p@h", "a://u:b://x@h", "a:///u@h", "a:////u@h",
    "-a://u@h", "+a://u@h", ".a://u@h", "a-://u@h", "a+://u@h", "é://u@h", "éa://u@h", "1://u@h", "a1://u@h", "_://u@h", "a_b://u@h", "a b://u@h", "see https://u:p@h and ftp://v@w",
    "'https://u:p@h'", "\"https://u:p@h\"", "a://u@h@i", "a://u:@h", "a://:p@h", "a://u\"v@h", "a://u'v@h", "x@y a://u@h",
  ],
  // The rules next to the changed ones: unchanged, but they read what the changed ones leave behind.
  neighbours: [
    "curl -u user:pass http://x", "wget --password hunter2 u", "bearer abcdef", "Bearer  tok.en/+=", "AKIAABCDEFGHIJKLMNOP", "ghp_abcdef123456", "AIzaSyABCDEF123456",
    "0123456789abcdef01234567", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "ABCDEFabcdefghijklmnopqrstuvwxyz0123456789+/==", "sk-abcdefgh", "npm_abcdefg", "plain text", "",
  ],
};

for (const [name, cases] of Object.entries(GROUPS)) {
  test(`redactCommand equals the previous output on the ${name} cases`, () => {
    for (const s of cases) same(s);
  });
}

test("the hand-written corpus holds at least 80 cases", () => {
  assert.ok(Object.values(GROUPS).flat().length >= 80);
});

test("redactCommand equals the previous output on a seeded random corpus of 200k strings", () => {
  // mulberry32, fixed seed: the same corpus every run
  let a = 0x1f2e3d4c;
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ALPHABET = [
    "key", "token", "password", "passwd", "secret", "pwd", "-", "-", "_", ".", "+", ":", "/", "//", "://", "@", "=", "=", " ", " ", "\t", "'", '"', "&", ";",
    "a", "b", "x", "A", "Z", "0", "9", "authorization", "bearer", "basic", "é", "https", "u", "p", "h", "\n", "(", "|",
  ];
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    let s = "";
    const parts = Math.floor(rnd() * 15);
    for (let j = 0; j < parts; j++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
    if (s.length > 40) s = s.slice(0, 40);
    same(s);
  }
});

// Linear time is a ratio, not a wall-time bound (which a loaded runner breaks): 4x the input costs about 4x, a quadratic rule about 16x.
const timeMs = (fn: (s: string) => string, input: string): number => {
  const t0 = performance.now();
  fn(input);
  return performance.now() - t0;
};

// One adversarial input per rule; the first four were quadratic. `n` is the target length.
const rep = (unit: string) => (n: number): string => unit.repeat(Math.ceil(n / unit.length));
const ADVERSARIAL: Record<string, (n: number) => string> = {
  "keyword rule, a-": rep("a-"),
  "keyword rule, token-": rep("token-"),
  "authorization + spaces": (n) => "authorization:" + " ".repeat(n),
  "authorization: bearer + spaces": (n) => "authorization: bearer" + " ".repeat(n),
  "url userinfo, a.": rep("a."),
  "url userinfo, a. before ://": (n) => "a.".repeat(n / 2) + "://u@h",
  "bearer rule": rep("bearer "),
  "bearer + spaces": (n) => "bearer" + " ".repeat(n),
  "keyword + spaces": (n) => "key" + " ".repeat(n),
  "keyword, unclosed quote": rep('key="'),
  "scheme without userinfo": rep("a://"),
  "curl -u / --password units": rep("(-u --password "),
  "AKIA run": rep("AKIA"),
  "provider prefix run": rep("sk-"),
  "hex run ending in a non-hex letter": (n) => "a".repeat(n) + "g",
  "base64 run": rep("ABCDEFabcdefghijklmnopqrstuvwxyz0123456789+"),
};

// The sizes are large enough that the small sample is well above a millisecond (2-7 ms at 200k on the shipped code), so timer
// resolution cannot inflate the ratio and no floor on the denominator is needed. Each pair is timed back to back and the statistic is the
// smallest large/small ratio over 10 pairs: a stall of a loaded machine inflates one side of a pair at a time, so a clean pair shows the
// true growth, while a function that is quadratic on the input is about 16 in every pair (a best-of-N per size failed on a loaded runner).
function ratios(fn: (s: string) => string, small: number, large: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    const s = make(small);
    const l = make(large);
    let best = Infinity;
    for (let i = 0; i < 10; i++) {
      const a = timeMs(fn, s);
      const b = timeMs(fn, l);
      best = Math.min(best, b / a);
    }
    out[name] = best;
  }
  return out;
}

test("redactCommand runs in linear time on an adversarial input per rule", () => {
  const [small, large] = [200_000, 800_000];
  for (const [name, ratio] of Object.entries(ratios(redactCommand, small, large))) {
    assert.ok(ratio < 8, `${name}: ${small / 1000}k to ${large / 1000}k ratio ${ratio.toFixed(1)}`);
  }
});

// Not a test of the shipped code: the ratio check above would flag the previous function. Run on demand with FOREMAN_RATIO_OLD=1; the old
// function is quadratic on these inputs, so the smaller sizes (5k vs 20k) already show a ratio near 16 in well under a minute.
test("the ratio check flags the previous function", { skip: process.env.FOREMAN_RATIO_OLD !== "1" }, () => {
  const r = ratios(redactOld, 5_000, 20_000);
  console.log(JSON.stringify(r));
  assert.ok(Object.values(r).some((v) => v >= 8));
});
