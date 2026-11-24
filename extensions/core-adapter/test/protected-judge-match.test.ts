// The remote class table (A), the ssh stdin rules (B) and the redirect classes (item 2) of matchProtected; neutral fixtures (prod-db, vendorctl).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { toChain } from "../defaults.ts";
import { effectCtx, segmentEffect } from "../effects.ts";
import { acceptProtected, effectiveCheckMode, matchProtected, remoteReasonClass } from "../protected.ts";
import type { ProtectedMatch, ProtectedVerdict } from "../protected.ts";
import type { ProtectedEntry } from "../permconfig.ts";
import type { OpaqueReason } from "../shellast.ts";
import { parseShell } from "../shellast.ts";
import type { RuleCall } from "../rulecall.ts";

const cwd = process.cwd();
const home = path.join(cwd, "pf-prot-judge", "home");
const env = { home, platform: process.platform, checkout: cwd, cwd, ec: effectCtx(cwd) };
const entries: ProtectedEntry[] = [{ id: "P1", kind: "host", glob: "prod-db", note: "production", source: "user" }];

const sh = (line: string): ProtectedMatch => {
  const segments = parseShell(line, { cwd });
  const m = matchProtected({ tool: "bash", segments: segments.map((s) => ({ text: line, opaque: s.opaque !== null, writesRedirect: false })) } as RuleCall, segments, entries, env);
  assert.ok(m, `matched: ${line}`);
  return m;
};
const ssh = (remote: string): ProtectedMatch => sh(`ssh prod-db '${remote}'`);
const READ: ProtectedVerdict = { verdict: "allow", effect: "read", confidence: "high", entry: null };
const accept = (m: ProtectedMatch, v: ProtectedVerdict = READ, mode: "model" | "read-only" | "ask" = "model", away = true): string =>
  acceptProtected(v, { classes: m.classes, remoteClasses: m.remoteClasses, opaque: m.opaque, remoteOpaque: m.remoteOpaque, away, mode, denyEntryExists: false });

test("the three reported shapes pass on a read verdict", () => {
  for (const line of [
    `ssh prod-db 'vendorctl history --since 1h | grep -i reject | cut -d" " -f1-3'`,
    `ssh prod-db 'ls -l /var/log/a /var/log/b 2>/dev/null'`,
    `ssh prod-db 'set -u; for p in a b; do echo "$p"; done'`,
  ]) {
    const m = sh(line);
    assert.equal(m.remoteOpaque, false, line);
    assert.equal(accept(m), "allow", line);
  }
});

test("table A: read, write and unknown program rows", () => {
  assert.deepEqual(ssh("ls").remoteClasses, ["read"]);
  assert.deepEqual(ssh("vendorctl status").remoteClasses, ["unknown"]);
  assert.equal(accept(ssh("vendorctl status")), "allow");
  assert.equal(accept(ssh("ls")), "allow");
});

test("table A: an output redirect to a file is write-out and asks; /dev/null and an fd dup are not writes", () => {
  for (const r of ["> /tmp/o", ">> /tmp/o", "&> /tmp/o", "&>> /tmp/o", "<> /tmp/o", ">| /tmp/o", '> "$LOG"', "> /dev/nul", "> /etc/app.conf"]) {
    const m = ssh(`vendorctl status ${r}`);
    assert.ok(m.remoteClasses.includes("write-out"), r);
    assert.equal(accept(m), "ask", r);
  }
  for (const r of ["2>/dev/null", ">/dev/null", "2>&1", "&>/dev/null", ">&2", "2>&-", ">&-", "3<&-"]) {
    const m = ssh(`ls ${r}`);
    assert.deepEqual(m.remoteClasses, ["read"], r);
    assert.equal(accept(m), "allow", r);
  }
});

test("table A: a redirect on an opaque segment is checked too", () => {
  const m = ssh('for q in a b; do echo "$q"; done > /tmp/o');
  assert.ok(m.remoteClasses.includes("write-out"));
  assert.equal(accept(m), "ask");
});

test("table A: writing_wrapper (tee) is write-out", () => {
  const m = ssh("vendorctl status | tee /tmp/o");
  assert.ok(m.remoteClasses.includes("write-out"));
  assert.equal(accept(m), "ask");
  assert.equal(remoteReasonClass("writing_wrapper"), "write-out");
});

test("table A: loop, variable, glob, eval, source, zsh -c are unknown and judged", () => {
  for (const r of ['for q in a b; do echo "$q"; done', 'echo "$HOME"', "ls /var/log/*.log", 'eval "$X"', "source /opt/x.sh", 'zsh -c "$X"']) {
    const m = ssh(r);
    assert.equal(m.remoteOpaque, false, r);
    assert.ok(m.remoteClasses.includes("unknown"), r);
    assert.equal(accept(m), "allow", r);
  }
});

test("table A: stdin_fed, a parse error and an empty remote command are remote opaque and refused", () => {
  for (const line of ["ssh prod-db bash -s <<'X'\nvendorctl status\nX", "ssh prod-db 'echo \"unterminated'", "ssh prod-db 'if then fi((('"]) {
    const m = sh(line);
    assert.equal(m.remoteOpaque, true, line);
    assert.equal(accept(m), "refuse", line);
  }
  const bare = sh("ssh prod-db");
  assert.equal(bare.remoteOpaque, true);
  assert.equal(accept(bare), "refuse");
});

