// One rule for every site that takes an allowlisted tool out of a request: a child never does.
// pi-subagents 0.89 (src/runs/shared/subagent-prompt-runtime.js) aborts a child before its first model call when a tool its role
// allowlists is registered but missing from the request, and every `tools` entry of a role is required. `/foreman setup` puts
// `tool_search`, the searchable tools and the git and PR packs in the child allowlists, so a child that hides any of them aborts.
// The main session keeps its hiding (deferred tools, the pack switch). Sites: the deferred and searchable hiding (index.ts initDeferred),
// the `tool_search` switch-off of a child with nothing to search (mcpchild.ts) and the pack removal (gitpack.ts applyGitPack, applyPrPack).

/** True when a session may take a tool out of its request: the main session only. */
export const hidesDeclaredTools = (isChild: boolean): boolean => !isChild;
