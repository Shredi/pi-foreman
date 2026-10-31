// Preload for test:node (node --import): a session opened by `foreman session open` carries the parent env; the tests set their own.
// The names come from session-env.json, the list tests/_isolation.py and _r46world.ts share.
import * as fs from "node:fs";

const { keys, prefixes } = JSON.parse(fs.readFileSync(new URL("./session-env.json", import.meta.url), "utf8"));
for (const k of keys) delete process.env[k];
// A runner inside a Herdr pane must not hand its pane to the adapters under test: their presence files would name it.
for (const k of Object.keys(process.env)) if (prefixes.some((p) => k.startsWith(p))) delete process.env[k];
