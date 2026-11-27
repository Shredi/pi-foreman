// `briefpage-cli.ts convert <page> --md <out> --html <out>` (run by scripts/foreman_session.py with `node --no-warnings --experimental-strip-types`):
// converts a brief page (briefpage.ts), writes the text copy and the rendered page, prints one JSON line `{ok, title, hidden}` or
// `{ok:false, code, message}`. Exit 0 on success, 1 otherwise.
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { convertBriefPage } from "./briefpage.ts";

const USAGE = "usage: briefpage-cli.ts convert <page> --md <out> --html <out>";

export async function main(argv: string[]): Promise<number> {
  const [cmd, page, ...rest] = argv;
  const opt = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const md = opt("--md");
  const html = opt("--html");
  if (cmd !== "convert" || !page || !md || !html) {
    console.log(JSON.stringify({ ok: false, code: "usage", message: USAGE }));
    return 1;
  }
  const r = await convertBriefPage(page);
  if ("error" in r) {
    console.log(JSON.stringify({ ok: false, code: r.error, message: r.message }));
    return 1;
  }
  try {
    fs.writeFileSync(md, r.markdown, "utf8");
    fs.writeFileSync(html, r.page, "utf8");
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: "brief_unreadable", message: `the converted files could not be written (${(e as NodeJS.ErrnoException).code ?? "error"})` }));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, title: r.title, hidden: r.hiddenTotal }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
