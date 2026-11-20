// The session-open dialog (session.ts): the brief link gets a served URL only when its real path ends in .md or .txt; pageUrlFor's remote rule and fallbacks.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSessionCommand } from "../session.ts";
import type { SessionDeps } from "../session.ts";
import type { DialogSpec } from "../ownerdialog.ts";
import { pageLinks } from "../pagelinks.ts";
import { pageUrlFor, pagesStateDir } from "../pageserver.ts";
import type { ServerRecord } from "../pageserver.ts";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pf-brief-links-")));
fs.writeFileSync(path.join(root, "b.md"), "# Brief\nbody\n");
fs.writeFileSync(path.join(root, "b.txt"), "# Brief\nbody\n");
fs.writeFileSync(path.join(root, "b.html"), "<h1>Brief</h1>\n");
fs.symlinkSync(path.join(root, "b.html"), path.join(root, "link.md"));
fs.symlinkSync(path.join(root, "b.md"), path.join(root, "alias.html"));
const was = pageLinks.url;
afterEach(() => void (pageLinks.url = was));

function specOf(brief: string, over: Partial<SessionDeps> = {}): Promise<DialogSpec> {
  return new Promise((resolve) => {
    const d: SessionDeps = {
      isChild: false, env: {}, agentDir: path.join(root, "agent"), cwd: root, piSessionId: "sess-1", pkgRoot: "/pkg", python: "/usr/bin/python3",
      spawner: async () => ({ code: 0, stdout: "handoff: x", stderr: "", timedOut: false }), send: async () => "sent",
      confirm: async () => false, confirmShaped: async (spec) => (resolve(spec), false), ...over,
    };
    void runSessionCommand(d, `open demo ${brief}`);
  });
}

const URL_ = "http://127.0.0.1:47317/BrIeF/b.md";

test("brief link: .md and .txt get the served URL (kind file); .html and a link to .html do not", async () => {
  const calls: { path: string; kind: string }[] = [];
  pageLinks.url = async (p, kind) => (calls.push({ path: p, kind }), URL_);
  assert.equal((await specOf("b.md")).links![0].url, URL_);
  assert.equal((await specOf("b.txt")).links![0].url, URL_);
  assert.equal((await specOf("link.md")).links![0].url, undefined, "the real path decides: a .md name linking an .html file");
  const before = calls.length;
  assert.equal((await specOf("b.html")).links![0].url, undefined);
  assert.equal(calls.length, before, "no lookup for a brief that gets no link");
  assert.deepEqual(calls.map((c) => c.kind), ["file", "file"]);
  assert.equal(calls[0].path, path.join(root, "b.md"));
  assert.equal((await specOf("alias.html")).links![0].url, URL_, "an .html name linking a .md file: its real path is .md");
});

test("brief link: no served URL keeps today's link (no url field)", async () => {
  pageLinks.url = async () => null;
  const l = (await specOf("b.md")).links![0];
  assert.deepEqual(l, { label: "Brief", path: path.join(root, "b.md"), text: "open the brief", kind: "text" });
});

// ---- pageUrlFor: the remote rule and the fallbacks (fake ensure, a temp agent dir)

const rec = (over: Partial<ServerRecord> = {}): ServerRecord => ({ pid: 1, port: 47317, configPort: 47317, bind: "127.0.0.1", version: "1.0.0", startedAt: 0, healthKey: "k", ...over });
function link(over: { env?: NodeJS.ProcessEnv; config?: Record<string, unknown>; r?: ServerRecord | null } = {}) {
  const agentDir = path.join(root, "agent-url");
  const deps = { env: over.env ?? {}, agentDir, ensure: async () => (over.r === undefined ? rec() : over.r), now: () => 1_000 };
  return pageUrlFor(path.join(root, "b.md"), "file", over.config as never, deps);
}

test("pageUrlFor: a local session gets a URL under the secret of its root; the root is recorded", async () => {
  const u = await link();
  assert.match(u!, /^http:\/\/127\.0\.0\.1:47317\/[A-Za-z0-9_-]{43}\/b\.md$/);
  assert.equal(fs.readdirSync(path.join(pagesStateDir(path.join(root, "agent-url")), "roots")).length, 1);
});

test("pageUrlFor: a remote session (SSH_CONNECTION or PI_FOREMAN_REMOTE_PARENT) keeps file links unless baseUrl is set", async () => {
  assert.equal(await link({ env: { SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" } }), null);
  assert.equal(await link({ env: { PI_FOREMAN_REMOTE_PARENT: "1" } }), null);
  const cfg = { pages: { server: { baseUrl: "https://box.example.net:8443" } } };
  const u = await link({ env: { SSH_CONNECTION: "x" }, config: cfg });
  assert.match(u!, /^https:\/\/box\.example\.net:8443\/[A-Za-z0-9_-]{43}\/b\.md$/);
});

test("pageUrlFor: disabled, no server and a missing file give no URL", async () => {
  assert.equal(await link({ config: { pages: { server: { enabled: false } } } }), null);
  assert.equal(await link({ r: null }), null);
  assert.equal(await pageUrlFor(path.join(root, "nope.md"), "file", undefined, { env: {}, agentDir: path.join(root, "agent-url"), ensure: async () => rec() }), null);
});
