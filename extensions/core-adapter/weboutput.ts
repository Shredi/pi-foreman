// The output files a curl or wget segment names, read from every option of the segment (also behind an auth option, which `webread.ts` stops at).
// A leaf module: `floors.ts` reads it, so it imports nothing but a type.
import type { ShellSegment } from "./shellast.ts";

export const CURL_VALUE_SHORT = new Set("AbcCdDeEFHKmoPQrTuUwxXyYz".split(""));
export const CURL_VALUE_LONG = new Set(["--output", "--output-dir", "--user-agent", "--max-time", "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--referer", "--range", "--write-out", "--proxy", "--header", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "--json", "--form", "--form-string", "--upload-file", "--request", "--user", "--cookie", "--cookie-jar", "--netrc-file", "--config", "--oauth2-bearer", "--proxy-user", "--aws-sigv4", "--cacert", "--cert", "--key", "--resolve", "--limit-rate", "--max-filesize", "--max-redirs", "--url", "--dump-header"]);
export const WGET_VALUE_SHORT = new Set(["O", "P", "o", "a", "i", "e", "t", "T", "w", "U", "Q", "l", "A", "R", "D", "I", "X", "B"]);
export const WGET_VALUE_LONG = new Set(["--output-document", "--directory-prefix", "--output-file", "--append-output", "--input-file", "--execute", "--tries", "--timeout", "--wait", "--user-agent", "--quota", "--level", "--accept", "--reject", "--header", "--method", "--post-data", "--post-file", "--body-data", "--body-file", "--user", "--password", "--http-user", "--http-password", "--ftp-user", "--ftp-password", "--load-cookies", "--save-cookies", "--referer", "--read-timeout", "--connect-timeout", "--dns-timeout", "--limit-rate", "--bind-address", "--config", "--use-askpass", "--certificate", "--private-key", "--ca-certificate", "--proxy-user", "--proxy-password"]);

/**
 * The words a `curl` or `wget` segment names as the file it writes: `-o`, `--output` (curl), `-O`, `--output-document` (wget), any spelling (`-o x`, `-ox`, a short
 * cluster `-sSo x`, `--output=x`). Empty for another program. Not the log, cookie or header files (`wget -o`, `curl -D`: the judge looks at those).
 */
export function webOutputWords(seg: ShellSegment): Set<string> {
  const out = new Set<string>();
  const prog = (seg.program.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  const curl = prog === "curl";
  if (!curl && prog !== "wget") return out;
  const shortValue = curl ? CURL_VALUE_SHORT : WGET_VALUE_SHORT;
  const longValue = curl ? CURL_VALUE_LONG : WGET_VALUE_LONG;
  const shortOut = curl ? "o" : "O";
  const longOut = curl ? "--output" : "--output-document";
  const a = seg.argv;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (w === "--") continue;
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq > 0 ? w.slice(0, eq) : w;
      const val = eq > 0 ? w.slice(eq + 1) : longValue.has(name) ? (a[++i] ?? "") : undefined;
      if (name === longOut && val !== undefined) out.add(val);
    } else if (w.startsWith("-") && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        if (!shortValue.has(w[j])) continue;
        const val = w.slice(j + 1) || (a[++i] ?? "");
        if (w[j] === shortOut) out.add(val);
        break;
      }
    }
  }
  return out;
}
