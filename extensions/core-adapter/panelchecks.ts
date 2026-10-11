// Failed-checks line of the review panel block: gated by the git-config drift preflight (a block
// means no line and no host call) and cached per (HEAD sha, turn) so the host is called at most
// once per HEAD per turn. Any failure adds nothing.
export interface PanelChecksDeps {
  /** PR pack on and not a child. */
  enabled(): boolean;
  /** Drift preflight verdict; a block means the line is omitted. */
  preflight(): Promise<{ block: true; reason: string } | undefined>;
  head(): Promise<string | null>;
  turn(): number;
  /** One pr_checks host call; "" when it did not run or nothing failed. */
  fetch(): Promise<string>;
}

export interface PanelChecksCache {
  key: string;
  line: Promise<string>;
}

export async function panelChecksLine(deps: PanelChecksDeps, cache: { current: PanelChecksCache | null }): Promise<string> {
  try {
    if (!deps.enabled()) return "";
    if (await deps.preflight()) return "";
    const key = `${deps.turn()}:${(await deps.head()) ?? ""}`;
    if (cache.current?.key !== key) cache.current = { key, line: deps.fetch().catch(() => "") };
    return await cache.current.line;
  } catch {
    return "";
  }
}
