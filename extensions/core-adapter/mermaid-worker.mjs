// Render worker of mermaid.ts: plain JS (no type stripping relied on). It loads the optional `beautiful-mermaid` package, reports
// `{ready}` once, then answers one `{id, src, bg, fg}` message at a time with `{id, svg}` or `{id, error}`. The parent terminates it
// on a timeout, so a layout that never ends costs one worker, not the session.
import { parentPort } from "node:worker_threads";

let mod = null;
try {
  mod = await import("beautiful-mermaid");
} catch {
  // the module is optional: the parent falls back to code blocks
}
parentPort.postMessage({ ready: !!mod && typeof mod.renderMermaid === "function" });

parentPort.on("message", async (m) => {
  try {
    const svg = await mod.renderMermaid(m.src, { bg: m.bg, fg: m.fg });
    parentPort.postMessage({ id: m.id, svg });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String(e && e.message ? e.message : e).slice(0, 200) });
  }
});
