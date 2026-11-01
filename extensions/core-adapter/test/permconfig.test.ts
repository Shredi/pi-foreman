// r79 item 2: permconfig.ts: the three files, trust, profiles, mode resolution, invalid-file fallbacks, mtime cache, remember writer, notices.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { BUILTIN_PROFILES, PermStore, profileName, userFilePath } from "../permconfig.ts";
import type { GitRun, PermEnv, PermMode } from "../permconfig.ts";
import { matchRules } from "../rules.ts";
import { mkTestTmp } from "./_tmpbase.ts";

const root = fs.realpathSync(mkTestTmp("pf79-perm-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;

interface World {
  base: string;
  agentDir: string;
  main: string;
  wt: string;
  tracked: Set<string>;
  ignored: boolean;
  gitCalls: string[][];
  env: PermEnv;
  store: () => PermStore;
  user: (o: unknown) => void;
  project: (o: unknown) => void;
  trackedFile: (o: unknown) => void;
  raw: (kind: "user" | "project" | "tracked", text: string) => void;
}

/** A world with a fake git: `worktree list` names main first, `ls-files` knows `tracked`, `check-ignore` follows `ignored`. */
function world(o: Partial<PermEnv> = {}): World {
  const base = path.join(root, `w${++n}`);
  const agentDir = path.join(base, "agent");
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  for (const d of [path.join(agentDir, "pi-foreman"), path.join(main, ".workflow"), path.join(wt, ".pi")]) fs.mkdirSync(d, { recursive: true });
  const w = { base, agentDir, main, wt, tracked: new Set<string>(), ignored: true, gitCalls: [] as string[][] } as World;
  const git: GitRun = (args) => {
    w.gitCalls.push(args);
    if (args[0] === "worktree") return { status: 0, stdout: `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD abc\n` };
    const rel = args[args.length - 1];
    if (args[0] === "ls-files") return { status: w.tracked.has(rel) ? 0 : 1, stdout: "" };
    if (args[0] === "check-ignore") return { status: w.ignored ? 0 : 1, stdout: "" };
    return { status: 1, stdout: "" };
  };
  w.env = { agentDir, cwd: wt, home: path.join(base, "home"), git, ...o };
  w.store = () => new PermStore(w.env);
  const put = (file: string) => (v: unknown) => fs.writeFileSync(file, JSON.stringify(v));
  w.user = put(userFilePath(agentDir));
  w.project = put(path.join(main, ".workflow", "permissions.json"));
  w.trackedFile = put(path.join(wt, ".pi", "permissions.json"));
  w.raw = (kind, text) => fs.writeFileSync(kind === "user" ? userFilePath(agentDir) : kind === "project" ? path.join(main, ".workflow", "permissions.json") : path.join(wt, ".pi", "permissions.json"), text);
  return w;
}

const texts = (r: { rules: { allow: { text: string }[]; ask: { text: string }[]; deny: { text: string }[] } }) => ({ allow: r.rules.allow.map((x) => x.text), ask: r.rules.ask.map((x) => x.text), deny: r.rules.deny.map((x) => x.text) });

test("missing files: mode auto, empty lists, no notice", () => {
  const w = world();
  const s = w.store();
  const r = s.resolve();
  assert.equal(r.mode, "auto");
  assert.equal(r.modeSource, "default");
  assert.deepEqual(texts(r), { allow: [], ask: [], deny: [] });
  assert.deepEqual(r.prose, { allow: [], deny: [] });
  assert.deepEqual(s.drainNotices(), []);
  assert.equal(r.profile, null);
});

test("the user file: mode, rules per verdict class, numbered prose entries with their source", () => {
  const w = world();
  w.user({ mode: "ask", allow: ["Bash(git status *)"], ask: ["Bash(git push *)"], deny: ["Read(~/.ssh/**)"], additionalDirectories: ["~/notes", "/data/x"], classifier: { allow: ["Deploying the docs site is fine."], deny: ["Never touch production."] } });
  const r = w.store().resolve();
  assert.equal(r.mode, "ask");
  assert.equal(r.modeSource, "user");
  assert.deepEqual(texts(r), { allow: ["Bash(git status *)"], ask: ["Bash(git push *)"], deny: ["Read(~/.ssh/**)"] });
  assert.deepEqual(r.prose.allow, [{ id: "A1", text: "Deploying the docs site is fine.", source: "user" }]);
  assert.deepEqual(r.prose.deny, [{ id: "D1", text: "Never touch production.", source: "user" }]);
  assert.deepEqual(r.additionalDirectories, [path.join(w.env.home, "notes"), path.normalize("/data/x")]);
});

test("files concatenate: user, project, tracked; prose numbering runs across files", () => {
  const w = world();
  w.user({ allow: ["Bash(a *)"], classifier: { allow: ["User sentence."] } });
  w.project({ allow: ["Bash(b *)"], classifier: { allow: ["Project sentence."] } });
  w.trackedFile({ deny: ["Bash(c *)"], classifier: { deny: ["Tracked deny."] } });
  const r = w.store().resolve();
  assert.deepEqual(texts(r).allow, ["Bash(a *)", "Bash(b *)"]);
  assert.deepEqual(texts(r).deny, ["Bash(c *)"]);
  assert.deepEqual(r.prose.allow.map((e) => `${e.id}:${e.source}`), ["A1:user", "A2:project"]);
  assert.deepEqual(r.prose.deny.map((e) => `${e.id}:${e.source}`), ["D1:tracked"]);
  // verdict precedence still decides at match time: a deny of the tracked file beats the allow of the user file
  const env = { cwd: w.wt, home: w.env.home, platform: process.platform, checkout: w.main };
  const call = { tool: "bash", segments: [{ text: "c x", opaque: false, writesRedirect: false }] };
  assert.equal(matchRules({ ...r.rules, allow: [...r.rules.allow, ...(r.rules.allow)] }, call, env).verdict, "deny");
});

test("invalid user file: mode ask, the other files still apply, one notice at the first read", () => {
  const w = world();
  w.raw("user", "{ not json");
  w.project({ allow: ["Bash(p *)"] });
  const s = w.store();
  const r = s.resolve();
  assert.equal(r.mode, "ask");
  assert.equal(r.modeSource, "invalid-user-file");
  assert.deepEqual(texts(r).allow, ["Bash(p *)"]);
  const notes = s.drainNotices();
  assert.equal(notes.filter((x) => x.includes("permissions.json") && x.includes("invalid")).length, 1, notes.join("\n"));
  assert.match(notes.join("\n"), /Mode ask applies/);
  s.resolve();
  assert.deepEqual(s.drainNotices(), [], "no second notice");
  // a wrong top level shape is invalid too
  w.raw("user", "[1]");
  s.reload();
  assert.equal(s.resolve().mode, "ask");
  w.raw("user", JSON.stringify({ allow: "Bash(x)" }));
  s.reload();
  assert.equal(s.resolve().modeSource, "invalid-user-file");
});

test("invalid project or tracked file contributes nothing and keeps the mode", () => {
  const w = world();
  w.user({ mode: "deny", deny: ["Bash(u *)"] });
  w.raw("project", "nope");
  w.trackedFile({ deny: "Bash(x)" });
  const s = w.store();
  const r = s.resolve();
  assert.equal(r.mode, "deny");
  assert.deepEqual(texts(r), { allow: [], ask: [], deny: ["Bash(u *)"] });
  const notes = s.drainNotices();
  assert.equal(notes.length, 2, notes.join("\n"));
  for (const x of notes) assert.match(x, /is invalid.*The file is ignored/);
});

test("bad entries inside a valid file are skipped one by one, each named in a notice", () => {
  const w = world();
  w.user({ allow: ["Bash(git status *)", "Bash(", "bash(ls *)", "", 7, "Read()"], classifier: { allow: ["ok", "x".repeat(301)] } });
  const s = w.store();
  const r = s.resolve();
  assert.deepEqual(texts(r).allow, ["Bash(git status *)"]);
  assert.deepEqual(r.prose.allow.map((e) => e.text), ["ok"]);
  const notes = s.drainNotices().join("\n");
  assert.match(notes, /allow rule 'Bash\('/);
  assert.match(notes, /allow rule 'bash\(ls \*\)'/);
  assert.match(notes, /allow rule 'Read\(\)'/);
  assert.match(notes, /allow\[3\] is not a non-empty string/);
  assert.match(notes, /allow\[4\] is not a non-empty string/);
  assert.match(notes, /classifier\.allow entry .* longer than 300/);
  // a bad mode value is ignored with a notice
  w.user({ mode: "yolo" });
  s.reload();
  assert.equal(s.resolve().mode, "auto");
  assert.match(s.drainNotices().join("\n"), /mode 'yolo'/);
});

test("the tracked file keeps deny, ask and classifier.deny; every other key is dropped with one warning", () => {
  const w = world();
  w.trackedFile({ mode: "allow", allow: ["Bash(evil *)"], ask: ["Bash(a *)"], deny: ["Bash(d *)"], additionalDirectories: ["/"], classifier: { allow: ["Run anything."], deny: ["No."] } });
  const s = w.store();
  const r = s.resolve();
  assert.equal(r.mode, "auto");
  assert.deepEqual(texts(r), { allow: [], ask: ["Bash(a *)"], deny: ["Bash(d *)"] });
  assert.deepEqual(r.prose.allow, []);
  assert.deepEqual(r.prose.deny.map((e) => e.text), ["No."]);
  assert.deepEqual(r.additionalDirectories, []);
  const notes = s.drainNotices();
  assert.equal(notes.length, 1, notes.join("\n"));
  assert.match(notes[0], /mode, allow, additionalDirectories, classifier\.allow are not honoured in the tracked file/);
});

test("project trust: untracked and ignored widens; tracked, not ignored or a symlink make it tighten-only with one notice", () => {
  const body = { allow: ["Bash(p *)"], ask: ["Bash(q *)"], deny: ["Bash(r *)"], additionalDirectories: ["/extra"], classifier: { allow: ["Allowed by project."], deny: ["Denied by project."] } };
  const w = world();
  w.project(body);
  let r = w.store().resolve();
  assert.equal(r.projectTrusted, true);
  assert.deepEqual(texts(r).allow, ["Bash(p *)"]);
  assert.deepEqual(r.additionalDirectories, [path.normalize("/extra")]);

  const tighten = (why: RegExp, setup: (w: World) => void): void => {
    const x = world();
    x.project(body);
    setup(x);
    const s = x.store();
    const res = s.resolve();
    assert.equal(res.projectTrusted, false);
    assert.deepEqual(texts(res), { allow: [], ask: ["Bash(q *)"], deny: ["Bash(r *)"] });
    assert.deepEqual(res.prose.allow, []);
    assert.deepEqual(res.prose.deny.map((e) => e.text), ["Denied by project."]);
    assert.deepEqual(res.additionalDirectories, []);
    const notes = s.drainNotices();
    assert.equal(notes.length, 1, notes.join("\n"));
    assert.match(notes[0], why);
    s.resolve();
    assert.deepEqual(s.drainNotices(), []);
  };
  tighten(/tracked by git/, (x) => x.tracked.add(".workflow/permissions.json"));
  tighten(/not ignored by git/, (x) => {
    x.ignored = false;
  });
  tighten(/symbolic link/, (x) => {
    const real = path.join(x.base, "real.json");
    fs.renameSync(path.join(x.main, ".workflow", "permissions.json"), real);
    fs.symlinkSync(real, path.join(x.main, ".workflow", "permissions.json"));
  });
  tighten(/symbolic link/, (x) => {
    const real = path.join(x.base, "realdir");
    fs.renameSync(path.join(x.main, ".workflow"), real);
    fs.symlinkSync(real, path.join(x.main, ".workflow"));
  });
  r = w.store().resolve();
  assert.equal(r.projectFile, path.join(w.main, ".workflow", "permissions.json"));
});

test("project mode and profiles are ignored with a warning", () => {
  const w = world();
  w.user({ mode: "ask" });
  w.project({ mode: "allow", profiles: { x: { mode: "allow" } } });
  const s = w.store();
  const r = s.resolve();
  assert.equal(r.mode, "ask");
  assert.match(s.drainNotices().join("\n"), /(?:mode, profiles|profiles, mode) are not honoured in the project file/);
  w.env.profile = "x";
  const s2 = w.store();
  s2.resolve();
  assert.match(s2.drainNotices().join("\n"), /profile 'x' is not defined/);
});

test("worktree resolution: the project file is the main checkout's, the tracked file the worktree's", () => {
  const w = world();
  const s = w.store();
  assert.equal(s.main(), w.main);
  assert.equal(s.filePath("project"), path.join(w.main, ".workflow", "permissions.json"));
  assert.equal(s.filePath("tracked"), path.join(w.wt, ".pi", "permissions.json"));
  assert.equal(s.filePath("user"), path.join(w.agentDir, "pi-foreman", "permissions.json"));
  // outside git: the worktree itself
  const x = world({ git: () => ({ status: 128, stdout: "" }) });
  assert.equal(x.store().main(), x.wt);
});

test("profiles: the built-in steward adds its allows and runs mode auto; a user profile can carry a mode and prose", () => {
  const w = world({ profile: "steward" });
  w.user({ mode: "ask", allow: ["Bash(u *)"] });
  const r = w.store().resolve();
  assert.equal(r.profile, "steward");
  assert.equal(r.mode, "auto", "the profile mode wins over the user file");
  assert.equal(r.modeSource, "profile");
  assert.deepEqual(texts(r).allow.slice(0, 1), ["Bash(u *)"]);
  for (const rule of BUILTIN_PROFILES.steward.allow) assert.ok(texts(r).allow.includes(rule), rule);
  for (const needle of ["herdr pane send-text", "herdr pane send-keys", "herdr pane read", "herdr pane list", "pgrep", "ps ", "intercom"]) assert.ok(texts(r).allow.some((t) => t.includes(needle)), needle);
  assert.ok(r.entries.some((e) => e.source === "profile steward"));

  const u = world({ profile: "review" });
  u.user({ profiles: { review: { mode: "deny", allow: ["Bash(git log *)"], classifier: { allow: ["Reading logs is fine."] } } } });
  const ru = u.store().resolve();
  assert.equal(ru.mode, "deny");
  assert.deepEqual(texts(ru).allow, ["Bash(git log *)"]);
  assert.equal(ru.prose.allow[0].source, "profile review");

  // an unknown profile is ignored with a notice
  const x = world({ profile: "nope" });
  const sx = x.store();
  assert.equal(sx.resolve().profile, null);
  assert.match(sx.drainNotices().join("\n"), /profile 'nope' is not defined/);
});

test("the steward rules match the calls a steward makes", () => {
  const w = world({ profile: "steward" });
  const r = w.store().resolve();
  const env = { cwd: w.wt, home: w.env.home, platform: process.platform, checkout: w.main };
  const seg = (text: string) => ({ tool: "bash", segments: [{ text, opaque: false, writesRedirect: false }] });
  for (const t of ["herdr pane send-text 1-2 please summarise", "herdr pane send-keys 1-2 please summarise", "herdr pane read 1-2", "herdr pane list", "pgrep node", "ps aux", "intercom send x"]) assert.equal(matchRules(r.rules, seg(t), env).verdict, "allow", t);
  assert.equal(matchRules(r.rules, { tool: "intercom", payload: "{}" }, env).verdict, "allow");
  for (const t of ["rm -rf x", "herdr pane close 1"]) assert.equal(matchRules(r.rules, seg(t), env).verdict, "none", t);
});

test("profileName: the env variable of the CLI wins over the config key; empty is none", () => {
  assert.equal(profileName({ permissions: { profile: "steward" } }, {}), "steward");
  assert.equal(profileName({ permissions: { profile: "steward" } }, { PI_FOREMAN_PERMS_PROFILE: "other" }), "other");
  assert.equal(profileName({ permissions: { profile: null } }, {}), null);
  assert.equal(profileName({}, { PI_FOREMAN_PERMS_PROFILE: "  " }), null);
  assert.equal(profileName(undefined, {}), null);
});

test("a child store built with the parent's profile and override resolves the same lists and mode", () => {
  const w = world({ profile: "steward", sessionMode: "ask" });
  w.user({ allow: ["Bash(u *)"] });
  const parent = w.store().resolve();
  const child = new PermStore({ ...w.env, profile: parent.profile, sessionMode: parent.modeSource === "session" ? parent.mode : null }).resolve();
  assert.equal(child.mode, "ask");
  assert.equal(child.profile, "steward");
  assert.deepEqual(texts(child), texts(parent));
});

test("mode resolution: session override > profile > user file > default; an invalid user file reads as ask under a profile mode", () => {
  const cases: { user?: PermMode; profile?: PermMode; session?: PermMode; want: PermMode; src: string }[] = [
    { want: "auto", src: "default" },
    { user: "ask", want: "ask", src: "user" },
    { user: "allow", profile: "deny", want: "deny", src: "profile" },
    { user: "allow", profile: "deny", session: "ask", want: "ask", src: "session" },
    { session: "allow", want: "allow", src: "session" },
    { profile: "ask", want: "ask", src: "profile" },
  ];
  for (const c of cases) {
    const w = world({ profile: c.profile ? "p" : null, sessionMode: c.session ?? null });
    w.user({ ...(c.user ? { mode: c.user } : {}), profiles: c.profile ? { p: { mode: c.profile } } : undefined });
    const r = w.store().resolve();
    assert.equal(r.mode, c.want, JSON.stringify(c));
    assert.equal(r.modeSource, c.src, JSON.stringify(c));
  }
  const w = world({ profile: "steward" });
  w.raw("user", "{");
  assert.equal(w.store().resolve().mode, "auto", "steward's own mode");
  const v = world();
  v.raw("user", "{");
  const s = v.store();
  assert.equal(s.resolve().mode, "ask");
  s.setSessionMode("allow");
  assert.equal(s.resolve().mode, "allow");
  s.setSessionMode(null);
  assert.equal(s.resolve().mode, "ask");
});

test("mtime cache: unchanged files return the same object, a changed file is re-read, reload() forgets", () => {
  const w = world();
  w.user({ allow: ["Bash(a *)"] });
  const s = w.store();
  const a = s.resolve();
  assert.equal(s.resolve(), a);
  const file = userFilePath(w.agentDir);
  w.user({ allow: ["Bash(a *)", "Bash(b *)"] });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  const b = s.resolve();
  assert.notEqual(b, a);
  assert.deepEqual(texts(b).allow, ["Bash(a *)", "Bash(b *)"]);
  assert.equal(s.resolve(), b);
  s.reload();
  assert.notEqual(s.resolve(), b);
  // a file appearing later is picked up without reload
  w.project({ deny: ["Bash(z *)"] });
  assert.deepEqual(texts(s.resolve()).deny, ["Bash(z *)"]);
  // a file disappearing is dropped
  fs.rmSync(path.join(w.main, ".workflow", "permissions.json"));
  assert.deepEqual(texts(s.resolve()).deny, []);
});

test("writeRemember: appends the sentence and the rule, keeps other keys and their order, applies at once", () => {
  const w = world();
  w.raw("project", JSON.stringify({ zeta: 1, allow: ["Bash(old *)"], deny: ["Bash(d *)"], classifier: { deny: ["Keep me."], extra: true }, last: "x" }));
  const s = w.store();
  s.resolve();
  const res = s.writeRemember({ prose: "  Deploying   the\ndocs site is fine.  ", rule: "Bash(ssh docs *)" });
  assert.deepEqual(res, { ok: true, file: path.join(w.main, ".workflow", "permissions.json") });
  const written = JSON.parse(fs.readFileSync(res.ok ? res.file : "", "utf8"));
  assert.deepEqual(Object.keys(written), ["zeta", "allow", "deny", "classifier", "last"]);
  assert.deepEqual(written.allow, ["Bash(old *)", "Bash(ssh docs *)"]);
  assert.deepEqual(written.classifier, { deny: ["Keep me."], extra: true, allow: ["Deploying the docs site is fine."] });
  assert.equal(written.last, "x");
  const r = s.resolve();
  assert.deepEqual(r.prose.allow.map((e) => e.text), ["Deploying the docs site is fine."]);
  assert.ok(texts(r).allow.includes("Bash(ssh docs *)"));
  // the same entry twice is written once
  s.writeRemember({ prose: "Deploying the docs site is fine.", rule: "Bash(ssh docs *)" });
  const again = JSON.parse(fs.readFileSync(path.join(w.main, ".workflow", "permissions.json"), "utf8"));
  assert.deepEqual(again.allow, ["Bash(old *)", "Bash(ssh docs *)"]);
  assert.deepEqual(again.classifier.allow, ["Deploying the docs site is fine."]);
  assert.equal(fs.existsSync(`${path.join(w.main, ".workflow", "permissions.json")}.${process.pid}.tmp`), false);
});

test("writeRemember creates the file and the directory when they are missing", () => {
  const w = world();
  fs.rmSync(path.join(w.main, ".workflow"), { recursive: true });
  const res = w.store().writeRemember({ prose: "Fine." });
  assert.equal(res.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.main, ".workflow", "permissions.json"), "utf8")), { classifier: { allow: ["Fine."] } });
});

