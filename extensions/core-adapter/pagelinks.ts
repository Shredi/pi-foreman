// The one place the session code asks for a served page URL (pageserver.ts pageUrlFor). `pageLinks.url` is a seam: the test preload
// (test/_hermetic-env.mjs) seeds it with a function that returns null, so no test starts a page server; a test of served links sets its own.
import { pageUrlFor } from "./pageserver.ts";

const seed = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-foreman.page-url-seed")];

export const pageLinks: { url: typeof pageUrlFor } = { url: typeof seed === "function" ? (seed as typeof pageUrlFor) : pageUrlFor };
