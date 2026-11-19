// `foreman reports list|show|set|expire` (bin/foreman, .cmd, .ps1): the report store of the repository the current folder belongs to (reports.ts, docs/retro.md#foreman-reports).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { get, loadMergedConfig } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { resolvePython } from "./python.ts";
import { DATA_LINE, DEFAULT_EXPIRE_DAYS, ARCHIVE_DAYS, STATES, SETTABLE, expireLocked, findEntry, foldRows, quoted, readRows, renderList, setState, storeFor } from "./reports.ts";
import { defaultSpawner } from "./spawn.ts";

export const USAGE = [
  "usage: foreman reports list [--state open|planned|done|dropped|expired|all] [--json]",
  "       foreman reports show KEY [--json]",
  "       foreman reports set KEY open|planned|done|dropped [--label TEXT] [--pr N] [--reason TEXT]",
  "       foreman reports expire [--days N] [--archive-days N]",
].join("\n");

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ReportsDeps {
  cwd: string;
  now(): number;
  /** `retro.expireDays` of the merged config for `cwd`; undefined when none or the config does not load. */
  expireDays(): Promise<number | undefined>;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): ReportsDeps {
  const cwd = process.cwd();
  return {
    cwd,
    now: Date.now,
    expireDays: async () => {
      try {
        const spawner = defaultSpawner;
        const agentDir = piAgentDir(env, env.HOME ?? env.USERPROFILE ?? "");
        const py = await resolvePython({ configPath: null, envPath: env.PI_FOREMAN_PYTHON, platform: process.platform, spawner });
        const cfg = await loadMergedConfig({ python: py.ok ? py.info.executable : null, pkgRoot: PKG_ROOT, agentDir, projectDir: cwd, trusted: false, spawner });
        const v = get(cfg.config, "retro.expireDays");
        return typeof v === "number" && v >= 1 ? v : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

const usage = (err: (s: string) => void): number => (err(`${USAGE}\n`), 2);

/** Splits `argv` into positionals and `--name value` options (`--json` takes none); null on a missing value or an unknown option. */
function parse(argv: string[], valued: readonly string[]): { pos: string[]; opt: Record<string, string>; json: boolean } | null {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      const name = a.slice(2);
      const v = argv[++i];
      if (!valued.includes(name) || v === undefined) return null;
      opt[name] = v;
    } else pos.push(a);
  }
  return { pos, opt, json };
}

const positive = (v: string | undefined): number | null => (v !== undefined && /^\d{1,6}$/.test(v) && Number(v) >= 1 ? Number(v) : null);

/** The CLI: argv after `reports`. Returns the exit code. */
export async function main(argv: string[], out: (s: string) => void, err: (s: string) => void, deps: () => ReportsDeps = realDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const d = deps();
  const store = storeFor(d.cwd);
  try {
    if (cmd === "list") {
      const a = parse(rest, ["state"]);
      if (!a || a.pos.length) return usage(err);
      const want = a.opt.state ?? "open";
      if (want !== "all" && !(STATES as readonly string[]).includes(want)) return usage(err);
      const entries = foldRows(readRows(store.file)).filter((e) => want === "all" || e.state === want).sort((x, y) => y.count - x.count || (x.last < y.last ? 1 : -1));
      out(a.json ? `${JSON.stringify(entries)}\n` : `${renderList(entries)}\n`);
      return 0;
    }
    if (cmd === "show") {
      const a = parse(rest, []);
      if (!a || a.pos.length !== 1) return usage(err);
      const e = findEntry(foldRows(readRows(store.file)), a.pos[0]);
      if (!e) return (err(`foreman reports: no entry for ${a.pos[0]}\n`), 1);
      if (a.json) {
        out(`${JSON.stringify({ ...e, reports: readRows(store.file).filter((r) => r.row === "report" && e.keys.includes(String(r.key))) })}\n`);
        return 0;
      }
      const lines = [DATA_LINE, `key ${e.key}${e.keys.length > 1 ? ` (group of ${e.keys.join(", ")})` : ""}`, `state ${e.state}${e.label ? ` round ${quoted(e.label, 60)}` : ""}${e.pr ? ` PR #${e.pr}` : ""}${e.reason ? ` reason ${quoted(e.reason, 200)}` : ""}`, `kind ${e.kind}, effect ${e.effect}, ${e.count} session${e.count === 1 ? "" : "s"}, first ${e.first}, last ${e.last}`, `subject ${quoted(e.subject, 400)}`, `what ${quoted(e.what, 400)}`];
      if (e.suggest) lines.push(`suggest ${quoted(e.suggest, 400)}`);
      for (const r of readRows(store.file)) if (r.row === "report" && e.keys.includes(String(r.key))) lines.push(`- ${String(r.ts)} ${String(r.id)} ${String(r.role)} session ${quoted(String(r.session), 80)} branch ${quoted(String(r.branch), 80)} ${String(r.source)}`);
      out(`${lines.join("\n")}\n`);
      return 0;
    }
    if (cmd === "set") {
      const a = parse(rest, ["label", "pr", "reason"]);
      if (!a || a.pos.length !== 2 || !(SETTABLE as readonly string[]).includes(a.pos[1])) return usage(err);
      if (a.opt.pr !== undefined && positive(a.opt.pr) === null) return usage(err);
      const r = setState(store, a.pos[0], { state: a.pos[1], label: a.opt.label, pr: a.opt.pr === undefined ? undefined : Number(a.opt.pr), reason: a.opt.reason }, "cli", d.now());
      if ("error" in r) return (err(`foreman reports: ${r.error}\n`), 1);
      out(`${r.key} is now ${r.state}\n`);
      return 0;
    }
    if (cmd === "expire") {
      const a = parse(rest, ["days", "archive-days"]);
      if (!a || a.pos.length || a.json) return usage(err);
      if ((a.opt.days !== undefined && positive(a.opt.days) === null) || (a.opt["archive-days"] !== undefined && positive(a.opt["archive-days"]) === null)) return usage(err);
      const days = positive(a.opt.days) ?? (await d.expireDays()) ?? DEFAULT_EXPIRE_DAYS;
      const r = expireLocked(store, d.now(), days, positive(a.opt["archive-days"]) ?? ARCHIVE_DAYS);
      out(`expired ${r.expired}, archived ${r.archived}\n`);
      return 0;
    }
  } catch (e) {
    err(`foreman reports: ${/^locked/.test((e as Error).message) ? "the list is busy, try again" : (e as Error).message}\n`);
    return 1;
  }
  return usage(err);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
