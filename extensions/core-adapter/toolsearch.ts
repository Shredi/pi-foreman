// The harness `tool_search` (token diet): one search surface for three kinds of candidates. Pi-searchable tools (inactive `codemode` and
// `deferred` tools, MCP tools) are activated as Pi's own search does; harness-hidden declarations (deferred.ts) print their schema and the
// codemode call; hidden skills print their <skill> entry. The ranking is a small BM25 written here, not imported from Pi, so a Pi
// internal change cannot break it.

export const TOOL_SEARCH_NAME = "tool_search";
export const DEFAULT_LIMIT = 8;

export interface ToolInfoLike {
  name: string;
  description: string;
  parameters?: unknown;
  exposure?: string;
  namespace?: { name: string; description?: string; instructions?: string };
}

export interface SearchableSkill {
  name: string;
  description: string;
  filePath: string;
}

export interface ToolSearchHost {
  getAllTools(): ToolInfoLike[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface ToolSearchDeps {
  host: ToolSearchHost;
  /** Names the harness leaves out of the declarations (deferred.ts). */
  hidden: () => readonly string[];
  /** Records names as un-hidden for the session (and persists them). */
  unhide: (names: string[]) => void;
  /** Hidden skills the caller can offer. */
  skills?: () => readonly SearchableSkill[];
  /** Called once per hit, for the trace. */
  found?: (hit: { name: string; kind: "tool" | "skill"; unhidden: boolean }) => void;
}

export const TOOL_SEARCH_DESCRIPTION = `# Tool and skill discovery\n\nSearches three kinds of things by BM25 over name, description and parameter names: tools that are not declared to you upfront (such as MCP tools) are loaded for your next call; deferred tools whose declarations the harness left out print their schema and the codemode call (or are declared from the next request when codemode is off); searchable skills print their entry, read its file to load it. Search before you say a tool or skill does not exist.`;

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with"]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

/** Lowercase terms split at camelCase boundaries and non-alphanumerics, without stop words. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function schemaText(schema: unknown, parts: string[]): void {
  if (!isObject(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

interface Doc {
  name: string;
  text: string;
}

function toolDoc(tool: ToolInfoLike): Doc {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  if (tool.namespace) parts.push(tool.namespace.name, tool.namespace.description ?? "", tool.namespace.instructions ?? "");
  return { name: tool.name, text: parts.filter((p) => p.trim()).join(" ") };
}

/** Okapi BM25 (k1 1.2, b 0.75); ties keep document order. */
export function rank(query: string, docs: readonly Doc[], limit: number): string[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || docs.length === 0 || limit <= 0) return [];
  const counts = docs.map((d) => {
    const m = new Map<string, number>();
    for (const term of tokenize(d.text)) m.set(term, (m.get(term) ?? 0) + 1);
    return m;
  });
  const lengths = counts.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const avg = lengths.reduce((a, b) => a + b, 0) / docs.length || 1;
  const idf = new Map(queryTerms.map((term) => {
    const freq = counts.filter((m) => m.has(term)).length;
    return [term, Math.log(1 + (docs.length - freq + 0.5) / (freq + 0.5))] as const;
  }));
  const scored: { name: string; score: number }[] = [];
  docs.forEach((d, i) => {
    let score = 0;
    for (const term of queryTerms) {
      const count = counts[i].get(term);
      if (!count) continue;
      const norm = 1.2 * (1 - 0.75 + (0.75 * lengths[i]) / avg);
      score += (idf.get(term) ?? 0) * ((count * 2.2) / (count + norm));
    }
    if (score > 0) scored.push({ name: d.name, score });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((m) => m.name);
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0];

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** `tools.<name>({ required: <type> })`, the call shape for a codemode script. */
function codemodeCall(tool: ToolInfoLike): string {
  const params = isObject(tool.parameters) ? tool.parameters : {};
  const props = isObject(params.properties) ? params.properties : {};
  const required = Array.isArray(params.required) ? params.required.filter((r): r is string => typeof r === "string") : [];
  const args = required.map((key) => {
    const type = isObject(props[key]) && typeof (props[key] as { type?: unknown }).type === "string" ? String((props[key] as { type: string }).type) : "value";
    return `${key}: <${type}>`;
  });
  return `tools.${tool.name}({${args.length ? ` ${args.join(", ")} ` : ""}})`;
}

/** The tool definition for `pi.registerTool`. */
export function createToolSearchTool(deps: ToolSearchDeps) {
  return {
    name: TOOL_SEARCH_NAME,
    label: TOOL_SEARCH_NAME,
    description: TOOL_SEARCH_DESCRIPTION,
    promptSnippet: "Search for tools and skills that are not declared upfront",
    parameters: { type: "object", properties: { query: { type: "string", description: "Search query for tools and skills." }, limit: { type: "number", description: `Maximum number of results. Defaults to ${DEFAULT_LIMIT}.` } }, required: ["query"], additionalProperties: false } as never,
    // Searching is not something scripts need; it changes what the model sees.
    exposure: "model-only" as const,
    reachesTools: () => "all" as const,
    prepareLoadout(loadout: { declared: readonly { name: string }[] }) {
      const declared = new Set(loadout.declared.map((t) => t.name));
      const hiddenDeclarations = deps.hidden().filter((n) => declared.has(n));
      return hiddenDeclarations.length ? { hiddenDeclarations } : undefined;
    },
    async execute(_id: string, params: { query?: string; limit?: number }) {
      const query = params.query ?? "";
      if (query.trim() === "") throw new Error("query must not be empty");
      const max = params.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
      const { host } = deps;
      const active = host.getActiveTools();
      const all = host.getAllTools();
      const hidden = new Set(deps.hidden());
      const piTools = all.filter((t) => (t.exposure === "codemode" || t.exposure === "deferred") && !active.includes(t.name) && !hidden.has(t.name));
      const hiddenTools = all.filter((t) => hidden.has(t.name) && active.includes(t.name));
      const skills = deps.skills?.() ?? [];
      const docs: Doc[] = [...piTools.map(toolDoc), ...hiddenTools.map(toolDoc), ...skills.map((s) => ({ name: `skill:${s.name}`, text: `${s.name} ${s.name.replaceAll("-", " ")} ${s.description}` }))];
      const names = rank(query, docs, max);
      const hitPi = piTools.filter((t) => names.includes(t.name)).sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
      const hitHidden = hiddenTools.filter((t) => names.includes(t.name)).sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
      const hitSkills = skills.filter((s) => names.includes(`skill:${s.name}`)).sort((a, b) => names.indexOf(`skill:${a.name}`) - names.indexOf(`skill:${b.name}`));
      if (hitPi.length + hitHidden.length + hitSkills.length === 0) return { content: [{ type: "text" as const, text: "No matching tools found." }], details: { loaded: [] } };

      const blocks: string[] = [];
      if (hitPi.length) {
        host.setActiveTools([...active, ...hitPi.map((t) => t.name)]);
        blocks.push(`Loaded ${hitPi.length} tool${hitPi.length === 1 ? "" : "s"}. They are available from your next call:\n${hitPi.map((t) => `- ${t.name}: ${firstLine(t.description)}`).join("\n")}`);
        for (const t of hitPi) deps.found?.({ name: t.name, kind: "tool", unhidden: false });
      }
      let unhidden = false;
      let unhiddenName = "";
      if (hitHidden.length) {
        const withCodemode = active.includes("codemode");
        if (withCodemode) {
          blocks.push(`Deferred tools, callable now from a codemode script (the declarations are unchanged):\n${hitHidden.map((t) => `- ${t.name}: ${firstLine(t.description)}\n  schema: ${JSON.stringify(t.parameters ?? {})}\n  call: ${codemodeCall(t)}`).join("\n")}`);
        } else {
          // Each un-hide re-projects the whole transcript (cold cache): only the exact-name match, else the single best hit.
          const exact = hitHidden.find((t) => t.name === query.trim());
          const one = exact ?? hitHidden[0];
          deps.unhide([one.name]);
          host.setActiveTools(host.getActiveTools());
          unhidden = true;
          unhiddenName = one.name;
          const others = hitHidden.filter((t) => t !== one);
          blocks.push(`Loaded deferred tool ${one.name}. It is declared from the next request:\n- ${one.name}: ${firstLine(one.description)}${others.length ? `\nOther matches, search by exact name to load one: ${others.map((t) => t.name).join(", ")}` : ""}`);
        }
        for (const t of hitHidden) deps.found?.({ name: t.name, kind: "tool", unhidden: unhidden && t.name === unhiddenName });
      }
      if (hitSkills.length) {
        blocks.push(`Searchable skills (read the file to load one):\n${hitSkills.map((s) => `<skill>\n  <name>${escapeXml(s.name)}</name>\n  <description>${escapeXml(s.description)}</description>\n  <location>${escapeXml(s.filePath)}</location>\n</skill>`).join("\n")}`);
        for (const s of hitSkills) deps.found?.({ name: s.name, kind: "skill", unhidden: false });
      }
      return { content: [{ type: "text" as const, text: blocks.join("\n\n") }], details: { loaded: [...hitPi, ...hitHidden.filter((t) => !unhidden || t.name === unhiddenName)].map((t) => t.name), skills: hitSkills.map((s) => s.name), unhidden } };
    },
  };
}
