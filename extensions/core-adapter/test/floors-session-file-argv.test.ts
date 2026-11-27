// A Pi session file named as an argument of a program that is no known writer (`node s.mjs <session.jsonl>`, `python3 s.py <session.jsonl>`) goes to the judge
// as a held hit; every other deny of the line still wins. A known writer, a redirect and a policy file keep the floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineFloors, type FloorEnv } from "../floors.ts";
import { parseShell } from "../shellast.ts";

const env: FloorEnv = { cwd: "/w/repo", home: "/h/me", agentDir: "/h/me/.pi/agent", writeRoots: ["/w/repo", "/s/scr", "/tmp"], protectedBranches: ["release"], currentBranch: () => "feature/x", remoteHead: () => "trunk" };
const kid: FloorEnv = { ...env, child: true };
const shape = (line: string, e: FloorEnv): string | null => {
  const h = lineFloors(line, parseShell(line, { cwd: e.cwd }), e);
  return h ? `${h.kind}/${h.rule}` : null;
};

const S = "/h/me/.pi/agent/sessions/--w--/2026-01-01T00-00-00_abc.jsonl";

test("both photo forms reach the judge, main and child", () => {
  for (const l of [`node s.mjs ${S}`, `python3 s.py ${S}`, `python3 s.py ${S} | head -3`, `ruby s.rb ${S}`]) for (const e of [env, kid]) assert.equal(shape(l, e), "judge/danger-policy-file", `${e.child ? "child" : "main"}: ${l}`);
});

test("the writes keep the floor: redirect, tee, cp, sed -i, mv, rm", () => {
  for (const l of [`echo x > ${S}`, `echo x >> ${S}`, `node s.mjs > ${S}`, `echo x | tee ${S}`, `cp x ${S}`, `sed -i s/a/b/ ${S}`, `mv x ${S}`, `rm ${S}`, `rsync x ${S}`]) for (const e of [env, kid]) assert.equal(shape(l, e), "deny/floor-policy-file", `${e.child ? "child" : "main"}: ${l}`);
});

test("a policy or state file named as an argument stays refused", () => {
  for (const l of [`node s.mjs /h/me/.pi/agent/pi-foreman/permissions.json`, `python3 s.py /h/me/.pi/agent/pi-foreman/state/gate/log.jsonl`, `node s.mjs ${S} /h/me/.pi/agent/pi-foreman/permissions.json`]) for (const e of [env, kid]) assert.equal(shape(l, e), "deny/floor-policy-file", `${e.child ? "child" : "main"}: ${l}`);
});

test("combined lines: a later deny of the segment or the line wins over the held hit", () => {
  for (const l of [`python3 s.py ${S} ~/.ssh/id_rsa`, `node s.mjs ${S} ~/.pi/agent/pi-foreman/permissions.json`, `python3 s.py ~/.ssh/id_rsa ${S}`, `node s.mjs ${S}; rm -rf /`, `node s.mjs ${S} && git push --force origin main`]) {
    for (const e of [env, kid]) assert.match(shape(l, e) ?? "", /^deny\//, `${e.child ? "child" : "main"}: ${l}`);
  }
  assert.equal(shape(`python3 s.py ${S} ~/.ssh/id_rsa`, env), "deny/floor-secret-path");
  assert.equal(shape(`node s.mjs ${S} /h/me/.pi/agent/pi-foreman/permissions.json`, env), "deny/floor-policy-file");
});

test("clean reads of a session file stay free", () => {
  for (const l of [`cat ${S}`, `grep x ${S}`, `tail -n 3 ${S}`]) for (const e of [env, kid]) assert.equal(shape(l, e), null, l);
});
