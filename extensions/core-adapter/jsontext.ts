// Some provider paths send the undeclared launch fields (size, risk, mcp, reads, install) as JSON text instead of native values.
// One shared strict parse: a string that is JSON of exactly the wanted type gives the parsed value; anything else comes back untouched
// so the caller's own check refuses it with its usual text. One decode only; text with leading or trailing whitespace is not parsed (whitespace inside the JSON is fine).
export type JsonTextWant = "object" | "array" | "number" | "boolean";

export function fromJsonText(value: unknown, want: JsonTextWant): unknown {
  if (typeof value !== "string" || value !== value.trim()) return value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  const ok =
    want === "array" ? Array.isArray(parsed)
    : want === "object" ? !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
    : typeof parsed === want;
  return ok ? parsed : value;
}
