// `foreman dialogs <trace>` (bin/foreman, .cmd, .ps1): prints dialogsJson of a trace file, the text `/foreman dialogs --json` and the `foreman_dialogs` tool give.
import { dialogsJson } from "./dialogs.ts";

const file = process.argv[2];
if (!file || process.argv.length > 3) {
  process.stderr.write("usage: foreman dialogs <trace-file>\n");
  process.exit(2);
}
process.stdout.write(`${dialogsJson({ file })}\n`);
