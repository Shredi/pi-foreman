// R31c R6: an orchestrator may write plan.md, result.md, update*.md, ask*.md of its own handoff dir (child role) by one exact heredoc, although the body
// says "ruling"; every other shape keeps the self-ruling ask. R2.1: the child `npm ci` ask text names the bare form.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTestTmp } from "./_tmpbase.ts";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";
import { ownHandoffHeredoc, selfRulingAsk } from "../ruling.ts";

const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pf-r31c-hd-")));
after(() => rmTestTmp(w));
const own = path.join(w, "handoffs", "own-run");
const other = path.join(w, "handoffs", "other-run");
for (const d of [own, other]) fs.mkdirSync(d, { recursive: true });
fs.symlinkSync(path.join(other, "plan.md"), path.join(own, "ask-link.md"));
fs.writeFileSync(path.join(other, "target.md"), "x\n");
fs.linkSync(path.join(other, "target.md"), path.join(own, "update-hard.md"));
fs.symlinkSync(own, path.join(w, "handoffs", "alias"));
fs.writeFileSync(path.join(own, "plan.md"), "old\n");

const posix = process.platform !== "win32";
const body = "line\nthe ruling is mine\nEOF";
const ask = (command: string, tool = "bash", orchestrator = true, dirs = [own]): boolean => selfRulingAsk(tool, { command }, dirs, { cwd: w, orchestrator }) !== undefined;
const hd = (t: string, op = ">"): string => `cat ${op} ${t} <<'EOF'\n${body}\n`;

test("R6.1 exact heredocs into child-role names pass for an orchestrator", { skip: !posix }, () => {
  for (const name of ["plan.md", "result.md", "update.md", "update-2.md", "ask.md", "ask_q1.md"]) {
    assert.equal(ask(hd(`${own}/${name}`)), false, name);
  }
  assert.equal(ask(hd(`${own}/plan.md`, ">>")), false);
  assert.equal(ask(`cat <<'EOF' > ${own}/result.md\n${body}`), false);
  assert.equal(ask(`cat <<'EOF' >> ${own}/result.md\n${body}\n`), false);
  assert.equal(ask(hd(`handoffs/own-run/plan.md`)), false);
  assert.equal(ask(hd(`${own}/plan.md`), "foreman_bg"), false);
  // the parent role needs no lift: a dir where the session is the parent is not in childDirs
  assert.equal(ask(hd(`${other}/ruling.md`)), false);
});

test("R6.2 the base asks (no lift, a child session, powershell)", { skip: !posix }, () => {
  assert.equal(selfRulingAsk("bash", { command: hd(`${own}/plan.md`) }, [own]) !== undefined, true);
  assert.equal(ask(hd(`${own}/plan.md`), "bash", false), true);
  assert.equal(ask(hd(`${own}/plan.md`), "powershell"), true);
});

test("R6.3 names, paths and roles outside the grammar still ask", { skip: !posix }, () => {
  for (const t of ["parent", "child", "plan.md.bak", "ruling.md", "brief.md", "steer.md", "ruling-2.md", "update.txt", "x/plan.md"]) {
    assert.equal(ask(hd(`${own}/${t}`)), true, t);
  }
  assert.equal(ask(hd(`${own}/../other-run/plan.md`)), true, "..");
  assert.equal(ask(`cat > ${other}/plan.md <<'EOF'\nsee handoffs/own-run: the ruling\nEOF\n`), true, "another session's dir");
  assert.equal(ask(hd(`${own}/ask-link.md`)), true, "symlinked file");
  assert.equal(ask(hd(`${own}/update-hard.md`)), true, "hard link");
  assert.equal(ask(`cat > ${w}/handoffs/alias/plan.md <<'EOF'\nsee handoffs/own-run: the ruling\nEOF\n`), true, "symlinked dir");
  assert.equal(ask(`cat > $HOME/plan.md <<'EOF'\nsee handoffs/own-run: the ruling\nEOF\n`), true, "computed path");
});

test("R6.3 smuggling and body probes still ask", { skip: !posix }, () => {
  const T = `${own}/plan.md`;
  for (const cmd of [
    `cat > ${T};sh <<'EOF'\n${body}\n`,
    `cat > ${T} > ${own}/parent <<'EOF'\n${body}\n`,
    `tee ${T} ${own}/child <<'EOF'\n${body}\n`,
    `${hd(T)}&& cd ${own} && cp /tmp/r ruling.md`,
    `cat > ${T} <<'EOF'\nx\nEOF\ncp /tmp/r ${own}/ruling.md\n`,
    `cat > ${T} <<'EOF'\ndon't ruling\nEOF\ncp /tmp/r ${own}/rulingx.md # '\n`,
    `cat > ${T} <<'EOF'\ndon't ruling\nEOF\ntee ${own}/ruling.md <<'EOF'\nEOF\n`,
    `cat > ${T} <<'EOF'\nx\nEOF\ntee ${own}/ruling.md\n`,
    `cat > ${T} <<'EOF'\nthe ruling\n`,
    `cat > ${T} <<-'EOF'\nruling\nEOF`,
    `cat > ${T} <<EOF\nruling\nEOF`,
    `cat > ${T} <<"EOF"\nruling\nEOF`,
    `cat > ${T} <<\\EOF\nruling\nEOF`,
    `cat >| ${T} <<'EOF'\nruling\nEOF`,
    `cat > ${T} <<'EOF'\r\nruling\nEOF`,
    `cat > ${T} <<'EO"F'\nruling\nEOF`,
    `cp /tmp/r ${own}/ruling.md`,
    `mv ${T} ${own}/ruling.md`,
    `printf ruling > ${T}`,
    `echo ruling > ${T}`,
  ]) assert.equal(ask(cmd), true, cmd);
  assert.equal(ownHandoffHeredoc("bash", hd(T), [own], w), true);
  assert.equal(ownHandoffHeredoc("bash", `cat > ${T} <<'EOF'\nEOF\nEOF\nx`, [own], w), false);
});

test("R2.1 the child npm ci ask names the bare form", { skip: !posix }, () => {
  const baseline = readBaseline(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."))!;
  const rules = buildOverlayRules(baseline, {}, {}, path.join(w, "home", ".pi", "agent"), w, undefined, false);
  const d = checkToolCall(rules, "bash", { command: "npm ci 2>&1 | tail -5; ls" }, { cwd: w, home: path.join(w, "home"), platform: process.platform, role: "child" });
  assert.equal(d?.kind, "ask");
  assert.match(d?.reason ?? "", /bare `npm ci`/);
  const g = checkToolCall(rules, "bash", { command: "git fetch origin" }, { cwd: w, home: path.join(w, "home"), platform: process.platform, role: "child" });
  assert.equal(g?.kind, "ask");
  assert.doesNotMatch(g?.reason ?? "", /bare `npm ci`/);
});
