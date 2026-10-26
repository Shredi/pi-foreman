// Runs setup.mjs's picker dispatch with a terminal and an import that fails; stdin is a pipe, so the readline menu answers.
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { runPicker } = await import(path.join(root, "setup.mjs"));
const ctx = { currentText: null, currentConfig: {}, recorded: null, installed: [], project: false };
const r = await runPicker(ctx, {
  tty: true,
  load: async () => {
    throw new Error("Cannot find package '@inquirer/prompts'");
  },
});
console.log(`RESULT ${JSON.stringify(r)}`);
