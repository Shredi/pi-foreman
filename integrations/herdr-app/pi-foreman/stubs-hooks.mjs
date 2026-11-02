// Module hooks: the host modules main.js imports resolve to stubs.mjs.
const HOST = new Set(["gpui-kit", "gpui-base", "herdr"]);
export async function resolve(specifier, context, next) {
  if (HOST.has(specifier)) return { url: new URL("./stubs.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
