// R46 text for a child's npm install ask, kept in the gate's ask reason (the overlay that produced it no longer sees gate-decided calls).

const NPM_UNIT = /(?:^|[;&|(]\s*)npm\s+(ci|install|i|add)\b/;

/** The sentence a child gets with an ask for `npm ci` / `npm install`; "" for any other command. `install` = the launch set `install: true`. */
export function childNpmNote(command: string, install: boolean): string {
  const m = NPM_UNIT.exec(command);
  if (!m) return "";
  const verb = m[1] === "ci" ? "ci" : m[1] === "add" ? "add" : "install";
  const ci = verb === "ci" ? (install
    ? " Your launch allows it, so a bare `npm ci` in your worktree (no pipe, chain or background) goes to the parent's approval dialog; it does not run unasked."
    : " Use a bare `npm ci` in your worktree (no pipe, chain or background) or ask the foreman.") : "";
  const flag = install ? "" : " The foreman can relaunch you with the launch flag `install: true`, which lets the parent's approval dialog approve it in your worktree.";
  return `npm ${verb} needs approval for a child (it writes the project or the network; the foreman may run it).${ci}${flag}`;
}
