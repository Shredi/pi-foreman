// Project agents must not redefine a pi-foreman role (security review S6).
//
// pi-subagents 0.75.0 discovers agents in builtin, package, user AND project scope and lets the
// project win a name collision: `<project>/.pi/agents/<name>.md`, `<project>/.agents/<name>.md`
// and `<project>/.pi/settings.json` `subagents.agentOverrides.<name>` (src/agents/agents.js
// discoverAgentsUncached, agent-selection.js mergeAgentsForScope). The scope is chosen per call
// by the `subagent` tool parameter `agentScope` ("user" | "project" | "both", default "both";
// src/agents/agent-scope.js). There is no settings key for it, so the generated settings block
// cannot set it: the adapter rewrites every `subagent` call to `agentScope: "user"` (builtin,
// package and user agents; project agents and project settings are not read). The write
// protection in the overlay keeps children from writing those files; the shadow check below
// tells the user when a project already carries one.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Force user-scope agent discovery on a `subagent` call. True when an explicit other scope was overridden. */
export function forceUserScope(input: Json): boolean {
  if (!isObj(input)) return false;
  const overridden = input.agentScope !== undefined && input.agentScope !== "user";
  input.agentScope = "user";
  return overridden;
}

/** Runtime name of an agent file: its frontmatter `name:`, else the file name. */
function agentName(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const m = fm ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm[1]) : null;
    if (m) return m[1].trim();
  } catch {
    // unreadable: fall back to the file name
  }
  return path.basename(file, ".md");
}

/**
 * Project files that would shadow one of `roles` under agent scope "both": agent definitions in
 * `.pi/agents/` or `.agents/` and `subagents.agentOverrides` / `agentOverridesByProvider` entries
 * in `.pi/settings.json`, in `cwd` and its ancestors below the home directory (pi-subagents never
 * treats the home directory as a project). Returns "<role>: <file>" lines.
 */
export function shadowedRoles(cwd: string, roles: readonly string[], home: string = os.homedir()): string[] {
  const want = new Set(roles);
  const out: string[] = [];
  const stop = path.resolve(home);
  for (let dir = path.resolve(cwd), prev = ""; dir !== prev && dir !== stop; prev = dir, dir = path.dirname(dir)) {
    for (const agents of [path.join(dir, ".pi", "agents"), path.join(dir, ".agents")]) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(agents).filter((n) => n.endsWith(".md"));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(agents, n);
        const name = agentName(file);
        if (want.has(name)) out.push(`${name}: ${file}`);
      }
    }
    const settings = path.join(dir, ".pi", "settings.json");
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(settings, "utf8").replace(/^﻿/, ""));
    } catch {
      continue;
    }
    const sub = isObj(raw) && isObj(raw.subagents) ? raw.subagents : {};
    const keys = new Set(Object.keys(isObj(sub.agentOverrides) ? sub.agentOverrides : {}));
    if (isObj(sub.agentOverridesByProvider)) for (const v of Object.values(sub.agentOverridesByProvider)) if (isObj(v)) for (const k of Object.keys(v)) keys.add(k);
    for (const k of keys) if (want.has(k)) out.push(`${k}: ${settings} (subagents agent override)`);
  }
  return out;
}

export const SHADOW_FIX = "delete or rename the project file; pi-foreman launches children with agentScope \"user\", so it is ignored, but a launch outside pi-foreman would use it.";