test("table A: the switch maps every parser reason, and a reason outside the list is remote opaque", () => {
  const judged: OpaqueReason[] = ["unresolved_var", "glob_target", "process_substitution", "nonliteral_script", "function_def", "shell_builtin", "assignment", "xargs_stdin", "wrapper_option", "unsupported", "foreign_shell"];
  for (const r of judged) assert.equal(remoteReasonClass(r), "unknown", r);
  assert.equal(remoteReasonClass("stdin_fed"), "opaque");
  assert.equal(remoteReasonClass("parse_error"), "opaque");
  assert.equal(remoteReasonClass("depth"), "opaque");
  assert.equal(remoteReasonClass("some_future_reason" as OpaqueReason), "opaque");
});

test("table A: nesting deeper than the walker limit is remote opaque and refused; at the limit the write is seen", () => {
  const deep = ssh("echo $(echo $(echo $(echo $(echo $(echo a > /etc/f)))))");
  assert.equal(deep.remoteOpaque, true);
  assert.equal(accept(deep), "refuse");
  const four = ssh("echo $(echo $(echo $(echo $(echo a > /etc/f))))");
  assert.ok(four.remoteClasses.includes("write-out"));
  assert.equal(accept(four), "ask");
});

test("table A: a construct whose body the parser does not walk is remote opaque and refused, a redirect inside it included", () => {
  for (const r of ["for ((i=0;i<1;i++)); do echo a > /etc/f; done", "select x in a; do echo a > /etc/f; done", "coproc echo a > /etc/f"]) {
    const m = ssh(r);
    assert.equal(m.remoteOpaque, true, r);
    assert.equal(accept(m), "refuse", r);
  }
});

test("table A: unsupported stays judged for a runner only; [[ and (( are remote opaque and refused", () => {
  for (const r of ["sudo journalctl -n 5"]) {
    const m = ssh(r);
    assert.equal(m.remoteOpaque, false, r);
    assert.ok(m.remoteClasses.includes("unknown"), r);
    assert.equal(accept(m), "allow", r);
  }
  for (const r of ["[[ -f /etc/app.conf ]] && cat /etc/app.conf", "[[ -n $(rm /etc/f) ]]", "(( $(touch /etc/f) ))", "[[ `touch /etc/f` ]]", "if [[ -n $(cp a /etc/f) ]]; then ls; fi"]) {
    const m = ssh(r);
    assert.equal(m.remoteOpaque, true, r);
    assert.equal(accept(m), "refuse", r);
  }
});

test("B: transport opacity is still refused", () => {
  for (const line of [
    "ssh prod-db",
    "ssh -o ProxyCommand='nc %h 22' prod-db true",
    "ssh -F cfg prod-db true",
    "cat s.sh | ssh prod-db bash",
    "ssh prod-db bash < s.sh",
    "ssh prod-db bash <> s.sh",
    "ssh prod-db bash -s <<'X'\nvendorctl status\nX",
    "ssh prod-db bash <<X\n$(cat s.sh)\nX",
    'ssh prod-db python3 <<< "$(cat s.py)"',
    "cat s.sh | ssh -inkey prod-db bash",
    "ssh prod-db bash 3<s.sh 0<&3",
    "ssh prod-db bash 3<s.sh 0>&3",
    "ssh prod-db bash <&3",
    "ssh prod-db bash < /dev/null <&3",
  ]) {
    const m = sh(line);
    assert.equal(m.remoteOpaque, true, line);
    assert.equal(accept(m), "refuse", line);
  }
});

test("B: empty input, ssh -n and fd redirects of other fds are not transport opaque", () => {
  for (const line of ["ssh prod-db uptime < /dev/null", "cat f | ssh -n prod-db uptime", "ssh prod-db uptime 2>&1", "cat s | ssh prod-db uptime < /dev/null", "ssh prod-db uptime 3<s.sh"]) {
    const m = sh(line);
    assert.equal(m.remoteOpaque, false, line);
    assert.equal(accept(m), "allow", line);
  }
});

test("item 2: the null and dup redirects are no writes locally, a file redirect is write-out", () => {
  const ec = effectCtx(cwd);
  const cls = (line: string): string => {
    const chain = toChain(parseShell(line, { cwd })[0]);
    assert.ok(chain, line);
    return segmentEffect(ec, cwd, chain).cls;
  };
  for (const r of ["2>/dev/null", ">/dev/null", "2>&1", "&>/dev/null", ">&2", "2>&-", ">&-", "3<&-"]) assert.equal(cls(`ls ${r}`), "read", r);
  assert.equal(cls("ls > out.txt"), "write-out");
});

test("D: the effective mode is the strictest of the global mode and every matched entry", () => {
  assert.equal(effectiveCheckMode("model", []), "model");
  assert.equal(effectiveCheckMode("model", [{}, { check: "read-only" }]), "read-only");
  assert.equal(effectiveCheckMode("model", [{ check: "read-only" }, { check: "ask" }]), "ask");
  assert.equal(effectiveCheckMode("read-only", [{ check: "model" }]), "read-only");
  assert.equal(effectiveCheckMode("ask", [{ check: "model" }]), "ask");
});
