// `foreman reports list|show|set|expire|migrate` (bin/foreman, .cmd, .ps1): the report store of the repository the current folder belongs to (reports.ts, docs/retro.md#foreman-reports).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { get, loadMergedConfig } from "./config.ts";
import { piAgentDir } from "./env.ts";
import { resolvePython } from "./python.ts";
import { DATA_LINE, DEFAULT_EXPIRE_DAYS, ARCHIVE_DAYS, STATES, SETTABLE, expireLocked, findEntry, foldRows, importRows, quoted, readRows, renderList, reportContext, setState, storeFor } from "./reports.ts";
import { archiveDir, planMigration, renderPlan } from "./reports-migrate.ts";
import { mainCheckout } from "./workspacekey.ts";
import { defaultSpawner } from "./spawn.ts";

export const USAGE = [
  "usage: foreman reports list [--state open|planned|done|dropped|expired|all] [--json]",
  "       foreman reports show KEY [--json]",
  "       foreman reports set KEY open|planned|done|dropped [--label TEXT] [--pr N] [--reason TEXT]",
  "       foreman reports expire [--days N] [--archive-days N]",
  "       foreman reports migrate [--from DIR] [--workspace GLOB]... [--all] [--exclude GLOB]... [--min-count 2] [--within-days 30] [--archive] [--apply]",
].join("\n");

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ReportsDeps {
  cwd: string;
  now(): number;
  /** `retro.expireDays` of the merged config for `cwd`; undefined when none or the config does not load. */
  expireDays(): Promise<number | undefined>;
  /** The directory of the retired retro backlog (`migrate --from` default). */
  oldStore?(): string;
  /** `owner/name` of the repository for `cwd`, stored on migrated rows. */
  repo?(): Promise<string | null>;
}

export function realDeps(env: NodeJS.ProcessEnv = process.env): ReportsDeps {
  const cwd = process.cwd();
  return {
    cwd,
    now: Date.now,
    oldStore: () => path.join(piAgentDir(env, env.HOME ?? env.USERPROFILE ?? ""), "pi-foreman", "state", "retro", "backlog"),
    repo: async () => (await reportContext(cwd)).repo,
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

/** Options of `migrate`: `--workspace` and `--exclude` repeat; `--all`, `--archive` and `--apply` take no value. Null on an unknown option or a missing value. */
function parseMigrate(argv: string[]): { from?: string; workspace: string[]; exclude: string[]; all: boolean; archive: boolean; apply: boolean; minCount?: string; withinDays?: string } | null {
  const o = { workspace: [] as string[], exclude: [] as string[], all: false, archive: false, apply: false } as NonNullable<ReturnType<typeof parseMigrate>>;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "--archive" || a === "--apply") o[a.slice(2) as "all" | "archive" | "apply"] = true;
    else if (a === "--from" || a === "--workspace" || a === "--exclude" || a === "--min-count" || a === "--within-days") {
      const v = argv[++i];
      if (v === undefined || v === "") return null;
      if (a === "--workspace") o.workspace.push(v);
      else if (a === "--exclude") o.exclude.push(v);
      else if (a === "--from") o.from = v;
      else if (a === "--min-count") o.minCount = v;
      else o.withinDays = v;
    } else return null;
  }
  return o;
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
      for (const r of readRows(store.file)) if (r.row === "report" && e.keys.includes(String(r.key))) lines.push(`- ${String(r.ts)} ${String(r.id)} ${String(r.role)} session ${quoted(String(r.session), 80)} branch ${quoted(String(r.branch), 80)} ${String(r.source)}${typeof r.lastSeen === "string" ? ` last seen ${quoted(r.lastSeen, 40)}` : ""}${typeof r.count === "number" ? ` x${r.count}` : ""}`);
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
    if (cmd === "migrate") {
      const a = parseMigrate(rest);
      if (!a || (a.minCount !== undefined && positive(a.minCount) === null) || (a.withinDays !== undefined && positive(a.withinDays) === null)) return usage(err);
      const from = path.resolve(a.from ?? d.oldStore?.() ?? "");
      if (!a.from && !d.oldStore) return usage(err);
      const selection = a.all || a.workspace.length > 0;
      const minCount = positive(a.minCount) ?? 2;
      const withinDays = positive(a.withinDays) ?? 30;
      const have = new Set([...readRows(store.file), ...readRows(store.archive)].map((r) => String(r.id)));
      const plan = planMigration({ from, repoFile: path.join(mainCheckout(d.cwd), ".workflow", "retro-backlog.md"), workspace: a.workspace, all: a.all, exclude: a.exclude, minCount, withinDays, now: d.now(), repo: (await d.repo?.()) ?? null, have });
      const text = [a.apply ? "migrate" : "migrate dry run (nothing is changed; add --apply)", renderPlan(plan, { minCount, withinDays }, selection)];
      if (a.apply && selection) {
        text.push(`imported ${importRows(store, plan.rows)}`);
        if (a.archive && plan.fromExists) text.push(`archived ${from} as ${archiveDir(from, d.now())}`);
        else if (a.archive) text.push("archive skipped: the old store does not exist");
      } else if (a.archive) text.push(a.apply ? "archive skipped: no workspace selected" : `would rename ${from} to backlog-archive-<date> beside it`);
      out(`${text.join("\n")}\n`);
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
