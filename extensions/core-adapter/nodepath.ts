// The Node that runs Pi, recorded for `bin/foreman` (GUI apps start commands with a PATH that has no nvm node).
// `<agentDir>/pi-foreman/state/node-path` holds one line, process.execPath; bin/foreman puts its directory on PATH when `node` is missing.
import * as fs from "node:fs";
import * as path from "node:path";

export const nodePathFile = (agentDir: string): string => path.join(agentDir, "pi-foreman", "state", "node-path");

/** Write execPath to the record when it differs (temp file + rename). Returns true when written; never throws. */
export function recordNodePath(agentDir: string, execPath: string = process.execPath): boolean {
  try {
    const file = nodePathFile(agentDir);
    const body = `${execPath}\n`;
    try {
      if (fs.readFileSync(file, "utf8") === body) return false;
    } catch {
      // missing or unreadable: write it
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
