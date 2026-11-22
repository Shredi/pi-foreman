// String form of a value of unknown type; null and undefined give "". One place for the
// stringification of parsed JSON fields, so call sites do not repeat `String(x ?? "")`.
export const strOf = (v: unknown): string =>
  // oxlint-disable-next-line typescript/no-base-to-string -- deliberate: callers pass parsed JSON fields and want String() semantics
  v === undefined || v === null ? "" : String(v);

// Plain String() of a value of unknown type, for fields where null and undefined should print as such.
export const strRaw = (v: unknown): string =>
  // oxlint-disable-next-line typescript/no-base-to-string -- deliberate, as strOf
  String(v);