test("writeRemember refuses: tracked, not ignored (names .git/info/exclude), symlinked target or directory, invalid JSON, bad input", () => {
  const refused = (setup: (w: World) => void, input: { prose?: string; rule?: string }, why: RegExp): void => {
    const w = world();
    w.project({ allow: ["Bash(keep *)"] });
    setup(w);
    const before = fs.readFileSync(path.join(w.main, ".workflow", "permissions.json"), "utf8");
    const res = w.store().writeRemember(input);
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.reason, why);
    assert.equal(fs.readFileSync(path.join(w.main, ".workflow", "permissions.json"), "utf8"), before, "file untouched");
  };
  refused((w) => w.tracked.add(".workflow/permissions.json"), { prose: "Fine." }, /tracked by git/);
  refused((w) => void (w.ignored = false), { prose: "Fine." }, /\.git\/info\/exclude/);
  refused((w) => w.raw("project", "{ nope"), { prose: "Fine." }, /not valid JSON/);
  refused(() => undefined, { prose: "" }, /1 to 300/);
  refused(() => undefined, { prose: "x".repeat(301) }, /1 to 300/);
  refused(() => undefined, { rule: "Bash(" }, /pattern rule is not valid/);
  refused(() => undefined, {}, /nothing to remember/);
  refused((w) => w.raw("project", JSON.stringify({ allow: "Bash(x)" })), { rule: "Bash(a *)" }, /allow in .* is not a list/);
  // a symlinked file
  const w = world();
  const real = path.join(w.base, "real.json");
  fs.writeFileSync(real, "{}");
  fs.symlinkSync(real, path.join(w.main, ".workflow", "permissions.json"));
  const res = w.store().writeRemember({ prose: "Fine." });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.reason, /symbolic link/);
  assert.equal(fs.readFileSync(real, "utf8"), "{}");
  // a symlinked .workflow directory
  const x = world();
  const dir = path.join(x.base, "elsewhere");
  fs.renameSync(path.join(x.main, ".workflow"), dir);
  fs.symlinkSync(dir, path.join(x.main, ".workflow"));
  const rx = x.store().writeRemember({ prose: "Fine." });
  assert.equal(rx.ok, false);
  assert.match(rx.ok ? "" : rx.reason, /symbolic link/);
  assert.equal(fs.existsSync(path.join(dir, "permissions.json")), false);
});

