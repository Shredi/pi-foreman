// R5 P2 S2 (ledger 11, R2): a child's heredoc and stdin-script file writes are denied without a dialog; plain reads and null-redirects are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildOverlayRules, checkToolCall, readBaseline } from "../permoverlay.ts";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const baseline = readBaseline(pkgRoot)!;
const posix = process.platform !== "win32";
const r = buildOverlayRules(baseline, {}, {}, "/nonexistent/agent", pkgRoot, undefined, false);
const child = (command: string) => checkToolCall(r, "bash", { command }, { cwd: pkgRoot, home: "/nonexistent", platform: process.platform, role: "child" });

test("heredoc and stdin-script writes are denied for a child with the reason", { skip: !posix }, () => {
  for (const cmd of ["cat > x.txt <<'EOF'\nhi\nEOF", "cat >> x.txt <<EOF\nhi\nEOF", "tee x.txt <<EOF\nhi\nEOF", "python3 - <<'EOF'\nopen('x','w').write('1')\nEOF", "python3 - <<'EOF'\nfrom pathlib import Path\nPath('x').write_text('1')\nEOF", "node -e \"require('fs').writeFileSync('x','1')\""]) {
    const d = child(cmd);
    assert.equal(d?.kind, "deny", cmd);
    assert.ok(d!.reason.includes("never heredoc or stdin-script file writes"), d!.reason);
  }
});

test("reading heredocs and null redirects are not this deny", { skip: !posix }, () => {
  for (const cmd of ["cat <<'EOF' | grep a\nabc\nEOF", "python3 - <<'EOF'\nprint(open('package.json').read())\nEOF", "cat package.json >/dev/null 2>&1"]) {
    const d = child(cmd);
    assert.ok(!d || !d.reason.includes("never heredoc or stdin-script file writes"), cmd);
  }
});
