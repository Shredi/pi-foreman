// Test helper: read the trace files (`trace-<id>.jsonl`) under a dir. Other files in the agent/state dir (the pressure
// sampler's `pressure.json.<rand>.tmp`) are not read, and a file that vanishes between readdir and read is skipped.
import fs from "node:fs";
import path from "node:path";

export interface WalkFs {
  readdir: (d: string) => fs.Dirent[];
  read: (p: string) => string;
}

const realFs: WalkFs = { readdir: (d) => fs.readdirSync(d, { withFileTypes: true }), read: (p) => fs.readFileSync(p, "utf8") };

const isGone = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export function readTraceFiles(root: string, io: WalkFs = realFs): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = io.readdir(d);
    } catch (e) {
      if (isGone(e)) return;
      throw e;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("trace-") && e.name.endsWith(".jsonl")) {
        try {
          out.push(io.read(p));
        } catch (err) {
          if (!isGone(err)) throw err;
        }
      }
    }
  };
  walk(root);
  return out;
}