test("notices are delivered once per text, also across reloads", () => {
  const w = world();
  w.raw("user", "{");
  const s = w.store();
  s.resolve();
  assert.equal(s.drainNotices().length, 1);
  s.reload();
  s.resolve();
  assert.deepEqual(s.drainNotices(), []);
});

test("real git: an ignored untracked project file is trusted, a tracked or not ignored one is not, writeRemember follows", () => {
  const base = path.join(root, `real${++n}`);
  const main = path.join(base, "main");
  const wt = path.join(base, "wt");
  fs.mkdirSync(main, { recursive: true });
  const git = (args: string[], cwd: string): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"], main);
  git(["commit", "-q", "--allow-empty", "-m", "i"], main);
  git(["worktree", "add", "-q", "-b", "feature", wt], main);
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(path.join(main, ".workflow"), { recursive: true });
  fs.writeFileSync(path.join(main, ".workflow", "permissions.json"), JSON.stringify({ allow: ["Bash(p *)"] }));
  const store = (): PermStore => new PermStore({ agentDir, cwd: wt, home: base });
  let s = store();
  // git prints the long (canonical) spelling; the native realpath expands a win32 8.3 short tmpdir name the same way
  assert.equal(fs.realpathSync.native(s.main()), fs.realpathSync.native(main));
  assert.equal(s.resolve().projectTrusted, false, "not ignored yet");
  assert.deepEqual(texts(s.resolve()).allow, []);
  fs.mkdirSync(path.join(main, ".git", "info"), { recursive: true });
  fs.appendFileSync(path.join(main, ".git", "info", "exclude"), ".workflow/\n");
  s = store();
  assert.equal(s.resolve().projectTrusted, true);
  assert.deepEqual(texts(s.resolve()).allow, ["Bash(p *)"]);
  assert.equal(s.writeRemember({ prose: "Fine." }).ok, true);
  // tracked wins over ignored
  git(["add", "-f", ".workflow/permissions.json"], main);
  s = store();
  assert.equal(s.resolve().projectTrusted, false);
  assert.equal(s.writeRemember({ prose: "More." }).ok, false);
});
