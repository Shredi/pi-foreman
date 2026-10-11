// Fixture overlay: the docs/overlays.md "Handshake" snippet as a real extension factory.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_e, ctx) => {
    const core = (globalThis as any)[Symbol.for("pi-foreman.core.v1")];
    if (!core) {
      ctx.ui.notify("pi-foreman core adapter not loaded; install it with pi install git:github.com/Shredi/pi-foreman", "warning");
      return;
    }
    // core.api === 1; core.version and core.pkgRoot are available
  });
}
