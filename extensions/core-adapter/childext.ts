// Register required child extensions with pi-subagents (design §5 layer 5).
//
// Real API (pi-subagents 0.75.0, export "./required-child-extensions"):
//   registerRequiredChildExtensions({sessionId, extensions: [{id, path}], requireForAllRunners})
//     -> {dispose()}
// It stores into a process-global, versioned registry
//   globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")] = {version: 1, bySession: Map}
// pi-foreman is a separate package, so the bare import only resolves when pi-subagents is
// resolvable from here; otherwise the same registry is written directly with the same rules.
import * as fs from "node:fs";
import * as path from "node:path";

export interface ChildExtension {
  id: string;
  path: string;
}

export interface Registration {
  dispose(): void;
}

type RegisterFn = (input: { sessionId: string; extensions: ChildExtension[]; requireForAllRunners?: boolean }) => Registration;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");

/** Normalise config entries: `{id, path}` objects or plain path strings (id from the file name). */
export function normaliseChildExtensions(entries: unknown, baseDir: string): { list: ChildExtension[]; errors: string[] } {
  const list: ChildExtension[] = [];
  const errors: string[] = [];
  if (!Array.isArray(entries)) return { list, errors };
  for (const [i, e] of entries.entries()) {
    let id: unknown;
    let p: unknown;
    if (typeof e === "string") {
      p = e;
      id = path.basename(e).replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
    } else if (e && typeof e === "object") {
      id = (e as Record<string, unknown>).id;
      p = (e as Record<string, unknown>).path;
    }
    if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof p !== "string" || !p) {
      errors.push(`safety.requiredChildExtensions[${i}] needs an id and a path`);
      continue;
    }
    list.push({ id, path: path.resolve(baseDir, p) });
  }
  return { list, errors };
}

/** Fallback with the same validation as pi-subagents' registerRequiredChildExtensions. */
export const registerViaGlobalRegistry: RegisterFn = (input) => {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const entries = input.extensions.map((e) => {
    if (!ID_PATTERN.test(e.id)) throw new Error(`Required child extension id '${e.id}' is not safe.`);
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(e.path));
      if (!fs.statSync(real).isFile()) throw new Error("not a file");
    } catch (err) {
      throw new Error(`Required child extension '${e.id}' is not an importable file: ${(err as Error).message}`);
    }
    if (ids.has(e.id)) throw new Error(`Required child extension id '${e.id}' is duplicated.`);
    if (paths.has(real)) throw new Error(`Required child extension path '${real}' is duplicated.`);
    ids.add(e.id);
    paths.add(real);
    return Object.freeze(input.requireForAllRunners ? { id: e.id, path: real, requireForAllRunners: true as const } : { id: e.id, path: real });
  });
  const root = globalThis as unknown as Record<symbol, unknown>;
  let store = root[REGISTRY_KEY] as { version: number; bySession: Map<string, unknown> } | undefined;
  if (store === undefined) {
    store = { version: 1, bySession: new Map() };
    root[REGISTRY_KEY] = store;
  }
  if (!store || store.version !== 1 || !(store.bySession instanceof Map)) throw new Error("Malformed or unsupported required child extension registry.");
  if (store.bySession.has(input.sessionId)) throw new Error(`Required child extensions are already registered for session '${input.sessionId}'; dispose them first.`);
  const frozen = Object.freeze(entries);
  const map = store.bySession;
  map.set(input.sessionId, frozen);
  return {
    dispose() {
      if (map.get(input.sessionId) === frozen) map.delete(input.sessionId);
    },
  };
};

/** Doctor wording for the active registration path (R3). */
export function registrationPathLabel(via: string | undefined): string {
  if (via === "pi-subagents") return "package import (pi-subagents/required-child-extensions)";
  if (via === "global registry v1") return "global-symbol registry (Symbol.for(\"pi-subagents.required-child-extensions.v1\"))";
  return "none";
}

export async function loadRegister(): Promise<{ fn: RegisterFn; via: string }> {
  try {
    const mod = (await import("pi-subagents/required-child-extensions")) as { registerRequiredChildExtensions?: RegisterFn };
    if (typeof mod.registerRequiredChildExtensions === "function") return { fn: mod.registerRequiredChildExtensions, via: "pi-subagents" };
  } catch {
    // not resolvable from this package
  }
  return { fn: registerViaGlobalRegistry, via: "global registry v1" };
}
