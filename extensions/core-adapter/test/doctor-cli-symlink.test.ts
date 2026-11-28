// doctor-cli.ts must run when reached through a symlinked path (entry guard compares real paths).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../mainmodule.ts";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const made: string[] = [];
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mainmod-")));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function link(target: string, at: string): true | string {
  try {
    fs.symlinkSync(target, at, "junction");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return "cannot create a symlink (EPERM)";
    throw e;
  }
}

test("isMainModule: same path, other file, undefined", () => {
  const d = tmp();
  const a = path.join(d, "a.ts");
  const b = path.join(d, "b.ts");
  fs.writeFileSync(a, "");
  fs.writeFileSync(b, "");
  assert.equal(isMainModule(pathToFileURL(a).href, a), true);
  assert.equal(isMainModule(pathToFileURL(a).href, b), false);
  assert.equal(isMainModule(pathToFileURL(a).href, undefined), false);
});

test("isMainModule: symlinked directory in the path", (t) => {
  const d = tmp();
  const dir = path.join(d, "real");
  fs.mkdirSync(dir);
  const f = path.join(dir, "m.ts");
  fs.writeFileSync(f, "");
  const l = path.join(d, "link");
  const r = link(dir, l);
  if (r !== true) return t.skip(r);
  assert.equal(isMainModule(pathToFileURL(f).href, path.join(l, "m.ts")), true);
});

test("doctor-cli.ts --help prints usage when run through a symlinked directory", (t) => {
  const d = tmp();
  const l = path.join(d, "ext");
  const r = link(EXT, l);
  if (r !== true) return t.skip(r);
  const res = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", path.join(l, "core-adapter", "doctor-cli.ts"), "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /usage/i);
});
